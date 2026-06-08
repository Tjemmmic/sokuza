import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path to the package.json that describes this install. Both layouts
 * (`src/version.ts` under tsx and `dist/index.js` bundled) sit one directory
 * below package.json, so a single relative path covers both.
 */
function defaultPackageJsonPath(): string {
    const here = fileURLToPath(import.meta.url);
    return join(dirname(here), '..', 'package.json');
}

/** Read and validate the `version` field from a package.json on disk. */
function resolveVersion(pkgPath: string): string {
    try {
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
export const VERSION = resolveVersion(defaultPackageJsonPath());

/**
 * The version currently **installed on disk**, re-read on every call.
 *
 * `import.meta.url` is a path *string* — it does not pin file contents. After
 * "Update now" runs `npm install -g sokuza@latest`, npm overwrites the package
 * files **in place** at that same path, so a fresh `readFileSync` here returns
 * the newly-installed version while the running process keeps reporting the
 * old `VERSION` (its already-loaded code) until it's restarted. Comparing the
 * two is what lets the System page show "restart to apply" instead of looping
 * on "update available". (Verified by `version.test.ts`, which rewrites the
 * file under a call and observes the new value while `VERSION` is unchanged.)
 *
 * `pkgPath` is overridable purely so that test can point at a temp file.
 */
export function readInstalledVersion(pkgPath: string = defaultPackageJsonPath()): string {
    return resolveVersion(pkgPath);
}
