import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION } from '../version.js';

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
