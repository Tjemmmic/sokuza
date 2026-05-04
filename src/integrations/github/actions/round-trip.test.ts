import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';
import { githubFetchPrAction } from './fetch-pr.js';
import { githubFetchIssueAction } from './fetch-issue.js';
import { githubMergePrAction } from './merge-pr.js';
import { githubUpdatePrAction } from './update-pr.js';

const logger = pino({ level: 'silent' });

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: { pull_request: { number: 42 } },
            metadata: { repo: 'octo/r', owner: 'octo', repoName: 'r', prNumber: 42 },
        },
        results: {},
        steps: {},
        integrationConfigs: { github: { token: 'gh_test_token' } },
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
        ...overrides,
    } as unknown as ActionContext;
}

function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
    let i = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const handler = handlers[Math.min(i, handlers.length - 1)];
        i++;
        return handler(url);
    });
}

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('github-fetch-pr', () => {
    it('fetches the PR and returns the full object', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ number: 42, title: 'WIP', html_url: 'https://github.com/octo/r/pull/42' }), { status: 200 }),
        ]);
        const result = await githubFetchPrAction({ pr_number: 42, repo: 'octo/r' }, makeContext());
        expect(spy).toHaveBeenCalledTimes(1);
        const calledUrl = spy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('/repos/octo/r/pulls/42');
        expect(result.pr).toMatchObject({ number: 42, title: 'WIP' });
        expect(result.number).toBe(42);
        expect(result.repo).toBe('octo/r');
    });

    it('errors clearly when token is missing', async () => {
        const ctx = makeContext({ integrationConfigs: {} });
        const orig = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            await expect(githubFetchPrAction({ pr_number: 42, repo: 'octo/r' }, ctx)).rejects.toThrow(/token is required/);
        } finally {
            if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
        }
    });

    it('falls back to event metadata for owner/repo/number', async () => {
        const spy = mockFetch([() => new Response(JSON.stringify({ number: 42 }), { status: 200 })]);
        await githubFetchPrAction({}, makeContext());
        expect(spy.mock.calls[0][0]).toContain('/repos/octo/r/pulls/42');
    });
});

describe('github-fetch-issue', () => {
    it('fetches the issue', async () => {
        const spy = mockFetch([() => new Response(JSON.stringify({ number: 7, title: 'bug' }), { status: 200 })]);
        const result = await githubFetchIssueAction({ issue_number: 7, repo: 'octo/r' }, makeContext());
        expect(spy.mock.calls[0][0]).toContain('/repos/octo/r/issues/7');
        expect(result.issue).toMatchObject({ number: 7, title: 'bug' });
    });
});

describe('github-merge-pr', () => {
    it('PUTs to /pulls/:n/merge with the chosen method', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ merged: true, sha: 'abcdef', message: 'PR merged' }), { status: 200 }),
        ]);
        const result = await githubMergePrAction(
            { pr_number: 42, repo: 'octo/r', method: 'squash' },
            makeContext(),
        );
        const [url, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/repos/octo/r/pulls/42/merge');
        expect(init?.method).toBe('PUT');
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.merge_method).toBe('squash');
        expect(result).toMatchObject({ merged: true, sha: 'abcdef', method: 'squash' });
    });

    it('throws on a 405 (PR not mergeable)', async () => {
        mockFetch([() => new Response('not mergeable', { status: 405, statusText: 'Method Not Allowed' })]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/error merging PR: 405/);
    });
});

describe('github-update-pr', () => {
    it('PATCHes only the supplied fields', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'https://github.com/octo/r/pull/42', state: 'closed' }), { status: 200 }),
        ]);
        const result = await githubUpdatePrAction(
            { pr_number: 42, repo: 'octo/r', state: 'closed' },
            makeContext(),
        );
        const [url, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/repos/octo/r/pulls/42');
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ state: 'closed' });
        expect(result).toMatchObject({ url: 'https://github.com/octo/r/pull/42', state: 'closed', number: 42 });
    });

    it('omits empty/undefined fields from the PATCH body', async () => {
        const spy = mockFetch([() => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 })]);
        await githubUpdatePrAction({ pr_number: 42, repo: 'octo/r', title: 'New title' }, makeContext());
        const init = spy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ title: 'New title' });
    });
});
