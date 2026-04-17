import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    clearRuntimeState,
    listRuntimeStates,
    persistRuntimeState,
    pruneStaleRuntimeStates,
    runtimeStateDir,
} from '../server/discovery.js';

// Redirect homedir() to a per-test temp directory so we don't touch
// the real ~/.sokuza/ on the developer's machine.
let sandbox: string;
const realHomedir = process.env.HOME;

beforeEach(async () => {
    sandbox = join(tmpdir(), `sokuza-state-test-${process.pid}-${Date.now()}`);
    await mkdir(sandbox, { recursive: true });
    process.env.HOME = sandbox;
});

afterEach(async () => {
    process.env.HOME = realHomedir;
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

// os.homedir() caches on some platforms, so we exercise it via the module's
// runtimeStateDir() helper which calls homedir() fresh each time.

describe('persistRuntimeState', () => {
    it('writes <pid>.json into the per-instance directory', async () => {
        const file = await persistRuntimeState(24847, '127.0.0.1');
        expect(file).toBe(join(runtimeStateDir(), `${process.pid}.json`));

        const body = JSON.parse(await readFile(file, 'utf-8'));
        expect(body).toMatchObject({
            app: 'sokuza',
            port: 24847,
            host: '127.0.0.1',
            pid: process.pid,
        });
        expect(typeof body.startedAt).toBe('string');
        expect(typeof body.version).toBe('string');
    });

    it('writes with 0600 so other local users cannot read the pid', async () => {
        if (process.platform === 'win32') return; // Windows ACLs differ
        const file = await persistRuntimeState(24847, '127.0.0.1');
        const { statSync } = await import('node:fs');
        const mode = statSync(file).mode & 0o777;
        expect(mode).toBe(0o600);
    });
});

describe('clearRuntimeState', () => {
    it('removes the file and is idempotent', async () => {
        const file = await persistRuntimeState(24847, '127.0.0.1');
        await clearRuntimeState(file);
        await clearRuntimeState(file); // second call should not throw
    });
});

describe('pruneStaleRuntimeStates', () => {
    it('removes files whose pid is no longer running', async () => {
        const dir = runtimeStateDir();
        await mkdir(dir, { recursive: true });

        // Write a state file for a pid that definitely doesn't exist.
        // Pid 999_999_999 is above Linux's 4M/ulimit and any realistic OS pid.
        const deadFile = join(dir, '999999999.json');
        await writeFile(deadFile, JSON.stringify({ app: 'sokuza', pid: 999_999_999 }));

        // Also write one for our own pid — must be preserved.
        const aliveFile = await persistRuntimeState(24847, '127.0.0.1');

        const pruned = await pruneStaleRuntimeStates();
        expect(pruned).toBeGreaterThanOrEqual(1);

        // Dead file should be gone, our file should remain.
        const { existsSync } = await import('node:fs');
        expect(existsSync(deadFile)).toBe(false);
        expect(existsSync(aliveFile)).toBe(true);
    });

    it('never deletes the current process\'s own state file', async () => {
        const file = await persistRuntimeState(24847, '127.0.0.1');
        await pruneStaleRuntimeStates();
        const { existsSync } = await import('node:fs');
        expect(existsSync(file)).toBe(true);
    });

    it('returns 0 when the directory does not exist', async () => {
        const pruned = await pruneStaleRuntimeStates();
        expect(pruned).toBe(0);
    });

    it('ignores files with non-numeric names', async () => {
        const dir = runtimeStateDir();
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'README.md'), '# not a state file\n');
        await writeFile(join(dir, 'abc.json'), '{"app":"sokuza"}');

        await expect(pruneStaleRuntimeStates()).resolves.toBe(0);

        // Non-matching files remain.
        const { existsSync } = await import('node:fs');
        expect(existsSync(join(dir, 'README.md'))).toBe(true);
        expect(existsSync(join(dir, 'abc.json'))).toBe(true);
    });
});

describe('listRuntimeStates', () => {
    it('returns only live instances with the sokuza app marker', async () => {
        const dir = runtimeStateDir();
        await mkdir(dir, { recursive: true });

        // Live: this process
        await persistRuntimeState(24847, '127.0.0.1');

        // Dead: impossible pid
        await writeFile(
            join(dir, '999999998.json'),
            JSON.stringify({ app: 'sokuza', pid: 999_999_998, port: 1, host: 'x', version: 'x', startedAt: '' }),
        );

        // Wrong app
        await writeFile(
            join(dir, `${process.pid + 1}.json`),
            JSON.stringify({ app: 'somethingelse', pid: process.pid }),
        );

        const states = await listRuntimeStates();
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({ app: 'sokuza', pid: process.pid });
    });

    it('returns [] when the directory does not exist', async () => {
        await expect(listRuntimeStates()).resolves.toEqual([]);
    });
});
