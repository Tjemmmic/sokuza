import { copyFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { locateBundledFile } from './bundled-files.js';

const CONFIG_NAME = 'sokuza.config.yaml';
const ENV_NAME = '.env';
const CONFIG_EXAMPLE = 'sokuza.config.example.yaml';
const ENV_EXAMPLE = 'sokuza.env.example';
const HOME_CONFIG_DIR = join(homedir(), '.sokuza');
const HOME_CONFIG_NAME = 'config.yaml';

export interface InitOptions {
    /** When true, scaffold in CWD (dev/project-local layout). */
    local?: boolean;
    /** Target directory for --local mode (defaults to process.cwd()). */
    cwd?: string;
    /** Overwrite existing files without asking. */
    force?: boolean;
}

type Outcome =
    | { kind: 'created'; path: string }
    | { kind: 'skipped'; path: string; reason: string };

/**
 * Scaffold a fresh sokuza config.
 *
 * Two layouts are supported:
 *
 *   1. **Home-dir (default, shipped-package layout).** Creates
 *      `~/.sokuza/config.yaml` with mode 0600. This is where API keys
 *      entered through the dashboard will be stored, so the file is
 *      treated as a per-user secret.
 *
 *   2. **Local (`--local`, dev layout).** Creates `sokuza.config.yaml` and
 *      `.env` in the target directory (default: CWD). Useful when
 *      developing against the sokuza repo or pinning config to a project.
 */
export async function runInit(opts: InitOptions): Promise<void> {
    if (opts.local) {
        await runInitLocal(opts);
    } else {
        await runInitHome(opts);
    }
}

async function runInitHome(opts: InitOptions): Promise<void> {
    const force = opts.force ?? false;
    const destPath = join(HOME_CONFIG_DIR, HOME_CONFIG_NAME);

    await mkdir(HOME_CONFIG_DIR, { recursive: true });
    const result = await scaffold(destPath, CONFIG_EXAMPLE, force);

    if (result.kind === 'created') {
        // chmod is best-effort — no-op on Windows, and we don't want to
        // fail init if the fs layer rejects it.
        await chmod(destPath, 0o600).catch(() => undefined);
        process.stdout.write(`Created ${destPath} (mode 0600)\n`);
    } else {
        process.stdout.write(`Skipped ${destPath} — ${result.reason}\n`);
    }

    process.stdout.write(
        `\nNext:\n` +
        `  1. Run \`sokuza\` to start the engine.\n` +
        `  2. Open the dashboard and add integrations / AI providers there.\n` +
        `\nFor a project-local config (and .env), run \`sokuza init --local\`.\n`,
    );
}

async function runInitLocal(opts: InitOptions): Promise<void> {
    const dir = resolve(opts.cwd ?? process.cwd());
    const force = opts.force ?? false;

    const results: Outcome[] = [
        await scaffold(resolve(dir, CONFIG_NAME), CONFIG_EXAMPLE, force),
        await scaffold(resolve(dir, ENV_NAME), ENV_EXAMPLE, force),
    ];

    for (const r of results) {
        if (r.kind === 'created') {
            process.stdout.write(`Created ${r.path}\n`);
        } else {
            process.stdout.write(`Skipped ${r.path} — ${r.reason}\n`);
        }
    }

    process.stdout.write(
        `\nNext:\n` +
        `  1. Edit ${resolve(dir, CONFIG_NAME)} to enable integrations.\n` +
        `  2. Fill tokens in ${resolve(dir, ENV_NAME)} for the integrations you enabled.\n` +
        `  3. Run \`sokuza\` from this directory to start the engine.\n`,
    );
}

async function scaffold(
    destPath: string,
    sourceName: string,
    force: boolean,
): Promise<Outcome> {
    if (existsSync(destPath) && !force) {
        return { kind: 'skipped', path: destPath, reason: 'already exists (pass --force to overwrite)' };
    }
    const source = locateBundledFile(sourceName);
    if (!source) {
        return { kind: 'skipped', path: destPath, reason: `bundled ${sourceName} not found` };
    }
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(source, destPath);
    return { kind: 'created', path: destPath };
}
