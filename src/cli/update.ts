import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A package manager we know how to drive to upgrade a global sokuza install.
 * `source` means "not a managed install" — the caller should bail with a
 * pointer to `git pull && npm run build` instead of blindly shelling out.
 */
export type InstallerName = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'brew' | 'source';

export interface InstallerInfo {
    name: InstallerName;
    command: string;
    args: string[];
    /** Human label used in the "Updating via X..." banner. */
    label: string;
}

/**
 * Guess how this sokuza was installed based on the CLI entry path. The path
 * shape is stable per package manager and doesn't require any filesystem
 * probing or network calls, which keeps `sokuza update` fast and offline-
 * friendly.
 *
 * When nothing matches we default to npm (`install -g`) — npm is the common
 * fallback for the global Node CLI ecosystem, and `npm install -g` works on
 * a machine that has any of the major managers. A path that doesn't live
 * under `node_modules` at all is treated as a source checkout; we refuse to
 * shell out to a package manager in that case because it wouldn't actually
 * replace the running binary.
 */
export function detectInstaller(entryPath: string): InstallerInfo {
    const p = entryPath.replace(/\\/g, '/').toLowerCase();

    // Homebrew formula installs live under a Cellar prefix.
    if (p.includes('/cellar/sokuza/')) {
        return {
            name: 'brew',
            command: 'brew',
            args: ['upgrade', 'sokuza'],
            label: 'Homebrew',
        };
    }

    // Anything outside node_modules is almost certainly a source checkout
    // (dist/index.js inside the repo, or a `npm link` to the working tree).
    if (!p.includes('/node_modules/sokuza/')) {
        return { name: 'source', command: '', args: [], label: 'source checkout' };
    }

    if (p.includes('/.bun/')) {
        return {
            name: 'bun',
            command: 'bun',
            args: ['install', '-g', 'sokuza@latest'],
            label: 'bun (global)',
        };
    }
    if (p.includes('/pnpm/') || p.includes('/.pnpm-global/')) {
        return {
            name: 'pnpm',
            command: 'pnpm',
            args: ['add', '-g', 'sokuza@latest'],
            label: 'pnpm (global)',
        };
    }
    if (p.includes('/yarn/global/') || p.includes('/.yarn/')) {
        return {
            name: 'yarn',
            command: 'yarn',
            args: ['global', 'add', 'sokuza@latest'],
            label: 'yarn (global)',
        };
    }

    return {
        name: 'npm',
        command: 'npm',
        args: ['install', '-g', 'sokuza@latest'],
        label: 'npm (global)',
    };
}

/**
 * Resolve the CLI entry path for installer detection.
 *
 * `process.argv[1]` from a globally-installed sokuza is a symlink in the
 * package manager's `bin/` directory (e.g. `~/.npm-global/bin/sokuza`)
 * pointing at the actual install
 * (`~/.npm-global/lib/node_modules/sokuza/dist/index.js`). `resolve()`
 * alone doesn't follow symlinks, so the installer-detection regex —
 * which keys off `/node_modules/sokuza/` — never matches the bin entry
 * and we misclassify as 'source'. Follow the symlink so we classify the
 * actual install location, not the wrapper.
 *
 * Defensive: if `realpath` throws (deleted binary, broken symlink,
 * permission), fall back to the resolved-but-unfollowed path. We'd
 * rather mis-classify as 'source' than have `sokuza update` throw on
 * an exotic install layout.
 */
export function resolveEntryPath(rawPath: string): string {
    const resolved = resolve(rawPath);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/** Why an update attempt didn't produce a successful exit. `null` = success. */
export type UpdateFailureReason =
    | 'source'
    | 'missing-command'
    | 'spawn-error'
    | 'nonzero-exit'
    | null;

export interface UpdateResult {
    ok: boolean;
    reason: UpdateFailureReason;
    installer: InstallerInfo;
    exitCode: number | null;
    /** Present when `captureOutput: true` was requested (API path). */
    stdout?: string;
    stderr?: string;
    /** Populated for `spawn-error` / `missing-command`. */
    error?: string;
}

export interface RunUpdateOptions {
    /** Absolute path to the sokuza CLI entry file — typically `process.argv[1]`. */
    entryPath: string;
    /**
     * `true` → capture stdout/stderr on the result (for API JSON responses).
     * `false` → inherit stdio so the user sees live output in their terminal.
     */
    captureOutput: boolean;
    /** Called after detection so the CLI can print a "Updating via X..." banner. */
    onDetect?: (info: InstallerInfo) => void;
}

/**
 * Shared update implementation used by both the CLI wrapper (`runUpdate`)
 * and the dashboard API route. Returns a structured result instead of
 * calling `process.exit` so it can be driven from any context.
 */
export async function runUpdateCommand(opts: RunUpdateOptions): Promise<UpdateResult> {
    const info = detectInstaller(opts.entryPath);
    opts.onDetect?.(info);

    if (info.name === 'source') {
        return { ok: false, reason: 'source', installer: info, exitCode: null };
    }

    const spawnOpts: SpawnSyncOptions = {
        shell: process.platform === 'win32',
    };
    if (opts.captureOutput) {
        spawnOpts.encoding = 'utf-8';
    } else {
        spawnOpts.stdio = 'inherit';
    }

    const res = spawnSync(info.command, info.args, spawnOpts);

    const captured = opts.captureOutput
        ? {
            stdout: typeof res.stdout === 'string' ? res.stdout : (res.stdout?.toString?.() ?? ''),
            stderr: typeof res.stderr === 'string' ? res.stderr : (res.stderr?.toString?.() ?? ''),
        }
        : {};

    if (res.error) {
        const code = (res.error as NodeJS.ErrnoException).code;
        return {
            ok: false,
            reason: code === 'ENOENT' ? 'missing-command' : 'spawn-error',
            installer: info,
            exitCode: null,
            error: res.error.message,
            ...captured,
        };
    }

    return {
        ok: res.status === 0,
        reason: res.status === 0 ? null : 'nonzero-exit',
        installer: info,
        exitCode: res.status ?? null,
        ...captured,
    };
}

/**
 * CLI entrypoint for `sokuza update`. Thin wrapper around `runUpdateCommand`
 * that prints human-friendly text and translates failure reasons into exit
 * codes.
 */
export async function runUpdate(): Promise<void> {
    const entry = resolveEntryPath(process.argv[1]);

    const result = await runUpdateCommand({
        entryPath: entry,
        captureOutput: false,
        onDetect: (info) => {
            if (info.name === 'source') return;
            process.stdout.write(
                `Updating sokuza via ${info.label}…\n` +
                `> ${info.command} ${info.args.join(' ')}\n\n`,
            );
        },
    });

    if (result.reason === 'source') {
        process.stderr.write(
            `sokuza appears to be running from a source checkout:\n` +
            `  ${entry}\n\n` +
            `\`sokuza update\` only upgrades globally-installed releases. ` +
            `For a source checkout, pull and rebuild:\n` +
            `  git pull && npm install && npm run build\n`,
        );
        process.exit(1);
    }

    if (result.reason === 'missing-command') {
        process.stderr.write(
            `\n\`${result.installer.command}\` not found on PATH. ` +
            `Install it first, or upgrade sokuza manually with another package manager.\n`,
        );
        process.exit(1);
    }

    if (result.reason === 'spawn-error') {
        throw new Error(result.error ?? 'spawn failed');
    }

    if (!result.ok) {
        process.stderr.write(
            `\nUpdate failed (\`${result.installer.command}\` exited with ${result.exitCode ?? '?'}). ` +
            `See output above for details.\n`,
        );
        process.exit(result.exitCode ?? 1);
    }

    process.stdout.write(
        `\nUpdate complete. If sokuza is running as a service, restart it so the ` +
        `new version takes effect: \`sokuza service restart\`.\n`,
    );
}
