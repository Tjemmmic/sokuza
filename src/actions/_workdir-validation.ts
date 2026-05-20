import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * Shared workdir validator for actions that operate on a user-supplied
 * working directory (`git-commit-and-push`, `shell-exec`, …). The
 * visual editor surfaces this field as freeform text, so a user-authored
 * workflow YAML could otherwise point at any path on the host. We
 * refuse injection-shaped strings and obviously sensitive system paths
 * but stop short of a strict allowlist — legitimate workdirs span
 * tmpdir, `~/.sokuza/auto-fix-workdirs/`, chat-session paths, and
 * arbitrary operator-chosen `destDir`s.
 *
 * `actionName` is used to prefix error messages so the caller sees
 * "<action>: workdir ..." consistently with other validation errors.
 */
export function validateWorkdir(raw: unknown, actionName: string): string {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`${actionName}: workdir is required`);
    }
    if (raw.includes('\0')) {
        throw new Error(`${actionName}: workdir contains NUL character`);
    }
    if (/[\x00-\x1f\x7f]/.test(raw)) {
        throw new Error(`${actionName}: workdir contains control characters`);
    }
    if (raw.startsWith('-')) {
        // Defence-in-depth: spawn passes cwd via the options object so a
        // leading '-' can't reach argv as a flag, but a path that looks
        // like a flag is almost certainly a misconfiguration we'd rather
        // fail loudly on.
        throw new Error(`${actionName}: workdir must not start with "-" (got ${JSON.stringify(raw)})`);
    }
    if (!isAbsolute(raw)) {
        throw new Error(`${actionName}: workdir must be an absolute path (got ${JSON.stringify(raw)})`);
    }
    const resolved = resolvePath(raw);
    if (resolved === '/' || resolved === '\\') {
        throw new Error(`${actionName}: workdir must not be the filesystem root`);
    }
    for (const denied of FORBIDDEN_WORKDIR_PREFIXES) {
        if (resolved === denied || resolved.startsWith(denied + '/')) {
            throw new Error(`${actionName}: workdir resolves to a sensitive system path (${resolved})`);
        }
    }
    return raw;
}

/** System paths that should never be operated on as a workdir. Exact
 *  match and prefix-with-slash so `/etc-customer` won't accidentally
 *  match `/etc`. Exported for tests + visibility. */
export const FORBIDDEN_WORKDIR_PREFIXES: readonly string[] = [
    '/etc', '/proc', '/sys', '/dev', '/boot', '/root',
    '/usr', '/bin', '/sbin',
    '/lib', '/lib32', '/lib64',
    '/var/log', '/var/lib', '/var/run',
];
