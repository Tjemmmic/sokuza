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

    // ── H4: branch-switch hardening ────────────────────────────────────────
    it('checks out an existing local branch instead of failing with "already exists" (H4)', async () => {
        // Create the branch on the remote first so a re-attempt is plausible.
        git(workdir, 'branch', 'feat/existing');
        await writeFile(join(workdir, 'work.txt'), 'work\n');
        const result = await gitCommitAndPushAction(
            { workdir, message: 'on existing branch', branch: 'feat/existing' },
            ctx(),
        );
        expect(result.branch).toBe('feat/existing');
        expect(result.pushed).toBe(true);
    });

    it('surfaces the original git error when checkout fails on a dirty tree (H4)', async () => {
        // Set up two branches with different content for README.md, then
        // dirty the worktree on main with a conflicting unstaged edit.
        git(workdir, 'checkout', '-b', 'feat/conflict');
        await writeFile(join(workdir, 'README.md'), '# conflict version\n');
        git(workdir, 'commit', '-am', 'conflict version');
        git(workdir, 'checkout', 'main');
        await writeFile(join(workdir, 'README.md'), '# unstaged dirty\n');
        // Asking the action to switch to feat/conflict should surface git's
        // real error rather than masking it with a misleading 'already exists'.
        await expect(gitCommitAndPushAction(
            { workdir, message: 'noop', branch: 'feat/conflict' },
            ctx(),
        )).rejects.toThrow(/checkout failed.*would be overwritten|Your local changes/);
    });

    // ── M4: paths validation ───────────────────────────────────────────────
    it('rejects an absolute path in paths (M4)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['/etc/passwd'] },
            ctx(),
        )).rejects.toThrow(/absolute paths are not allowed/);
    });

    it('rejects a path containing .. (M4)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['../escape'] },
            ctx(),
        )).rejects.toThrow(/escapes workdir/);
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['sub/../../escape'] },
            ctx(),
        )).rejects.toThrow(/escapes workdir/);
    });

    it('rejects a path containing NUL (M4)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['ok\0bad'] },
            ctx(),
        )).rejects.toThrow(/NUL character/);
    });

    it('rejects an empty paths array rather than silently falling back to add -A (M4)', async () => {
        await writeFile(join(workdir, 'should-not-be-added.txt'), 'x\n');
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: [] },
            ctx(),
        )).rejects.toThrow(/paths array was empty/);
    });

    it('rejects a path containing backslash that would escape on Windows (H7)', async () => {
        // Plain "..\escape" → normalises to "../escape" → escapes.
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['..\\escape'] },
            ctx(),
        )).rejects.toThrow(/escapes workdir/);
        // Two parents up — "sub\..\..\escape" reduces to "../escape" → escapes.
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['sub\\..\\..\\escape'] },
            ctx(),
        )).rejects.toThrow(/escapes workdir/);
    });

    it('rejects an absolute Windows-style path (H7)', async () => {
        // C:\... is absolute on Windows; on Linux Node sees it as relative,
        // but our backslash normalisation should still flag it.
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: ['/etc\\passwd'] },
            ctx(),
        )).rejects.toThrow(/absolute paths are not allowed/);
    });

    // ── M9: branch name validation ─────────────────────────────────────────
    it('rejects a branch name starting with "-" (would be parsed as a flag) (M9)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', branch: '-foo' },
            ctx(),
        )).rejects.toThrow(/must not start with "-"/);
    });

    it('rejects a branch literally named HEAD (M9)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', branch: 'HEAD' },
            ctx(),
        )).rejects.toThrow(/"HEAD" is reserved/);
    });

    it('rejects a branch name containing whitespace (M9)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', branch: 'feat with space' },
            ctx(),
        )).rejects.toThrow(/whitespace/);
    });

    it('rejects a branch name with control characters (M9)', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', branch: 'feat\x01x' },
            ctx(),
        )).rejects.toThrow(/control characters/);
    });

    // ── L8: paths='' / paths=[] consistency ───────────────────────────────
    it('rejects empty/whitespace-only paths string (L8 — consistent with [])', async () => {
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: '' },
            ctx(),
        )).rejects.toThrow(/string was empty/);
        await expect(gitCommitAndPushAction(
            { workdir, message: 'm', paths: '   ,  ' },
            ctx(),
        )).rejects.toThrow(/string was empty/);
    });

    it('accepts a comma-separated string for paths (M4)', async () => {
        await writeFile(join(workdir, 'a.txt'), 'a\n');
        await writeFile(join(workdir, 'b.txt'), 'b\n');
        await writeFile(join(workdir, 'c.txt'), 'c\n');
        await gitCommitAndPushAction(
            { workdir, message: 'comma form', paths: 'a.txt, b.txt' },
            ctx(),
        );
        const remoteFiles = git(remote, 'ls-tree', '--name-only', '-r', 'main');
        expect(remoteFiles).toContain('a.txt');
        expect(remoteFiles).toContain('b.txt');
        expect(remoteFiles).not.toContain('c.txt');
    });
});
