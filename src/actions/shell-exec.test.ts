import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '../core/types.js';
import { shellExecAction } from './shell-exec.js';

const logger = pino({ level: 'silent' });

function ctx(signal?: AbortSignal): ActionContext {
    return {
        event: { source: 'manual', event: 'manual', timestamp: '2026-05-20T00:00:00Z', payload: {}, metadata: {} },
        results: {}, steps: {}, integrationConfigs: {},
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger, workflowName: 'test',
        signal,
    } as unknown as ActionContext;
}

let workdir: string;

beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sokuza-shell-exec-'));
});

afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
});

type Output = {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
};

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('shell-exec — shell mode', () => {
    it('captures stdout, exit code 0, success=true', async () => {
        const result = await shellExecAction(
            { workdir, command: 'echo hello world' },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).toBe('hello world');
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
        expect(result.success).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.truncated).toBe(false);
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('captures stderr independently from stdout', async () => {
        const result = await shellExecAction(
            { workdir, command: 'echo stdout-line; echo stderr-line >&2' },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).toBe('stdout-line');
        expect(result.stderr.trim()).toBe('stderr-line');
        expect(result.success).toBe(true);
    });

    it('reports non-zero exit without throwing — success=false, exitCode preserved', async () => {
        // Per the action's contract: tests that fail are *data*, not
        // workflow errors. The user wires success/exitCode into flow.if.
        const result = await shellExecAction(
            { workdir, command: 'exit 7' },
            ctx(),
        ) as Output;
        expect(result.exitCode).toBe(7);
        expect(result.success).toBe(false);
        expect(result.timedOut).toBe(false);
    });

    it('cwd is the supplied workdir (not the test runner cwd)', async () => {
        // Drop a marker file in the temp workdir and have the shell
        // exec `ls`. If cwd is wrong, the marker won't appear.
        await writeFile(join(workdir, 'marker.txt'), '');
        const result = await shellExecAction(
            { workdir, command: 'ls' },
            ctx(),
        ) as Output;
        expect(result.stdout).toContain('marker.txt');
    });

    it('inherits PATH so `npm`/`node` etc. resolve naturally', async () => {
        // `node` should be on PATH; if env-merging accidentally cleared
        // PATH, this would ENOENT instead of returning 0.
        const result = await shellExecAction(
            { workdir, command: 'node --version' },
            ctx(),
        ) as Output;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^v\d+/);
    });
});

// ─── Exec mode (no shell) ───────────────────────────────────────────────────

describe('shell-exec — exec mode (args supplied)', () => {
    it('treats command as the executable and args as argv (no shell parsing)', async () => {
        const result = await shellExecAction(
            { workdir, command: 'echo', args: ['a', 'b c', '$NOT_EXPANDED'] },
            ctx(),
        ) as Output;
        // Without shell, `$NOT_EXPANDED` reaches echo verbatim because
        // there's no shell to interpolate it. Spaces in 'b c' stay one arg.
        expect(result.stdout.trim()).toBe('a b c $NOT_EXPANDED');
    });

    it('accepts comma-separated args string for one-liner workflows', async () => {
        const result = await shellExecAction(
            { workdir, command: 'echo', args: 'one,two,three' },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).toBe('one two three');
    });

    it('empty args array still triggers exec mode (no shell)', async () => {
        // `command: "echo $HOME, args: []` must NOT expand $HOME because
        // exec mode bypasses the shell. This is the test for the flip
        // — args=[] vs args=undefined must produce different behavior.
        const result = await shellExecAction(
            { workdir, command: 'echo', args: [] },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).toBe('');
    });

    it('shell mode WOULD expand $HOME — pins the mode difference', async () => {
        // Sanity check the exec-mode test above: in shell mode, the
        // shell DOES expand $HOME. If this fails the test runner has a
        // weird $HOME; either way the two tests together prove the
        // shell vs exec mode flip is real.
        const result = await shellExecAction(
            { workdir, command: 'echo $HOME' },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).not.toBe('$HOME');
        expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it('throws on spawn failure (ENOENT) — distinguishes misconfig from data', async () => {
        // Spawn errors are NOT data — `command: this-binary-does-not-exist`
        // is a workflow misconfiguration that should surface loudly.
        // Non-zero exit returns; ENOENT throws.
        await expect(
            shellExecAction(
                { workdir, command: '/nonexistent/binary-' + Math.random(), args: [] },
                ctx(),
            ),
        ).rejects.toThrow();
    });
});

// ─── Timeout ────────────────────────────────────────────────────────────────

describe('shell-exec — timeout', () => {
    // Explicit per-test timeout: the SIGKILL backstop is 1.5s, so even
    // worst-case (CI under load where SIGTERM doesn't take immediately
    // and we end up waiting for SIGKILL) settles well under 15s. The
    // default 5s vitest timeout was too tight when SIGTERM was delayed.
    it('SIGTERMs the child at timeout and reports timedOut=true', { timeout: 15000 }, async () => {
        const result = await shellExecAction(
            { workdir, command: 'sleep 5', timeout_seconds: 0.3 },
            ctx(),
        ) as Output;
        // timedOut must be true; exitCode is -1 (signal-terminated, not
        // a numeric process exit); success is false.
        expect(result.timedOut).toBe(true);
        expect(result.success).toBe(false);
        // The child gets SIGTERM at the deadline; the test ran for at
        // least the timeout interval but well under the configured 5s
        // sleep — proves we actually killed it, didn't just wait it out.
        expect(result.durationMs).toBeGreaterThanOrEqual(250);
        expect(result.durationMs).toBeLessThan(5000);
    });

    it('kills the whole process tree, not just the shell PID', { timeout: 15000 }, async () => {
        // Regression test for the CI failure where `sh -c "sleep 5"` on
        // dash (Ubuntu /bin/sh) forks sleep rather than exec'ing it.
        // SIGTERM to the shell PID alone leaves sleep alive holding the
        // stdio pipes, so Node's close event waits for sleep's natural
        // 5s exit. Solution: spawn detached + process-group kill.
        //
        // The `sleep 5 & wait` pattern guarantees the fork+wait
        // scenario regardless of which shell /bin/sh is, so this
        // exercises the problematic path on every platform — not just
        // Ubuntu CI.
        const result = await shellExecAction(
            { workdir, command: 'sleep 5 & wait', timeout_seconds: 0.3 },
            ctx(),
        ) as Output;
        expect(result.timedOut).toBe(true);
        // Must have killed the orphan: total wall-clock well under
        // sleep's 5s. Without the process-group fix, duration would
        // be ~5003ms (sleep's natural completion).
        expect(result.durationMs).toBeLessThan(3000);
    });

    it('rejects timeout_seconds <= 0', async () => {
        await expect(
            shellExecAction(
                { workdir, command: 'echo hi', timeout_seconds: 0 },
                ctx(),
            ),
        ).rejects.toThrow(/timeout_seconds.*positive/);

        await expect(
            shellExecAction(
                { workdir, command: 'echo hi', timeout_seconds: -1 },
                ctx(),
            ),
        ).rejects.toThrow(/timeout_seconds.*positive/);
    });
});

// ─── Output cap ─────────────────────────────────────────────────────────────

describe('shell-exec — max_output_bytes', () => {
    it('truncates stdout at the cap and kills the child', { timeout: 15000 }, async () => {
        // `yes` produces "y\n" forever. With a 1KB cap the child gets
        // SIGTERM as soon as we cross it.
        const result = await shellExecAction(
            { workdir, command: 'yes', max_output_bytes: 1024, timeout_seconds: 10 },
            ctx(),
        ) as Output;
        expect(result.truncated).toBe(true);
        expect(result.success).toBe(false);
        // The cap is enforced on UTF-8 bytes (not UTF-16 code units),
        // so the assertion must use Buffer.byteLength too — otherwise
        // a future test-data change to include multi-byte UTF-8 would
        // silently weaken this test.
        expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
        // Should have terminated well under the 10s timeout — the cap,
        // not the timeout, is what killed it.
        expect(result.durationMs).toBeLessThan(5000);
    });

    it('caps total bytes across stdout + stderr (not per-stream)', { timeout: 15000 }, async () => {
        // Pin against the per-stream-tracking bug where stdout could
        // grow to maxBytes AND stderr could independently grow to
        // maxBytes (2× the documented limit). Run an in-shell loop
        // (no backgrounding) so SIGTERM to the shell halts the writers.
        const result = await shellExecAction(
            {
                workdir,
                command: 'while true; do echo stdout-line; echo stderr-line >&2; done',
                max_output_bytes: 2048,
                timeout_seconds: 10,
            },
            ctx(),
        ) as Output;
        expect(result.truncated).toBe(true);
        // The cap is enforced on UTF-8 bytes. Use Buffer.byteLength so
        // this test stays correct if test data ever includes multi-byte
        // characters — otherwise we'd be measuring UTF-16 code units
        // and could pass even with a per-stream tracking regression.
        const totalBytes =
            Buffer.byteLength(result.stdout, 'utf8') +
            Buffer.byteLength(result.stderr, 'utf8');
        expect(totalBytes).toBeLessThanOrEqual(2048);
    });
});

// ─── Env vars ───────────────────────────────────────────────────────────────

describe('shell-exec — env', () => {
    it('passes through user-supplied env vars (shell mode can expand them)', async () => {
        const result = await shellExecAction(
            { workdir, command: 'echo $MY_TEST_VAR', env: { MY_TEST_VAR: 'hello-env' } },
            ctx(),
        ) as Output;
        expect(result.stdout.trim()).toBe('hello-env');
    });

    it('rejects env keys that aren\'t valid shell-identifier names', async () => {
        // Shell scripts can read `$FOO`; an env entry like `1bad-key`
        // can't be referenced and is almost always a workflow typo.
        await expect(
            shellExecAction(
                { workdir, command: 'echo hi', env: { '1bad-key': 'x' } },
                ctx(),
            ),
        ).rejects.toThrow(/env key.*not a valid identifier/);
    });

    it('rejects env values containing NUL', async () => {
        await expect(
            shellExecAction(
                { workdir, command: 'echo hi', env: { GOOD_KEY: 'val\0ue' } },
                ctx(),
            ),
        ).rejects.toThrow(/NUL/);
    });
});

// ─── Workdir validation ─────────────────────────────────────────────────────

describe('shell-exec — workdir validation', () => {
    it('rejects missing workdir', async () => {
        await expect(
            shellExecAction({ command: 'echo hi' }, ctx()),
        ).rejects.toThrow(/workdir is required/);
    });

    it('rejects NUL in workdir', async () => {
        await expect(
            shellExecAction(
                { workdir: '/tmp/ok\0bad', command: 'echo hi' },
                ctx(),
            ),
        ).rejects.toThrow(/NUL/);
    });

    it('rejects control characters in workdir', async () => {
        await expect(
            shellExecAction(
                { workdir: '/tmp/ok\x07bell', command: 'echo hi' },
                ctx(),
            ),
        ).rejects.toThrow(/control/);
    });

    it('rejects leading "-" in workdir (would look like a flag)', async () => {
        await expect(
            shellExecAction(
                { workdir: '-something', command: 'echo hi' },
                ctx(),
            ),
        ).rejects.toThrow(/must not start with/);
    });

    it('rejects relative workdir paths', async () => {
        await expect(
            shellExecAction(
                { workdir: 'relative/path', command: 'echo hi' },
                ctx(),
            ),
        ).rejects.toThrow(/absolute path/);
    });

    it('rejects filesystem root', async () => {
        await expect(
            shellExecAction(
                { workdir: '/', command: 'echo hi' },
                ctx(),
            ),
        ).rejects.toThrow(/filesystem root/);
    });

    it('rejects sensitive system paths', async () => {
        // Same deny-list as git-commit-and-push — running shell
        // commands against /etc or /usr would let a malformed workflow
        // turn into arbitrary system manipulation.
        for (const denied of ['/etc', '/proc', '/sys', '/dev', '/usr/bin']) {
            await expect(
                shellExecAction(
                    { workdir: denied, command: 'echo hi' },
                    ctx(),
                ),
                `should reject ${denied}`,
            ).rejects.toThrow(/sensitive system path/);
        }
    });
});

// ─── Command validation ─────────────────────────────────────────────────────

describe('shell-exec — command validation', () => {
    it('rejects missing command', async () => {
        await expect(
            shellExecAction({ workdir }, ctx()),
        ).rejects.toThrow(/command is required/);
    });

    it('rejects NUL in command', async () => {
        await expect(
            shellExecAction(
                { workdir, command: 'echo hi\0evil' },
                ctx(),
            ),
        ).rejects.toThrow(/NUL/);
    });

    it('rejects args containing non-string entries', async () => {
        await expect(
            shellExecAction(
                { workdir, command: 'echo', args: ['ok', 42 as unknown as string] },
                ctx(),
            ),
        ).rejects.toThrow(/must be a string/);
    });
});

// ─── Abort signal ───────────────────────────────────────────────────────────

describe('shell-exec — abort signal', () => {
    it('throws abort error when signal is already aborted at call time', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(
            shellExecAction(
                { workdir, command: 'echo hi' },
                ctx(ac.signal),
            ),
        ).rejects.toThrow();
    });

    it('aborts a running child process when signal fires mid-execution', async () => {
        // Real concurrent abort: kick off a long sleep, fire the abort
        // after a brief delay. The action must reject (not resolve with
        // the eventual exit code) and the child must be SIGTERM'd.
        const ac = new AbortController();
        const start = Date.now();
        const promise = shellExecAction(
            { workdir, command: 'sleep 5', timeout_seconds: 60 },
            ctx(ac.signal),
        );
        setTimeout(() => ac.abort(), 100);
        await expect(promise).rejects.toThrow();
        const elapsed = Date.now() - start;
        // Should have rejected within a second or so — way under the 60s
        // timeout and the 5s sleep. Proves we actually killed it.
        expect(elapsed).toBeLessThan(2000);
    });
});
