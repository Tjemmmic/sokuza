import { describe, it, expect } from 'vitest';

import { detectInstaller } from '../cli/update.js';
import { compareSemver, isNewer } from '../cli/update-check.js';
import { extractField } from '../cli/service.js';

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
