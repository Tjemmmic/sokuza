import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sokuza package version, resolved from package.json at module-load time.
 *
 * Both layouts (`src/version.ts` under tsx and `dist/index.js` bundled) sit
 * one directory below package.json, so a single relative path covers both.
 * Surfaced on `/health` and in `~/.sokuza/state.json`; a hard-coded string
 * drifted from package.json during a past release, which this avoids.
 */
function resolveVersion(): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkgPath = join(dirname(here), '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
            return pkg.version;
        }
    } catch {
        // Fall through to the sentinel — discovery still works, the public
        // site just sees a version it can't pin.
    }
    return '0.0.0-unknown';
}

export const VERSION = resolveVersion();
