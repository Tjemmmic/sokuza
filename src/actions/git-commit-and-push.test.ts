import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ActionContext } from '../core/types.js';
import { gitCommitAndPushAction } from './git-commit-and-push.js';

const logger = pino({ level: 'silent' });

function ctx(): ActionContext {
    return {
        event: { source: 'manual', event: 'manual', timestamp: '2026-05-04T00:00:00Z', payload: {}, metadata: {} },
        results: {}, steps: {}, integrationConfigs: {},
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger, workflowName: 'test',
    } as unknown as ActionContext;
}

function git(cwd: string, ...args: string[]): string {
    const out = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.toString()}`);
    return out.stdout.toString().trim();
}

let workdir: string;
let remote: string;

beforeEach(async () => {
    // Set up a bare "remote" + a clone we'll commit into.
    remote = await mkdtemp(join(tmpdir(), 'sokuza-remote-'));
    workdir = await mkdtemp(join(tmpdir(), 'sokuza-clone-'));
    git(remote, 'init', '--bare', '-b', 'main');
    git(workdir, 'init', '-b', 'main');
    git(workdir, 'config', 'user.email', 'test@example.com');
    git(workdir, 'config', 'user.name', 'Test');
    git(workdir, 'remote', 'add', 'origin', remote);
    await writeFile(join(workdir, 'README.md'), '# initial\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-m', 'initial');
    git(workdir, 'push', '-u', 'origin', 'main');
});

afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
});

describe('git-commit-and-push', () => {
    it('commits and pushes when there are changes on the current branch', async () => {
        await writeFile(join(workdir, 'new.txt'), 'hello\n');
        const result = await gitCommitAndPushAction({ workdir, message: 'add new.txt' }, ctx());
        expect(result.pushed).toBe(true);
        expect(result.hasChanges).toBe(true);
        expect(result.branch).toBe('main');
        expect(typeof result.sha).toBe('string');
        expect((result.sha as string).length).toBeGreaterThan(7);
        // Verify the remote actually received it.
        const remoteLog = git(remote, 'log', '--format=%s', 'main');
        expect(remoteLog).toContain('add new.txt');
    });

    it('exits cleanly with hasChanges=false when there is nothing to commit', async () => {
        const result = await gitCommitAndPushAction({ workdir, message: 'noop' }, ctx());
        expect(result.pushed).toBe(false);
        expect(result.hasChanges).toBe(false);
        expect(result.sha).toBe('');
    });

    it('checks out a new branch when one is supplied and pushes there', async () => {
        await writeFile(join(workdir, 'feature.txt'), 'work\n');
        const result = await gitCommitAndPushAction(
            { workdir, message: 'feature work', branch: 'feat/x' },
            ctx(),
        );
        expect(result.branch).toBe('feat/x');
        expect(result.pushed).toBe(true);
        const remoteBranches = git(remote, 'branch', '--list');
        expect(remoteBranches).toContain('feat/x');
    });

    it('only stages the requested paths when "paths" is supplied', async () => {
        await writeFile(join(workdir, 'a.txt'), 'a\n');
        await writeFile(join(workdir, 'b.txt'), 'b\n');
        await gitCommitAndPushAction({ workdir, message: 'just a', paths: ['a.txt'] }, ctx());
        const remoteFiles = git(remote, 'ls-tree', '--name-only', '-r', 'main');
        expect(remoteFiles).toContain('a.txt');
        expect(remoteFiles).not.toContain('b.txt');
    });

    it('errors when workdir or message is missing', async () => {
        await expect(gitCommitAndPushAction({}, ctx())).rejects.toThrow(/workdir is required/);
        await expect(gitCommitAndPushAction({ workdir }, ctx())).rejects.toThrow(/message is required/);
    });
});
