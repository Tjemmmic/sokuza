import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate a file bundled with the sokuza package (the config example,
 * `.env` example, etc.) across the two layouts sokuza can run from:
 *
 *   - dev:   src/cli/<file.ts>        → the asset sits at repo root  (../../<name>)
 *   - built: dist/index.js             → the asset sits at package root (../<name>)
 *
 * Returns the first candidate that exists, or `null` if none do.
 */
export function locateBundledFile(name: string): string | null {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        resolve(dirname(here), '..', '..', name),
        resolve(dirname(here), '..', name),
        resolve(dirname(here), name),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}
