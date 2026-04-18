import { spawnSync } from 'node:child_process';
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

export async function runUpdate(): Promise<void> {
    const entry = resolve(process.argv[1]);
    const info = detectInstaller(entry);

    if (info.name === 'source') {
        process.stderr.write(
            `sokuza appears to be running from a source checkout:\n` +
            `  ${entry}\n\n` +
            `\`sokuza update\` only upgrades globally-installed releases. ` +
            `For a source checkout, pull and rebuild:\n` +
            `  git pull && npm install && npm run build\n`,
        );
        process.exit(1);
    }

    process.stdout.write(
        `Updating sokuza via ${info.label}…\n` +
        `> ${info.command} ${info.args.join(' ')}\n\n`,
    );

    const result = spawnSync(info.command, info.args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            process.stderr.write(
                `\n\`${info.command}\` not found on PATH. ` +
                `Install it first, or upgrade sokuza manually with another package manager.\n`,
            );
            process.exit(1);
        }
        throw result.error;
    }

    if (result.status !== 0) {
        process.stderr.write(
            `\nUpdate failed (\`${info.command}\` exited with ${result.status ?? '?'}). ` +
            `See output above for details.\n`,
        );
        process.exit(result.status ?? 1);
    }

    process.stdout.write(
        `\nUpdate complete. If sokuza is running as a service, restart it so the ` +
        `new version takes effect — on Linux: \`systemctl --user restart sokuza.service\`, ` +
        `on macOS: \`launchctl kickstart -k gui/$(id -u)/ai.sokuza\`, ` +
        `on Windows: re-run \`schtasks /End /TN Sokuza\` then \`schtasks /Run /TN Sokuza\`.\n`,
    );
}
