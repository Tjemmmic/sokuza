import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION, readInstalledVersion } from '../version.js';

describe('VERSION', () => {
    it('tracks the version in package.json', () => {
        const here = fileURLToPath(import.meta.url);
        const pkgPath = join(dirname(here), '..', '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
        expect(VERSION).toBe(pkg.version);
    });

    it('is a non-empty string', () => {
        expect(typeof VERSION).toBe('string');
        expect(VERSION.length).toBeGreaterThan(0);
    });
});

describe('readInstalledVersion', () => {
    let dir: string;
    let pkg: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'sokuza-version-'));
        pkg = join(dir, 'package.json');
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // This is the core of the "restart to apply" feature: an in-place
    // `npm install -g` overwrites package.json at the same path the running
    // process resolves, so readInstalledVersion must do a FRESH read each call
    // (return the new version), while the frozen VERSION constant does not move.
    it('re-reads the on-disk version on each call — it is NOT the frozen VERSION', async () => {
        await writeFile(pkg, JSON.stringify({ version: '1.2.3' }), 'utf-8');
        expect(readInstalledVersion(pkg)).toBe('1.2.3');

        // Simulate `npm install -g` overwriting the same file in place.
        await writeFile(pkg, JSON.stringify({ version: '4.5.6' }), 'utf-8');
        expect(readInstalledVersion(pkg)).toBe('4.5.6'); // fresh read, not cached

        // The module-load VERSION constant is unaffected by the disk change —
        // the exact divergence that drives `restartRequired`.
        expect(VERSION).not.toBe('4.5.6');
    });

    it('returns the sentinel (not VERSION) when the file is missing or invalid', async () => {
        expect(readInstalledVersion(join(dir, 'nope.json'))).toBe('0.0.0-unknown');
        await writeFile(pkg, 'not json', 'utf-8');
        expect(readInstalledVersion(pkg)).toBe('0.0.0-unknown');
    });
});
