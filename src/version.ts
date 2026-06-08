import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sokuza package version, read from package.json.
 *
 * Both layouts (`src/version.ts` under tsx and `dist/index.js` bundled) sit
 * one directory below package.json, so a single relative path covers both.
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

/**
 * The version of the **running** process, frozen at module-load time.
 * Surfaced on `/health` and in `~/.sokuza/state.json`; a hard-coded string
 * drifted from package.json during a past release, which this avoids.
 */
export const VERSION = resolveVersion();

/**
 * The version currently **installed on disk**, re-read on each call.
 *
 * After the dashboard's "Update now" runs `npm install -g sokuza@latest`,
 * package.json on disk holds the new version while the running process keeps
 * reporting the old `VERSION` until it's restarted. Comparing the two lets the
 * System page show a "restart to apply" state instead of looping on "update
 * available" forever.
 */
export function readInstalledVersion(): string {
    return resolveVersion();
}
