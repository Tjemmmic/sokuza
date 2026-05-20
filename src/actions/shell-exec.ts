import { spawn } from 'node:child_process';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { ActionHandler } from '../core/types.js';
import { abortErrorFromSignal } from '../core/abort-error.js';

/** Grace period between SIGTERM and the fallback SIGKILL. Well-behaved
 *  children (node, npm, cargo, …) exit on SIGTERM in <100ms, so 1.5s is
 *  comfortably above the realistic wait. Kept short on purpose: when a
 *  workflow times out or aborts, the caller wants the action to settle
 *  quickly — leaving a stale child around for many seconds defeats the
 *  point of the timeout. */
const SIGKILL_BACKSTOP_MS = 1500;

/**
 * "shell-exec" — run an arbitrary command in a workdir and capture its
 * stdout/stderr/exit code. Used by graph workflows that need to verify
 * something programmatically (e.g. `npm test` after an AI agent finishes
 * exploring a repo, or `cargo build` to confirm a fix compiles).
 *
 * Two modes:
 *   - **Shell mode** (default, when `args` is omitted): `command` is
 *     parsed as a shell line by `/bin/sh -c`. Ergonomic for one-liners
 *     like `npm test -- --reporter dot` or `grep -r foo src/ | wc -l`.
 *   - **Exec mode** (when `args` is supplied as an array or comma-string):
 *     `command` is the executable and `args` is its argv. No shell
 *     metacharacter interpretation. Safer when any input is templated
 *     from event/upstream-node data.
 *
 * Error semantics differ from most actions on purpose:
 *   - **Spawn failure** (ENOENT, EACCES, …) throws. Wrong command or
 *     missing executable is a workflow misconfiguration, not a useful
 *     data point.
 *   - **Non-zero exit** does NOT throw. The whole point of running tests
 *     is to branch on the result; if `npm test` exits 1, the caller
 *     wants `success: false`, not a halted workflow. Wire `success` /
 *     `exitCode` into downstream flow.if to react.
 *   - **Timeout** doesn't throw either — sets `timedOut: true`,
 *     `success: false`. SIGTERM first, then SIGKILL after a 5s grace.
 *   - **AbortSignal** throws (workflow was cancelled).
 *
 * Output bytes are capped (`max_output_bytes`, default 10MB). When the
 * cap is hit the child is SIGTERM'd and `truncated: true` is set —
 * runaway output is almost always a real bug.
 *
 * Params:
 *   - workdir (required, absolute path). Validated against the same
 *     deny-list as `git-commit-and-push`'s workdir.
 *   - command (required, string).
 *   - args (optional, string[] | comma-string). Presence flips to exec mode.
 *   - timeout_seconds (optional number, default 300).
 *   - max_output_bytes (optional number, default 10MB).
 *   - env (optional KV). Merged over `process.env`.
 */
export const shellExecAction: ActionHandler = async (params, context) => {
    const workdir = validateWorkdir(params.workdir);
    const command = validateCommand(params.command);
    const explicitArgs = parseArgsParam(params.args);
    const useShell = explicitArgs === null;
    const timeoutMs = parseTimeoutMs(params.timeout_seconds);
    const maxBytes = parseMaxBytes(params.max_output_bytes);
    const env = buildEnv(params.env);
    const signal = context.signal;

    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    const startedAt = Date.now();
    context.logger.info(
        {
            workdir,
            command: command.slice(0, 200),
            mode: useShell ? 'shell' : 'exec',
            argCount: explicitArgs?.length,
            timeoutMs,
            maxBytes,
        },
        'shell-exec starting',
    );

    return new Promise((resolve, reject) => {
        // Defensive: shell mode passes command as a single string to
        // `/bin/sh -c` (Node's spawn behavior when shell:true). Exec
        // mode spawns `command` directly with `explicitArgs` as argv.
        const child = useShell
            ? spawn(command, [], { cwd: workdir, env, shell: true })
            : spawn(command, explicitArgs!, { cwd: workdir, env, shell: false });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        // Shared counter across both streams: `max_output_bytes` is a
        // TOTAL cap, not per-stream. With per-stream tracking, stdout
        // and stderr could each independently grow to `maxBytes` for
        // up to 2× the documented limit.
        let capturedBytes = 0;
        let truncated = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | null = null;
        let settled = false;

        // Schedules the SIGKILL backstop, replacing any prior schedule
        // so back-to-back kill paths (timeout, output-cap, abort) don't
        // pile up orphaned timers that keep the event loop alive past
        // the action's resolution.
        const killHard = () => {
            if (killTimer) clearTimeout(killTimer);
            killTimer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* already dead */ }
            }, SIGKILL_BACKSTOP_MS);
        };

        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* already dead */ }
            killHard();
        }, timeoutMs);

        const onAbort = () => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGTERM'); } catch { /* already dead */ }
            killHard();
            clearTimeout(timeoutTimer);
            reject(abortErrorFromSignal(signal!));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const captureFromStream = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
            const remaining = maxBytes - capturedBytes;
            if (remaining <= 0) return; // already full
            const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            if (stream === 'stdout') {
                stdoutChunks.push(accepted);
            } else {
                stderrChunks.push(accepted);
            }
            capturedBytes += accepted.length;
            if (chunk.length > remaining && !truncated) {
                truncated = true;
                try { child.kill('SIGTERM'); } catch { /* already dead */ }
                killHard();
            }
        };

        child.stdout?.on('data', captureFromStream('stdout'));
        child.stderr?.on('data', captureFromStream('stderr'));

        // Cleanup runs on every settlement path. Pulled out so abort
        // and timeout paths don't leak the SIGKILL backstop timer
        // when `close` arrives after them (the close handler would
        // otherwise early-return on `settled` without clearing it).
        const cleanup = () => {
            clearTimeout(timeoutTimer);
            if (killTimer) {
                clearTimeout(killTimer);
                killTimer = null;
            }
            if (signal) signal.removeEventListener('abort', onAbort);
        };

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        });

        child.on('close', (code, sig) => {
            // Always clear pending timers even if we already settled
            // via timeout/abort/error — otherwise the SIGKILL backstop
            // can keep the event loop alive past the action's
            // resolution. Order matters: cleanup before the
            // `if (settled) return` guard.
            cleanup();
            if (settled) return;
            settled = true;

            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            // Treat signal-terminated children as exitCode = -1 unless
            // the OS gave us a numeric code. Distinguishes "the process
            // chose to exit non-zero" (e.g. test failure) from "we killed
            // it" (timeout / output cap).
            const exitCode = typeof code === 'number' ? code : -1;
            const success = exitCode === 0 && !timedOut && !truncated;
            const durationMs = Date.now() - startedAt;

            context.logger.info(
                {
                    workdir,
                    exitCode,
                    signal: sig ?? undefined,
                    durationMs,
                    timedOut,
                    truncated,
                    capturedBytes,
                    stdoutBytes: Buffer.byteLength(stdout),
                    stderrBytes: Buffer.byteLength(stderr),
                },
                'shell-exec completed',
            );

            resolve({
                stdout,
                stderr,
                exitCode,
                success,
                timedOut,
                truncated,
                durationMs,
            });
        });
    });
};

// ─── Validation helpers ────────────────────────────────────────────────────

/**
 * Validate the user-supplied `workdir`. Mirrors `git-commit-and-push` —
 * the visual editor surfaces this as freeform text, so a user-authored
 * workflow YAML could point it at any path on the host. We refuse
 * injection-shaped strings and obviously sensitive system paths but
 * stop short of a strict allowlist (legitimate workdirs span tmpdir,
 * `~/.sokuza/auto-fix-workdirs/`, chat-session paths, and arbitrary
 * operator-chosen destDirs).
 */
function validateWorkdir(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('shell-exec: workdir is required');
    }
    if (raw.includes('\0')) {
        throw new Error('shell-exec: workdir contains NUL character');
    }
    if (/[\x00-\x1f\x7f]/.test(raw)) {
        throw new Error('shell-exec: workdir contains control characters');
    }
    if (raw.startsWith('-')) {
        throw new Error(`shell-exec: workdir must not start with "-" (got ${JSON.stringify(raw)})`);
    }
    if (!isAbsolute(raw)) {
        throw new Error(`shell-exec: workdir must be an absolute path (got ${JSON.stringify(raw)})`);
    }
    const resolved = resolvePath(raw);
    if (resolved === '/' || resolved === '\\') {
        throw new Error('shell-exec: workdir must not be the filesystem root');
    }
    for (const denied of FORBIDDEN_WORKDIR_PREFIXES) {
        if (resolved === denied || resolved.startsWith(denied + '/')) {
            throw new Error(`shell-exec: workdir resolves to a sensitive system path (${resolved})`);
        }
    }
    return raw;
}

/** Kept in sync with the same list in `git-commit-and-push.ts`. */
const FORBIDDEN_WORKDIR_PREFIXES: readonly string[] = [
    '/etc', '/proc', '/sys', '/dev', '/boot', '/root',
    '/usr', '/bin', '/sbin',
    '/lib', '/lib32', '/lib64',
    '/var/log', '/var/lib', '/var/run',
];

function validateCommand(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('shell-exec: command is required');
    }
    if (raw.includes('\0')) {
        throw new Error('shell-exec: command contains NUL character');
    }
    return raw;
}

/** Coerce the `args` param. null return ⇒ user didn't supply args at all
 *  (shell mode); array return ⇒ exec mode (`command` is the executable). */
function parseArgsParam(raw: unknown): string[] | null {
    if (raw === undefined || raw === null) return null;
    let list: unknown[];
    if (Array.isArray(raw)) {
        list = raw;
    } else if (typeof raw === 'string') {
        // Comma-separated form — same convention as `git-commit-and-push.paths`.
        list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else {
        throw new Error(`shell-exec: args must be an array or comma-separated string (got ${typeof raw})`);
    }
    return list.map((entry, idx) => {
        if (typeof entry !== 'string') {
            throw new Error(`shell-exec: args[${idx}] must be a string (got ${typeof entry})`);
        }
        if (entry.includes('\0')) {
            throw new Error(`shell-exec: args[${idx}] contains NUL character`);
        }
        return entry;
    });
}

function parseTimeoutMs(raw: unknown): number {
    const seconds = raw === undefined || raw === null
        ? 300
        : typeof raw === 'number'
            ? raw
            : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`shell-exec: timeout_seconds must be a positive number (got ${JSON.stringify(raw)})`);
    }
    return seconds * 1000;
}

function parseMaxBytes(raw: unknown): number {
    const bytes = raw === undefined || raw === null
        ? 10 * 1024 * 1024
        : typeof raw === 'number'
            ? raw
            : Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(`shell-exec: max_output_bytes must be a positive number (got ${JSON.stringify(raw)})`);
    }
    return bytes;
}

/** Merge user-supplied env over process.env. PATH is inherited so
 *  commands like `npm`/`cargo` resolve naturally; the user can override
 *  it by including PATH in their map. */
function buildEnv(raw: unknown): NodeJS.ProcessEnv {
    const base = { ...process.env };
    if (raw === undefined || raw === null) return base;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`shell-exec: env must be an object (got ${Array.isArray(raw) ? 'array' : typeof raw})`);
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`shell-exec: env key ${JSON.stringify(key)} is not a valid identifier`);
        }
        if (typeof value !== 'string') {
            throw new Error(`shell-exec: env[${JSON.stringify(key)}] must be a string (got ${typeof value})`);
        }
        if (value.includes('\0')) {
            throw new Error(`shell-exec: env[${JSON.stringify(key)}] contains NUL character`);
        }
        base[key] = value;
    }
    return base;
}
