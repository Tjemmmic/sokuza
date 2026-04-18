import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Cross-platform service installer. The goal is a low-drama autostart:
 * user runs `sokuza service enable` once, and the engine comes back up
 * after reboot without the user having to remember anything.
 *
 * Each platform writes a *user-scoped* unit (no admin/sudo required):
 *   - Linux:  ~/.config/systemd/user/sokuza.service
 *   - macOS:  ~/Library/LaunchAgents/ai.sokuza.plist
 *   - Windows: Startup-folder .cmd shim (simplest no-admin option)
 *
 * Everything the unit needs is baked in at install time:
 *   - the node binary currently running sokuza (process.execPath)
 *   - the absolute path of the installed CLI entry (process.argv[1])
 *   - the config file + its directory (captured from CLI args / cwd)
 *   - the user's current PATH (with required system dirs appended)
 *
 * Capturing absolute paths and the full PATH at install time makes the
 * service immune to the minimised environment systemd and launchd hand to
 * user services — a workflow that shells out to `gh` or `claude` finds them
 * on exactly the PATH the user had when they ran `service enable`.
 */

const SERVICE_LABEL = 'ai.sokuza';
const LINUX_UNIT_NAME = 'sokuza.service';

/** System dirs we always want present regardless of user shell quirks. */
const UNIX_REQUIRED_PATH_DIRS = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
];

/**
 * Snapshot the PATH that will be injected into the generated service unit.
 * Unix: the user's current PATH with required system dirs appended if
 * missing. Windows: returns the current PATH untouched — Startup-folder
 * shims inherit the user's logon environment directly.
 */
export function captureServicePath(env: NodeJS.ProcessEnv = process.env): string {
    const sep = process.platform === 'win32' ? ';' : ':';
    const current = env.PATH ?? '';
    if (process.platform === 'win32') return current;

    const parts = current.split(sep).filter(Boolean);
    const seen = new Set(parts);
    for (const dir of UNIX_REQUIRED_PATH_DIRS) {
        if (!seen.has(dir)) { parts.push(dir); seen.add(dir); }
    }
    return parts.join(sep);
}

export interface ServiceOptions {
    /** Absolute path to the config file that autostart should use. */
    configPath: string;
}

/**
 * Reject install attempts when the CLI is running from a TypeScript source
 * file or a dev-runtime loader (tsx, ts-node, vite-node). The resulting
 * service unit would otherwise bake a path the system `node` can't
 * actually execute — the service would fail silently at login with a
 * SyntaxError in the logs.
 *
 * Exported for tests.
 */
export function assertEntryIsExecutableByService(entry: string): void {
    const lower = entry.toLowerCase();
    if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
        throw new Error(
            `service enable refuses to register a TypeScript entry (${entry}). ` +
            `Run \`sokuza service enable\` from the built binary — typically the ` +
            `globally-installed \`sokuza\` on your PATH — not from \`tsx\` or \`npm run dev\`. ` +
            `If you need an autostart for a development checkout, build first with ` +
            `\`npm run build\` and run the resulting \`dist/index.js\` directly.`,
        );
    }
    // tsx/ts-node register a CLI wrapper as argv[1] in some configurations.
    // Those wrappers are inside node_modules and shouldn't be baked into a
    // long-lived service unit.
    const segs = entry.split(/[/\\]/);
    if (segs.includes('tsx') || segs.includes('ts-node') || segs.includes('vite-node')) {
        throw new Error(
            `service enable refuses to register a dev-runtime entry (${entry}). ` +
            `Install sokuza globally with \`npm install -g sokuza\` and run ` +
            `\`sokuza service enable\` from there instead.`,
        );
    }
}

export interface ServiceResult {
    platform: NodeJS.Platform;
    unitPath: string;
    followUp: string[];
}

export async function installService(opts: ServiceOptions): Promise<ServiceResult> {
    const configPath = resolve(opts.configPath);
    if (!existsSync(configPath)) {
        throw new Error(
            `Config file not found at ${configPath}. ` +
            `Create one with \`sokuza init\` first.`,
        );
    }

    const nodeBin = process.execPath;
    const entry = resolve(process.argv[1]);
    assertEntryIsExecutableByService(entry);
    const workdir = dirname(configPath);
    const servicePath = captureServicePath();

    const ctx: InstallCtx = { configPath, nodeBin, entry, workdir, servicePath };
    const plat = platform();
    if (plat === 'linux') return installLinux(ctx);
    if (plat === 'darwin') return installMacOS(ctx);
    if (plat === 'win32') return installWindows(ctx);
    throw new Error(`Unsupported platform for service install: ${plat}`);
}

export async function uninstallService(): Promise<ServiceResult> {
    const plat = platform();
    if (plat === 'linux') return uninstallLinux();
    if (plat === 'darwin') return uninstallMacOS();
    if (plat === 'win32') return uninstallWindows();
    throw new Error(`Unsupported platform for service uninstall: ${plat}`);
}

export interface ServiceStatus {
    platform: NodeJS.Platform;
    /** Label for the underlying mechanism: "systemd --user", "launchd", "Task Scheduler". */
    mechanism: string;
    /** Did we find the unit/plist/task this sokuza would have installed? */
    installed: boolean;
    /** Will it auto-start at login/boot? */
    enabled: boolean;
    /** Is it currently running right now? */
    active: boolean;
    /** Absolute path to the unit/plist/task XML file (even if not installed — useful for guidance). */
    unitPath: string;
    /** Extra diagnostic lines to surface to the user. */
    notes: string[];
}

/**
 * Query the platform-specific service manager about sokuza's autostart state.
 * Every OS path answers the same three questions — installed, enabled,
 * active — so the CLI formatter can render a consistent report.
 */
export async function serviceStatus(): Promise<ServiceStatus> {
    const plat = platform();
    if (plat === 'linux') return statusLinux();
    if (plat === 'darwin') return statusMacOS();
    if (plat === 'win32') return statusWindows();
    throw new Error(`Unsupported platform for service status: ${plat}`);
}

function statusLinux(): ServiceStatus {
    const unitPath = join(homedir(), '.config', 'systemd', 'user', LINUX_UNIT_NAME);
    const notes: string[] = [];
    const installed = existsSync(unitPath);

    let enabled = false;
    let active = false;

    if (!commandExists('systemctl')) {
        notes.push('systemctl not found on PATH — cannot query service state.');
        return {
            platform: 'linux',
            mechanism: 'systemd --user',
            installed,
            enabled,
            active,
            unitPath,
            notes,
        };
    }

    // `is-enabled` and `is-active` print a single status word on stdout and
    // use the exit code to disambiguate (0 = enabled/active). The stdout
    // value is the clearest signal, so we use it directly.
    const enabledOut = run('systemctl', ['--user', 'is-enabled', LINUX_UNIT_NAME]).stdout.trim();
    const activeOut = run('systemctl', ['--user', 'is-active', LINUX_UNIT_NAME]).stdout.trim();
    enabled = enabledOut === 'enabled' || enabledOut === 'enabled-runtime' || enabledOut === 'static';
    active = activeOut === 'active';

    return {
        platform: 'linux',
        mechanism: 'systemd --user',
        installed,
        enabled,
        active,
        unitPath,
        notes,
    };
}

function statusMacOS(): ServiceStatus {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const notes: string[] = [];
    const installed = existsSync(plistPath);

    const uid = userInfo().uid;

    // `launchctl print <domain>/<label>` exits 0 when the service is loaded
    // in that domain, non-zero otherwise. We check both gui and user because
    // installService tries gui first with user as a headless fallback.
    const gui = run('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
    const usr = run('launchctl', ['print', `user/${uid}/${SERVICE_LABEL}`]);
    const loadedOutput = gui.status === 0 ? gui.stdout : usr.status === 0 ? usr.stdout : '';
    const loaded = loadedOutput !== '';

    // On launchd, "loaded" ≈ enabled. "Active" is trickier: the plist sets
    // KeepAlive=true, so if it's loaded it's effectively meant to be running.
    // `state = running` in the print output is the authoritative signal.
    const active = /state\s*=\s*running/i.test(loadedOutput);

    return {
        platform: 'darwin',
        mechanism: 'launchd (user agent)',
        installed,
        enabled: loaded,
        active,
        unitPath: plistPath,
        notes,
    };
}

function statusWindows(): ServiceStatus {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const taskXmlPath = join(localAppData, 'Sokuza', 'task.xml');
    const notes: string[] = [];
    const installed = existsSync(taskXmlPath);

    // `schtasks /Query /TN Sokuza /FO LIST /V` prints verbose key:value pairs
    // including "Status:" and "Scheduled Task State:". Parse both to derive
    // enabled/active. A non-zero exit means the task isn't registered.
    const q = run('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V']);
    if (q.status !== 0) {
        return {
            platform: 'win32',
            mechanism: 'Task Scheduler',
            installed,
            enabled: false,
            active: false,
            unitPath: taskXmlPath,
            notes,
        };
    }

    const state = extractField(q.stdout, 'Scheduled Task State');
    const status = extractField(q.stdout, 'Status');
    const enabled = state.toLowerCase() === 'enabled';
    const active = status.toLowerCase() === 'running';

    return {
        platform: 'win32',
        mechanism: 'Task Scheduler',
        installed,
        enabled,
        active,
        unitPath: taskXmlPath,
        notes,
    };
}

/**
 * Pull a single `Name: Value` field out of `schtasks /FO LIST /V` output.
 * Exported for test access.
 */
export function extractField(listOutput: string, name: string): string {
    const lineRegex = new RegExp(`^\\s*${escapeRegex(name)}\\s*:\\s*(.*)$`, 'im');
    const m = lineRegex.exec(listOutput);
    return m ? m[1].trim() : '';
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Linux (systemd --user) ─────────────────────────────────────────────────

export interface InstallCtx {
    configPath: string;
    nodeBin: string;
    entry: string;
    workdir: string;
    /** PATH to bake into the service unit. Captured from the install shell. */
    servicePath: string;
}

/**
 * Generate the systemd user-unit body for the given install context.
 * Separated from the filesystem side-effects so it can be tested directly
 * and so callers can preview the unit before we write it.
 *
 * PATH is baked into the unit with `Environment=` because systemd's user
 * manager hands a minimal PATH to services by default — `PassEnvironment`
 * alone only forwards vars that are *already set* in the manager's env,
 * which typically doesn't include NVM/mise/asdf shim directories.
 */
export function renderLinuxUnit(ctx: InstallCtx): string {
    return `[Unit]
Description=Sokuza — AI workflow automation engine
Documentation=https://sokuza.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${shellQuote(ctx.nodeBin)} ${shellQuote(ctx.entry)} start --config ${shellQuote(ctx.configPath)}
WorkingDirectory=${ctx.workdir}
Restart=on-failure
RestartSec=5
Environment="PATH=${ctx.servicePath}"
# Forward XDG vars the user's shell has already configured (paths like
# ~/.config, ~/.local/share); systemd's manager inherits HOME itself.
PassEnvironment=XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR

[Install]
WantedBy=default.target
`;
}

async function installLinux(ctx: InstallCtx): Promise<ServiceResult> {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    const unitPath = join(dir, LINUX_UNIT_NAME);

    const unit = renderLinuxUnit(ctx);

    await mkdir(dir, { recursive: true });
    await writeFile(unitPath, unit, 'utf-8');

    const followUp: string[] = [];
    if (commandExists('systemctl')) {
        run('systemctl', ['--user', 'daemon-reload']);
        const enable = run('systemctl', ['--user', 'enable', '--now', LINUX_UNIT_NAME]);
        if (enable.status !== 0) {
            followUp.push(
                `Service file installed but \`systemctl --user enable --now ${LINUX_UNIT_NAME}\` failed. ` +
                `Re-run it manually once any error is resolved.`,
            );
        } else {
            followUp.push(
                `Sokuza will auto-start at login. To survive full logouts, run once: ` +
                `sudo loginctl enable-linger ${userInfo().username}`,
            );
        }
    } else {
        followUp.push(
            `systemctl not found — the unit file was written to ${unitPath} but could not be enabled. ` +
            `Install systemd tooling or run another init (runit/OpenRC) equivalent manually.`,
        );
    }
    followUp.push(
        `PATH was baked into the unit. If you later install tools in a new ` +
        `directory (e.g. NVM, mise) and workflows can't find them, re-run ` +
        `\`sokuza service enable\` to refresh it.`,
    );

    return { platform: 'linux', unitPath, followUp };
}

async function uninstallLinux(): Promise<ServiceResult> {
    const unitPath = join(homedir(), '.config', 'systemd', 'user', LINUX_UNIT_NAME);
    const followUp: string[] = [];

    if (commandExists('systemctl')) {
        run('systemctl', ['--user', 'disable', '--now', LINUX_UNIT_NAME]);
    }
    if (existsSync(unitPath)) {
        await rm(unitPath);
        followUp.push(`Removed ${unitPath}`);
    } else {
        followUp.push(`No unit file at ${unitPath} — already uninstalled.`);
    }
    if (commandExists('systemctl')) {
        run('systemctl', ['--user', 'daemon-reload']);
    }

    return { platform: 'linux', unitPath, followUp };
}

// ─── macOS (launchd user agent) ─────────────────────────────────────────────

/**
 * Generate the launchd plist body for the given install context and log
 * paths. Separated from filesystem side-effects for testability.
 *
 * PATH uses `ctx.servicePath` — the user's shell PATH snapshot — because
 * launchd hands agents a minimal PATH by default, which doesn't include
 * NVM/mise/asdf shim dirs or custom user bin directories.
 */
export function renderMacOSPlist(ctx: InstallCtx, logDir: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(ctx.nodeBin)}</string>
        <string>${xmlEscape(ctx.entry)}</string>
        <string>start</string>
        <string>--config</string>
        <string>${xmlEscape(ctx.configPath)}</string>
    </array>
    <key>WorkingDirectory</key><string>${xmlEscape(ctx.workdir)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${xmlEscape(join(logDir, 'stdout.log'))}</string>
    <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, 'stderr.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${xmlEscape(ctx.servicePath)}</string>
    </dict>
</dict>
</plist>
`;
}

async function installMacOS(ctx: InstallCtx): Promise<ServiceResult> {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, `${SERVICE_LABEL}.plist`);
    const logDir = join(homedir(), '.sokuza', 'logs');

    const plist = renderMacOSPlist(ctx, logDir);

    await mkdir(plistDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await writeFile(plistPath, plist, 'utf-8');

    const followUp: string[] = [];
    // macOS has two user-scoped launchd domains:
    //   gui/<uid>   — requires an active GUI login session (most laptops)
    //   user/<uid>  — works for headless ssh-only sessions too
    // Try gui first (nicer for typical laptop users), then user for headless
    // macOS servers, then legacy `load` as a final fallback.
    const uid = userInfo().uid;
    const guiDomain = `gui/${uid}`;
    const userDomain = `user/${uid}`;
    const tryBootstrap = (domain: string) =>
        run('launchctl', ['bootstrap', domain, plistPath]);

    let loaded = false;
    let via = '';

    const gui = tryBootstrap(guiDomain);
    if (gui.status === 0) { loaded = true; via = `\`launchctl bootstrap ${guiDomain}\``; }

    if (!loaded) {
        const headless = tryBootstrap(userDomain);
        if (headless.status === 0) { loaded = true; via = `\`launchctl bootstrap ${userDomain}\` (headless-compatible)`; }
    }

    if (!loaded) {
        const load = run('launchctl', ['load', plistPath]);
        if (load.status === 0) { loaded = true; via = `legacy \`launchctl load\``; }
    }

    if (loaded) {
        followUp.push(`Loaded via ${via}. Auto-starts on login.`);
    } else {
        followUp.push(
            `Plist written to ${plistPath}, but launchctl refused to load it. ` +
            `Check logs in ${logDir}.`,
        );
    }
    followUp.push(
        `PATH was baked into the plist. If you later install tools in a new ` +
        `directory (e.g. NVM, mise) and workflows can't find them, re-run ` +
        `\`sokuza service enable\` to refresh it.`,
    );

    return { platform: 'darwin', unitPath: plistPath, followUp };
}

async function uninstallMacOS(): Promise<ServiceResult> {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const followUp: string[] = [];

    // Try both domains in case the install used the headless-compatible one.
    const uid = userInfo().uid;
    const bootoutGui = run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
    const bootoutUser = run('launchctl', ['bootout', `user/${uid}/${SERVICE_LABEL}`]);
    if (bootoutGui.status !== 0 && bootoutUser.status !== 0) {
        run('launchctl', ['unload', plistPath]);
    }

    if (existsSync(plistPath)) {
        await rm(plistPath);
        followUp.push(`Removed ${plistPath}`);
    } else {
        followUp.push(`No plist at ${plistPath} — already uninstalled.`);
    }

    return { platform: 'darwin', unitPath: plistPath, followUp };
}

// ─── Windows (Task Scheduler logon task) ────────────────────────────────────

const WINDOWS_TASK_NAME = 'Sokuza';

/**
 * Generate a Task Scheduler XML definition for a user-scoped logon task.
 * Pure function: takes an install context + username, returns the XML body.
 * The XML is imported via `schtasks /Create /XML`.
 *
 * Settings worth noting:
 *   - `LogonTrigger`  fires on user login.
 *   - `RestartOnFailure` + `Count=9999` matches the Linux/macOS "restart on
 *     crash" contract. Without this, a crashed sokuza stays down until reboot.
 *   - `ExecutionTimeLimit=PT0S` disables the default 72h timeout.
 *   - `LogonType=InteractiveToken` + `RunLevel=LeastPrivilege` runs as the
 *     current user, no UAC elevation required.
 */
export function renderWindowsTaskXml(ctx: InstallCtx, userId: string): string {
    const esc = xmlEscape;
    const args = `"${ctx.entry}" start --config "${ctx.configPath}"`;
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sokuza — AI workflow automation engine</Description>
    <Author>${esc(userId)}</Author>
    <URI>\\${WINDOWS_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>9999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(ctx.nodeBin)}</Command>
      <Arguments>${esc(args)}</Arguments>
      <WorkingDirectory>${esc(ctx.workdir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Encode a string as UTF-16 LE with BOM. Older `schtasks /Create /XML`
 * releases only accept this encoding.
 */
function encodeUtf16LeWithBom(content: string): Buffer {
    return Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(content, 'utf16le'),
    ]);
}

async function installWindows(ctx: InstallCtx): Promise<ServiceResult> {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const stateDir = join(localAppData, 'Sokuza');
    const taskXmlPath = join(stateDir, 'task.xml');

    const userDomain = process.env.USERDOMAIN;
    const baseUser = userInfo().username;
    const userId = userDomain ? `${userDomain}\\${baseUser}` : baseUser;

    const xml = renderWindowsTaskXml(ctx, userId);
    await mkdir(stateDir, { recursive: true });
    await writeFile(taskXmlPath, encodeUtf16LeWithBom(xml));

    const followUp: string[] = [];
    const register = run('schtasks', ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', taskXmlPath, '/F']);
    if (register.status !== 0) {
        followUp.push(
            `Task XML written to ${taskXmlPath}, but \`schtasks /Create\` failed: ` +
            `${register.stderr.trim() || register.stdout.trim() || 'unknown error'}`,
        );
    } else {
        followUp.push(
            `Registered scheduled task "${WINDOWS_TASK_NAME}" — fires at user logon with ` +
            `automatic restart on crash.`,
        );
        const start = run('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME]);
        if (start.status === 0) {
            followUp.push(`Started immediately; no need to log out.`);
        }
    }
    followUp.push(
        `PATH is inherited from your user environment when the task fires. ` +
        `If a workflow can't find a tool, add its directory to the user PATH ` +
        `(System Properties → Environment Variables) and restart the task.`,
    );

    return { platform: 'win32', unitPath: taskXmlPath, followUp };
}

async function uninstallWindows(): Promise<ServiceResult> {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const taskXmlPath = join(localAppData, 'Sokuza', 'task.xml');
    const followUp: string[] = [];

    const stop = run('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME]);
    // /End returns non-zero when the task isn't running — benign.
    void stop;

    const del = run('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
    if (del.status === 0) {
        followUp.push(`Unregistered scheduled task "${WINDOWS_TASK_NAME}".`);
    } else {
        followUp.push(`Task "${WINDOWS_TASK_NAME}" was not registered.`);
    }

    if (existsSync(taskXmlPath)) {
        await rm(taskXmlPath);
        followUp.push(`Removed ${taskXmlPath}`);
    }

    // Also clean up the legacy Startup-folder shim from previous autostart
    // implementations. Users upgrading shouldn't have a stray .cmd around.
    const legacyShim = process.env.APPDATA
        ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'sokuza.cmd')
        : null;
    if (legacyShim && existsSync(legacyShim)) {
        await rm(legacyShim);
        followUp.push(`Removed legacy Startup-folder shim at ${legacyShim}`);
    }

    return { platform: 'win32', unitPath: taskXmlPath, followUp };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
    // systemd ExecStart tokenizes on whitespace but understands quoted strings.
    // Wrap anything with spaces or shell metacharacters.
    if (/^[A-Za-z0-9_\-./@%+=:]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
}

function xmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf-8' });
    return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
    };
}

function commandExists(cmd: string): boolean {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(which, [cmd], { encoding: 'utf-8' });
    return r.status === 0;
}
