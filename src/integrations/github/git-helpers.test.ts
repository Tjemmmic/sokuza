import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { execGit, execGitOutput } from './git-helpers.js';

const mockedSpawn = vi.mocked(spawn);

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

/** A child process whose stream/exit events the caller drives by hand. */
function makeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
}

/** Queue a child and, on the next tick, replay the given streams + exit. */
function scriptChild(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: Error;
}): FakeChild {
    const child = makeChild();
    mockedSpawn.mockReturnValueOnce(child as never);
    setImmediate(() => {
        if (opts.error) {
            child.emit('error', opts.error);
            return;
        }
        if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
        if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
        child.emit('close', opts.exitCode ?? 0);
    });
    return child;
}

describe('execGit', () => {
    beforeEach(() => vi.clearAllMocks());

    it('resolves on a zero exit code', async () => {
        scriptChild({ exitCode: 0 });
        await expect(execGit('/repo', ['fetch', 'origin'])).resolves.toBeUndefined();
        expect(mockedSpawn).toHaveBeenCalledWith(
            'git',
            ['fetch', 'origin'],
            expect.objectContaining({ cwd: '/repo' }),
        );
    });

    it('rejects with the captured stderr on a non-zero exit', async () => {
        scriptChild({ stderr: 'fatal: not a git repository', exitCode: 128 });
        await expect(execGit('/repo', ['status'])).rejects.toThrow(
            'git status failed (code 128): fatal: not a git repository',
        );
    });

    it('rejects with an empty stderr segment when git writes nothing', async () => {
        scriptChild({ exitCode: 1 });
        await expect(execGit('/repo', ['commit'])).rejects.toThrow('git commit failed (code 1): ');
    });

    it('propagates a spawn error (e.g. git binary missing)', async () => {
        const spawnErr = new Error('spawn git ENOENT');
        scriptChild({ error: spawnErr });
        await expect(execGit('/repo', ['push'])).rejects.toBe(spawnErr);
    });
});

describe('execGitOutput', () => {
    beforeEach(() => vi.clearAllMocks());

    it('resolves with stdout on success', async () => {
        scriptChild({ stdout: 'feature-branch\n', exitCode: 0 });
        await expect(execGitOutput('/repo', ['branch', '--show-current'])).resolves.toBe(
            'feature-branch\n',
        );
    });

    it('concatenates chunked stdout', async () => {
        const child = makeChild();
        mockedSpawn.mockReturnValueOnce(child as never);
        const promise = execGitOutput('/repo', ['log']);
        child.stdout.emit('data', Buffer.from('abc'));
        child.stdout.emit('data', Buffer.from('def'));
        child.emit('close', 0);
        await expect(promise).resolves.toBe('abcdef');
    });

    it('rejects with stderr and ignores partial stdout on a non-zero exit', async () => {
        scriptChild({ stdout: 'partial', stderr: 'fatal: bad revision', exitCode: 128 });
        await expect(execGitOutput('/repo', ['rev-parse', 'HEAD'])).rejects.toThrow(
            'git rev-parse failed (code 128): fatal: bad revision',
        );
    });

    it('propagates a spawn error', async () => {
        const spawnErr = new Error('spawn git EACCES');
        scriptChild({ error: spawnErr });
        await expect(execGitOutput('/repo', ['fetch'])).rejects.toBe(spawnErr);
    });

    it('keeps stderr buffers isolated across concurrent calls', async () => {
        const a = makeChild();
        const b = makeChild();
        mockedSpawn.mockReturnValueOnce(a as never).mockReturnValueOnce(b as never);

        const pa = execGitOutput('/repo-a', ['fetch']);
        const pb = execGitOutput('/repo-b', ['fetch']);

        a.stderr.emit('data', Buffer.from('error from A'));
        b.stdout.emit('data', Buffer.from('B ok'));
        b.emit('close', 0);
        a.emit('close', 2);

        await expect(pb).resolves.toBe('B ok');
        await expect(pa).rejects.toThrow('git fetch failed (code 2): error from A');
    });
});

// ── abort signal: long git operations (push, clone) must die when the
// workflow signal fires. Without this, a slow push outlives the
// runtime's per-node timeout and may succeed after the workflow has
// already been declared aborted.
describe('abort signal', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects immediately when execGit is called with an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(execGit('/repo', ['push'], controller.signal)).rejects.toThrow(/Workflow aborted/);
        expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('rejects immediately when execGitOutput is called with an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(execGitOutput('/repo', ['log'], controller.signal)).rejects.toThrow(/Workflow aborted/);
        expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('SIGTERMs the child and rejects with "Workflow aborted" when the signal fires mid-execution', async () => {
        const child = makeChild();
        const kill = vi.fn();
        (child as unknown as { kill: typeof kill }).kill = kill;
        mockedSpawn.mockReturnValueOnce(child as never);
        const controller = new AbortController();
        const promise = execGit('/repo', ['push', 'origin', 'main'], controller.signal);
        // The signal fires while git is still running.
        controller.abort();
        await expect(promise).rejects.toThrow(/Workflow aborted/);
        expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does not reject the promise twice when the child later emits "close" after an abort', async () => {
        const child = makeChild();
        (child as unknown as { kill: () => void }).kill = () => undefined;
        mockedSpawn.mockReturnValueOnce(child as never);
        const controller = new AbortController();
        const promise = execGit('/repo', ['push'], controller.signal);
        controller.abort();
        // Simulate the SIGTERM landing and the child exiting after the
        // abort — the promise must still settle exactly once.
        setImmediate(() => child.emit('close', 143));
        await expect(promise).rejects.toThrow(/Workflow aborted/);
    });

    it('removes the abort listener on normal completion so signals are not retained', async () => {
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
        scriptChild({ exitCode: 0 });
        await execGit('/repo', ['status'], controller.signal);
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
