import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Cross-platform service installer. The goal is a low-drama autostart:
 * user runs `sokuza install-service` once, and the engine comes back up
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
 * on exactly the PATH the user had when they ran `install-service`.
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
        `\`sokuza install-service\` to refresh it.`,
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
    // Prefer `bootstrap` on modern macOS; fall back to legacy `load`.
    const uid = userInfo().uid;
    const domain = `gui/${uid}`;
    const bootstrap = run('launchctl', ['bootstrap', domain, plistPath]);
    if (bootstrap.status !== 0) {
        const load = run('launchctl', ['load', plistPath]);
        if (load.status !== 0) {
            followUp.push(
                `Plist written to ${plistPath}, but launchctl refused to load it. ` +
                `Check logs in ${logDir}.`,
            );
        } else {
            followUp.push(`Loaded via legacy \`launchctl load\`.`);
        }
    } else {
        followUp.push(`Loaded via \`launchctl bootstrap ${domain}\`. Auto-starts on login.`);
    }
    followUp.push(
        `PATH was baked into the plist. If you later install tools in a new ` +
        `directory (e.g. NVM, mise) and workflows can't find them, re-run ` +
        `\`sokuza install-service\` to refresh it.`,
    );

    return { platform: 'darwin', unitPath: plistPath, followUp };
}

async function uninstallMacOS(): Promise<ServiceResult> {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const followUp: string[] = [];

    const uid = userInfo().uid;
    const domain = `gui/${uid}`;
    const bootout = run('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
    if (bootout.status !== 0) {
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

// ─── Windows (Startup folder shim) ──────────────────────────────────────────

async function installWindows(ctx: InstallCtx): Promise<ServiceResult> {
    const startup = process.env.APPDATA
        ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        : null;
    if (!startup) {
        throw new Error('APPDATA is not set — cannot locate Windows Startup folder.');
    }

    const shimPath = join(startup, 'sokuza.cmd');
    const logDir = join(homedir(), '.sokuza', 'logs');
    await mkdir(logDir, { recursive: true });

    const shim = `@echo off
REM Auto-generated by \`sokuza install-service\`. Launches Sokuza at login.
cd /d ${winQuote(ctx.workdir)}
start "" /b ${winQuote(ctx.nodeBin)} ${winQuote(ctx.entry)} start --config ${winQuote(ctx.configPath)} 1>>${winQuote(join(logDir, 'stdout.log'))} 2>>${winQuote(join(logDir, 'stderr.log'))}
`;

    await mkdir(startup, { recursive: true });
    await writeFile(shimPath, shim, 'utf-8');

    return {
        platform: 'win32',
        unitPath: shimPath,
        followUp: [
            `Shim installed at ${shimPath}. Sokuza will launch at next login.`,
            `To start now without logging out, run: \`sokuza\` in another terminal.`,
        ],
    };
}

async function uninstallWindows(): Promise<ServiceResult> {
    const startup = process.env.APPDATA
        ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        : null;
    const shimPath = startup ? join(startup, 'sokuza.cmd') : '';
    const followUp: string[] = [];

    if (shimPath && existsSync(shimPath)) {
        await rm(shimPath);
        followUp.push(`Removed ${shimPath}`);
    } else {
        followUp.push(`No startup shim found — already uninstalled.`);
    }

    return { platform: 'win32', unitPath: shimPath, followUp };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
    // systemd ExecStart tokenizes on whitespace but understands quoted strings.
    // Wrap anything with spaces or shell metacharacters.
    if (/^[A-Za-z0-9_\-./@%+=:]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
}

function winQuote(s: string): string {
    // Always wrap Windows paths — they can contain spaces (`Program Files`) and `&`.
    return `"${s.replace(/"/g, '""')}"`;
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
