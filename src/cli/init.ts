import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { locateBundledFile } from './bundled-files.js';

const CONFIG_NAME = 'sokuza.config.yaml';
const ENV_NAME = '.env';
const CONFIG_EXAMPLE = 'sokuza.config.example.yaml';
const ENV_EXAMPLE = 'sokuza.env.example';

export interface InitOptions {
    /** Target directory (defaults to process.cwd()) */
    cwd?: string;
    /** Overwrite existing files without asking */
    force?: boolean;
}

type Outcome =
    | { kind: 'created'; path: string }
    | { kind: 'skipped'; path: string; reason: string };

/**
 * Scaffold a fresh sokuza config + .env skeleton in the target directory.
 *
 * Writes two files by default:
 *   - sokuza.config.yaml   (from the bundled example)
 *   - .env                 (from the bundled `sokuza.env.example`, commented out)
 *
 * Existing files are preserved unless `--force` was passed — users should
 * never lose local edits to a tracked tokens file by accident. The .env
 * case is especially load-bearing: it commonly holds real API keys.
 */
export async function runInit(opts: InitOptions): Promise<void> {
    const dir = resolve(opts.cwd ?? process.cwd());
    const force = opts.force ?? false;

    const results: Outcome[] = [
        await scaffold(dir, CONFIG_NAME, CONFIG_EXAMPLE, force),
        await scaffold(dir, ENV_NAME, ENV_EXAMPLE, force),
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
    dir: string,
    destName: string,
    sourceName: string,
    force: boolean,
): Promise<Outcome> {
    const destPath = resolve(dir, destName);
    if (existsSync(destPath) && !force) {
        return { kind: 'skipped', path: destPath, reason: 'already exists (pass --force to overwrite)' };
    }
    const source = locateBundledFile(sourceName);
    if (!source) {
        return { kind: 'skipped', path: destPath, reason: `bundled ${sourceName} not found` };
    }
    await copyFile(source, destPath);
    return { kind: 'created', path: destPath };
}
