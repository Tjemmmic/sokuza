import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectInstaller, resolveEntryPath } from '../cli/update.js';
import { compareSemver, isNewer, computeUpdateSnapshot } from '../cli/update-check.js';
import { extractField, renderWindowsTaskXml, type InstallCtx } from '../cli/service.js';

describe('detectInstaller', () => {
    it('recognises a Homebrew Cellar install', () => {
        const info = detectInstaller('/opt/homebrew/Cellar/sokuza/0.1.0/libexec/bin/sokuza');
        expect(info.name).toBe('brew');
        expect(info.command).toBe('brew');
        expect(info.args).toEqual(['upgrade', 'sokuza']);
    });

    it('recognises a Bun global install', () => {
        const info = detectInstaller(
            '/home/alice/.bun/install/global/node_modules/sokuza/dist/index.js',
        );
        expect(info.name).toBe('bun');
        expect(info.args).toEqual(['install', '-g', 'sokuza@latest']);
    });

    it('recognises a pnpm global install', () => {
        const info = detectInstaller(
            '/home/alice/.local/share/pnpm/global/5/node_modules/sokuza/dist/index.js',
        );
        expect(info.name).toBe('pnpm');
        expect(info.args).toEqual(['add', '-g', 'sokuza@latest']);
    });

    it('recognises a Yarn global install', () => {
        const info = detectInstaller(
            '/home/alice/.config/yarn/global/node_modules/sokuza/dist/index.js',
        );
        expect(info.name).toBe('yarn');
        expect(info.args).toEqual(['global', 'add', 'sokuza@latest']);
    });

    it('falls back to npm for standard npm global paths', () => {
        const info = detectInstaller(
            '/usr/local/lib/node_modules/sokuza/dist/index.js',
        );
        expect(info.name).toBe('npm');
        expect(info.args).toEqual(['install', '-g', 'sokuza@latest']);
    });

    it('falls back to npm for nvm-managed node globals', () => {
        const info = detectInstaller(
            '/home/alice/.nvm/versions/node/v22.5.0/lib/node_modules/sokuza/dist/index.js',
        );
        expect(info.name).toBe('npm');
    });

    it('recognises a source checkout (path without node_modules)', () => {
        const info = detectInstaller('/home/alice/dev/sokuza/dist/index.js');
        expect(info.name).toBe('source');
        // runUpdate uses empty command as the "refuse to run" signal.
        expect(info.command).toBe('');
    });

    it('handles Windows npm global path with backslashes', () => {
        const info = detectInstaller(
            'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\sokuza\\dist\\index.js',
        );
        expect(info.name).toBe('npm');
    });

    it('handles Windows pnpm global path', () => {
        const info = detectInstaller(
            'C:\\Users\\alice\\AppData\\Local\\pnpm\\global\\5\\node_modules\\sokuza\\dist\\index.js',
        );
        expect(info.name).toBe('pnpm');
    });
});

// `runUpdate` calls `resolveEntryPath(process.argv[1])`. On a real
// npm-global install, argv[1] is `~/.npm-global/bin/sokuza` — a symlink
// pointing at `~/.npm-global/lib/node_modules/sokuza/dist/index.js`.
// Before realpath-ing the symlink, detectInstaller saw the bin path
// (no `/node_modules/sokuza/`), misclassified as 'source', and refused
// to upgrade. This was the actual user-visible bug.

describe('resolveEntryPath', () => {
    let tmp = '';

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), 'sokuza-resolve-entry-'));
    });

    afterEach(async () => {
        if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it('returns the resolved path unchanged for a regular file', async () => {
        const real = join(tmp, 'plain.js');
        await writeFile(real, '');
        expect(resolveEntryPath(real)).toBe(real);
    });

    it('follows a symlink to the underlying install path', async () => {
        // Reproduce the npm-global layout exactly: `bin/sokuza` symlink
        // → `lib/node_modules/sokuza/dist/index.js`. The symlink path
        // doesn't contain `/node_modules/sokuza/`, the target does.
        const lib = join(tmp, 'lib', 'node_modules', 'sokuza', 'dist');
        await mkdir(lib, { recursive: true });
        const target = join(lib, 'index.js');
        await writeFile(target, '');

        const binDir = join(tmp, 'bin');
        await mkdir(binDir, { recursive: true });
        const link = join(binDir, 'sokuza');
        await symlink(target, link);

        // Resolving the symlink path must return the target, NOT the
        // symlink — otherwise detectInstaller still won't see
        // `/node_modules/sokuza/` and falls back to 'source'.
        const resolved = resolveEntryPath(link);
        expect(resolved).toBe(target);
        expect(resolved).toContain('/node_modules/sokuza/');

        // And the downstream classifier now correctly identifies npm.
        expect(detectInstaller(resolved).name).toBe('npm');
    });

    it('falls back to the resolved-but-unfollowed path on realpath failure', async () => {
        // Defensive: if argv[1] points at something that doesn't exist
        // (deleted binary, broken symlink, ENOENT), don't throw — let
        // detectInstaller deal with it. Mis-classifying as 'source' is
        // a clearer user message than an unhandled realpath exception
        // crashing `sokuza update`.
        const missing = join(tmp, 'does-not-exist');
        expect(resolveEntryPath(missing)).toBe(missing);
    });
});

describe('compareSemver', () => {
    it('returns 0 for identical versions', () => {
        expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    });

    it('orders by major, minor, patch', () => {
        expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
        expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
        expect(compareSemver('1.3.0', '1.2.99')).toBeGreaterThan(0);
    });

    it('treats stable as newer than prerelease at the same X.Y.Z', () => {
        expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
        expect(compareSemver('1.0.0-rc.2', '1.0.0')).toBeLessThan(0);
    });

    it('compares prerelease tags lexically within the same X.Y.Z', () => {
        expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0);
    });

    it('tolerates missing patch components', () => {
        expect(compareSemver('1.2', '1.2.0')).toBe(0);
        expect(compareSemver('1', '0.999.999')).toBeGreaterThan(0);
    });
});

describe('isNewer', () => {
    it('returns true only when the latest string is strictly newer', () => {
        expect(isNewer('0.2.0', '0.1.0')).toBe(true);
        expect(isNewer('0.1.0', '0.1.0')).toBe(false);
        expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    });
});

describe('computeUpdateSnapshot', () => {
    const cache = (latest: string) => ({ checkedAt: 1000, latest });

    it('up to date: running == installed == latest → neither flag set', () => {
        const s = computeUpdateSnapshot('0.2.6', '0.2.6', cache('0.2.6'));
        expect(s).toMatchObject({ current: '0.2.6', installed: '0.2.6', latest: '0.2.6', updateAvailable: false, restartRequired: false });
    });

    it('update available: a newer release than installed exists', () => {
        const s = computeUpdateSnapshot('0.2.6', '0.2.6', cache('0.3.0'));
        expect(s.updateAvailable).toBe(true);
        expect(s.restartRequired).toBe(false);
    });

    it('restart required: installed is ahead of running, and the registry offers nothing newer', () => {
        // The exact post-"Update now" state: disk has 0.3.0, process still on 0.2.6.
        const s = computeUpdateSnapshot('0.2.6', '0.3.0', cache('0.3.0'));
        expect(s.restartRequired).toBe(true);
        expect(s.updateAvailable).toBe(false); // already installed the latest — don't re-offer
    });

    it('both: installed ahead of running AND an even newer release exists', () => {
        const s = computeUpdateSnapshot('0.2.6', '0.3.0', cache('0.4.0'));
        expect(s.restartRequired).toBe(true);
        expect(s.updateAvailable).toBe(true);
    });

    it('no check yet: null cache leaves latest null and updateAvailable false', () => {
        const s = computeUpdateSnapshot('0.2.6', '0.2.6', null);
        expect(s.latest).toBeNull();
        expect(s.checkedAt).toBeNull();
        expect(s.updateAvailable).toBe(false);
        expect(s.restartRequired).toBe(false);
    });
});

describe('extractField', () => {
    const sample =
`
Folder: \\
HostName:                             MYPC
TaskName:                             \\Sokuza
Next Run Time:                        4/17/2026 12:00:00 AM
Status:                               Running
Logon Mode:                           Interactive only
Last Run Time:                        4/17/2026 10:00:00 AM
Last Result:                          0
Author:                               MYPC\\alice
Task To Run:                          C:\\node.exe
Start In:                             C:\\Users\\alice
Scheduled Task State:                 Enabled
`;

    it('extracts the Status field from schtasks /FO LIST /V output', () => {
        expect(extractField(sample, 'Status')).toBe('Running');
    });

    it('extracts the Scheduled Task State field', () => {
        expect(extractField(sample, 'Scheduled Task State')).toBe('Enabled');
    });

    it('returns empty string when the field is not present', () => {
        expect(extractField(sample, 'Nonexistent Field')).toBe('');
    });

    it('is case-insensitive on the field name', () => {
        expect(extractField(sample, 'status')).toBe('Running');
    });
});

// `sokuza service restart` on Windows used to race against `schtasks /End`'s
// async stop: with MultipleInstancesPolicy=IgnoreNew baked into the install
// XML, a follow-up `/Run` could be silently dropped while the prior instance
// was still winding down, leaving us to report a phantom "Restarted." The
// task XML now uses StopExisting so `/Run` alone has true restart semantics,
// closing the race for any future install. Pin that policy choice in the
// XML so a casual edit can't reintroduce the bug.
describe('renderWindowsTaskXml', () => {
    const ctx: InstallCtx = {
        configPath: 'C:\\Users\\alice\\sokuza.config.yaml',
        nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
        entry: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\sokuza\\dist\\index.js',
        workdir: 'C:\\Users\\alice',
        servicePath: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    };

    it('uses MultipleInstancesPolicy=StopExisting so /Run alone restarts cleanly', () => {
        const xml = renderWindowsTaskXml(ctx, 'MYPC\\alice');
        expect(xml).toContain('<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>');
        expect(xml).not.toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    });
});
