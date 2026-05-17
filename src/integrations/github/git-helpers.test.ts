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
