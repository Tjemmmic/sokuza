import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
    parseRepoFromRemote,
    gatherPrContext,
    getReviewFindings,
    dispatchTool,
    TOOLS,
    type EngineBridge,
    type GitRunner,
} from '../core/mcp-server.js';
import { recordAiReviewRun, type AiReviewRunRecord } from '../core/run-store.js';

const logger = pino({ level: 'silent' });

function reviewRecord(overrides: Partial<AiReviewRunRecord> = {}): AiReviewRunRecord {
    return {
        id: overrides.id ?? 'run-1',
        action: 'ai-review',
        createdAt: overrides.createdAt ?? '2026-05-01T10:00:00.000Z',
        durationMs: 1000,
        workflowName: 'ai-pr-review',
        event: { source: 'github', event: 'pull_request.opened', repo: 'org/repo', prNumber: 7, ...overrides.event },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        strategy: 'truncate',
        input: { diffSource: 'full', diffBytes: 10, diffSha1: 'abc', incompleteFiles: [] },
        truncation: {
            triggered: false, originalChars: 0, finalChars: 0,
            totalFiles: 0, fullyIncludedFiles: 0, truncatedFiles: 0, skippedFiles: 0, files: [],
        },
        output: {
            parseSucceeded: true,
            decision: 'request_changes',
            issueCount: 1,
            issues: [{ priority: 'P1', title: 'Null deref', file: 'a.ts', problem: 'boom', fix: 'guard it' }],
            reviewChars: 100,
        },
        ...overrides,
    } as AiReviewRunRecord;
}

describe('parseRepoFromRemote', () => {
    it('parses ssh, https and bare forms', () => {
        expect(parseRepoFromRemote('git@github.com:org/repo.git')).toBe('org/repo');
        expect(parseRepoFromRemote('https://github.com/org/repo.git')).toBe('org/repo');
        expect(parseRepoFromRemote('https://github.com/org/repo')).toBe('org/repo');
        expect(parseRepoFromRemote('ssh://git@github.com/org/repo.git')).toBe('org/repo');
    });
    it('returns null for empty input', () => {
        expect(parseRepoFromRemote('')).toBeNull();
    });
});

describe('gatherPrContext', () => {
    const fakeGit: GitRunner = async (args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --abbrev-ref HEAD') return 'feature/x';
        if (key === 'remote get-url origin') return 'git@github.com:org/repo.git';
        if (key === 'rev-parse HEAD') return 'deadbeef';
        if (key === 'log -1 --pretty=%s') return 'do a thing';
        if (key === 'log -1 --pretty=%an') return 'Ada';
        throw new Error('unexpected git call');
    };

    it('assembles repo / branch / commit', async () => {
        const ctx = await gatherPrContext('/tmp/x', fakeGit);
        expect(ctx).toMatchObject({
            repository: 'org/repo',
            branch: 'feature/x',
            commit: { sha: 'deadbeef', subject: 'do a thing', author: 'Ada' },
        });
    });

    it('reports null branch for a detached HEAD and tolerates git failures', async () => {
        const detached: GitRunner = async (args) => {
            if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
            throw new Error('no remote');
        };
        const ctx = await gatherPrContext('/tmp/x', detached);
        expect(ctx.branch).toBeNull();
        expect(ctx.repository).toBeNull();
        expect(ctx.commit).toBeNull();
    });
});

describe('getReviewFindings', () => {
    let baseDir: string;
    beforeEach(async () => { baseDir = await mkdtemp(join(tmpdir(), 'sokuza-runs-')); });
    afterEach(async () => { await rm(baseDir, { recursive: true, force: true }); });

    it('returns issues filtered by repo + prNumber', async () => {
        await recordAiReviewRun(reviewRecord({ id: 'run-1' }), logger, baseDir);
        await recordAiReviewRun(reviewRecord({
            id: 'run-2',
            event: { source: 'github', event: 'pull_request.opened', repo: 'org/repo', prNumber: 99 },
        }), logger, baseDir);

        const res = await getReviewFindings({ repo: 'org/repo', prNumber: 7 }, baseDir);
        expect(res.runs).toHaveLength(1);
        expect(res.runs[0].runId).toBe('run-1');
        expect(res.runs[0].issues?.[0]?.title).toBe('Null deref');
    });

    it('looks up a single run by id', async () => {
        await recordAiReviewRun(reviewRecord({ id: 'run-xyz' }), logger, baseDir);
        const res = await getReviewFindings({ runId: 'run-xyz' }, baseDir);
        expect(res.runs).toHaveLength(1);
        expect(res.runs[0].runId).toBe('run-xyz');
    });

    it('returns empty for an unknown run id', async () => {
        const res = await getReviewFindings({ runId: 'missing' }, baseDir);
        expect(res.runs).toHaveLength(0);
    });
});

describe('dispatchTool', () => {
    const okBridge: EngineBridge = {
        available: async () => true,
        reportStatus: async () => undefined,
        ask: async (prompt) => `answer to: ${prompt}`,
    };
    const fakeGit: GitRunner = async (args) =>
        args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'main' : (() => { throw new Error('x'); })();

    const deps = (over: Partial<Parameters<typeof dispatchTool>[2]> = {}) => ({
        cwd: '/tmp', git: fakeGit, bridge: okBridge, ...over,
    });

    it('exposes the four documented tools', () => {
        expect(TOOLS.map((t) => t.name).sort()).toEqual([
            'sokuza_ask_human', 'sokuza_get_pr_context', 'sokuza_get_review_findings', 'sokuza_report_status',
        ]);
    });

    it('dispatches get_pr_context', async () => {
        const res = await dispatchTool('sokuza_get_pr_context', {}, deps());
        expect(res.isError).toBeFalsy();
        const text = (res.content[0] as { text: string }).text;
        expect(JSON.parse(text).branch).toBe('main');
    });

    it('report_status requires a message', async () => {
        const res = await dispatchTool('sokuza_report_status', {}, deps());
        expect(res.isError).toBe(true);
    });

    it('report_status forwards to the bridge', async () => {
        let got: unknown;
        const bridge: EngineBridge = { ...okBridge, reportStatus: async (i) => { got = i; } };
        const res = await dispatchTool('sokuza_report_status', { message: 'hi', level: 'warn' }, deps({ bridge }));
        expect(res.isError).toBeFalsy();
        expect(got).toMatchObject({ message: 'hi', level: 'warn' });
    });

    it('ask_human returns the human answer', async () => {
        const res = await dispatchTool('sokuza_ask_human', { prompt: 'go?' }, deps());
        const text = (res.content[0] as { text: string }).text;
        expect(JSON.parse(text).answer).toBe('answer to: go?');
    });

    it('surfaces bridge errors as tool errors', async () => {
        const bridge: EngineBridge = { ...okBridge, ask: async () => { throw new Error('no engine'); } };
        const res = await dispatchTool('sokuza_ask_human', { prompt: 'go?' }, deps({ bridge }));
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toMatch(/no engine/);
    });

    it('rejects an unknown tool', async () => {
        const res = await dispatchTool('nope', {}, deps());
        expect(res.isError).toBe(true);
    });
});
