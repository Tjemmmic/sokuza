import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_NAME = 'sokuza.config.yaml';

export interface InitOptions {
    /** Target directory (defaults to process.cwd()) */
    cwd?: string;
    /** Overwrite an existing config without asking */
    force?: boolean;
}

/**
 * Write a fresh `sokuza.config.yaml` into the target directory, sourced
 * from the bundled example. Refuses to clobber an existing config unless
 * --force was passed — users shouldn't lose local edits by accident.
 */
export async function runInit(opts: InitOptions): Promise<void> {
    const target = resolve(opts.cwd ?? process.cwd(), DEFAULT_CONFIG_NAME);

    if (existsSync(target) && !opts.force) {
        process.stderr.write(
            `sokuza: ${target} already exists. Pass --force to overwrite.\n`,
        );
        process.exit(1);
    }

    const example = locateBundledExample();
    if (!example) {
        process.stderr.write(
            `sokuza: could not locate the bundled sokuza.config.example.yaml.\n`,
        );
        process.exit(1);
    }

    await copyFile(example, target);
    process.stdout.write(
        `Created ${target}\n` +
        `Next: edit it to enable integrations, then run \`sokuza\` to start.\n`,
    );
}

function locateBundledExample(): string | null {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        resolve(dirname(here), '..', '..', 'sokuza.config.example.yaml'),
        resolve(dirname(here), '..', 'sokuza.config.example.yaml'),
        resolve(dirname(here), 'sokuza.config.example.yaml'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}
