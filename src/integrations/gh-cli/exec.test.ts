import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { ghExec, ghJson, ghText } from './exec.js';

const mockedSpawn = vi.mocked(spawn);

function makeChildProcess(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: Error;
}) {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
    };

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    child.kill = vi.fn();

    mockedSpawn.mockReturnValue(child as any);

    setImmediate(() => {
        if (opts.error) {
            child.emit('error', opts.error);
            return;
        }
        if (opts.stdout) {
            child.stdout.emit('data', Buffer.from(opts.stdout));
        }
        if (opts.stderr) {
            child.stderr.emit('data', Buffer.from(opts.stderr));
        }
        child.emit('close', opts.exitCode ?? 0);
    });

    return child;
}

describe('ghExec', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns stdout, stderr, and exitCode on success', async () => {
        makeChildProcess({ stdout: 'hello world', stderr: '', exitCode: 0 });

        const result = await ghExec(['api', 'repos/owner/repo']);

        expect(result).toEqual({
            stdout: 'hello world',
            stderr: '',
            exitCode: 0,
        });
        expect(mockedSpawn).toHaveBeenCalledWith('gh', ['api', 'repos/owner/repo'], expect.anything());
    });

    it('returns result with non-zero exit code without throwing', async () => {
        makeChildProcess({ stdout: '', stderr: 'not found', exitCode: 1 });

        const result = await ghExec(['api', 'bad-path']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('not found');
    });

    it('rejects with timeout error when process exceeds timeout', async () => {
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
            kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
        child.kill = vi.fn();

        mockedSpawn.mockReturnValue(child as any);

        vi.useFakeTimers();
        try {
            const promise = ghExec(['api', 'slow'], { timeout: 100 });
            vi.advanceTimersByTime(150);
            await expect(promise).rejects.toThrow('timed out after 100ms');
            expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        } finally {
            vi.useRealTimers();
        }
    });

    it('pipes stdin when opts.stdin is provided', async () => {
        const child = makeChildProcess({ exitCode: 0 });

        await ghExec(['api', 'endpoint'], { stdin: 'payload' });

        expect(child.stdin.write).toHaveBeenCalledWith('payload');
        expect(child.stdin.end).toHaveBeenCalled();
    });
});

describe('ghJson', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses valid JSON output', async () => {
        makeChildProcess({
            stdout: JSON.stringify([{ id: 1, title: 'test' }]),
            exitCode: 0,
        });

        const result = await ghJson<Array<{ id: number }>>(['api', 'repos/owner/repo/issues']);

        expect(result).toEqual([{ id: 1, title: 'test' }]);
    });

    it('throws on invalid JSON output', async () => {
        makeChildProcess({ stdout: 'not json at all', exitCode: 0 });

        await expect(ghJson(['api', 'bad-json'])).rejects.toThrow('invalid JSON output');
    });

    it('throws with stderr when exit code is non-zero', async () => {
        makeChildProcess({ stdout: '', stderr: 'resource not found', exitCode: 1 });

        await expect(ghJson(['api', 'bad'])).rejects.toThrow('resource not found');
    });

    it('returns empty array for empty output', async () => {
        makeChildProcess({ stdout: '', exitCode: 0 });

        const result = await ghJson(['api', 'empty-endpoint']);

        expect(result).toEqual([]);
    });
});

describe('ghText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns stdout string on success', async () => {
        makeChildProcess({ stdout: 'v2.40.0\n', exitCode: 0 });

        const result = await ghText(['--version']);

        expect(result).toBe('v2.40.0\n');
    });

    it('throws with stderr on non-zero exit', async () => {
        makeChildProcess({ stdout: '', stderr: 'command failed badly', exitCode: 1 });

        await expect(ghText(['bad', 'args'])).rejects.toThrow('command failed badly');
    });
});
