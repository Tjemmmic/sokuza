// Combined test file for the four GitHub "round-trip" action handlers
// (fetch-pr, fetch-issue, merge-pr, update-pr). They share the same
// fetch-mock fixture and ActionContext setup, so co-locating the tests
// keeps the helpers DRY — splitting per-handler would duplicate the
// makeContext / mockFetch boilerplate across four files and create
// drift risk if one copy diverges. The four `describe` blocks below
// scope the suites by handler:
//
//   describe('github-fetch-pr')      — fetch-pr.ts
//   describe('github-fetch-issue')   — fetch-issue.ts
//   describe('github-merge-pr')      — merge-pr.ts
//                                      (incl. merged=false + missing-merged guards)
//   describe('github-update-pr')     — update-pr.ts
//                                      (incl. emptyToUndef '' / non-string inputs)
//
// wait-for-checks lives in its own file because its fixtures (timer
// mocks, stage sequencer) are quite different.
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
        // Both the canonical `mergeSha` port and the legacy `sha` alias
        // resolve to the merge commit — pinned together so a future
        // rename can't drop one without the test catching it.
        expect(result).toMatchObject({ merged: true, mergeSha: 'abcdef', sha: 'abcdef', method: 'squash' });
    });

    it('throws on a 405 (PR not mergeable)', async () => {
        mockFetch([() => new Response('not mergeable', { status: 405, statusText: 'Method Not Allowed' })]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/error merging PR: 405/);
    });

    it('throws on a 200 response with merged=false (M1 — silent-failure guard)', async () => {
        mockFetch([
            () => new Response(JSON.stringify({ merged: false, message: 'Pull Request is not mergeable' }), { status: 200 }),
        ]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/200 but merged=false.*not mergeable/);
    });

    it('throws a distinct error when the response is missing the "merged" field (M10 — API shape change)', async () => {
        mockFetch([
            // Response shape an unexpected proxy or API revision could produce.
            () => new Response(JSON.stringify({ sha: 'abc123', message: 'ok' }), { status: 200 }),
        ]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/missing the "merged" field.*possible API shape change/);
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

    it('throws when no field is supplied (M2 — empty-body guard)', async () => {
        // No fetch should happen — the guard fires before the API call.
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/at least one of title\/body\/state\/base/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('treats empty-string fields as "no change" instead of forwarding them', async () => {
        // The legacy steps executor doesn't filter empty interpolation
        // results; defending in the handler protects callers from
        // silently blanking the PR body when an upstream {{...}} fails
        // to resolve.
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 }),
        ]);
        await githubUpdatePrAction(
            { pr_number: 42, repo: 'octo/r', title: 'Real title', body: '', state: '', base: '' },
            makeContext(),
        );
        const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit)?.body ?? '{}'));
        // Only the genuinely populated field should appear in the PATCH.
        expect(body).toEqual({ title: 'Real title' });
    });

    it('rejects an all-empty payload with the no-fields error, not the empty-title error', async () => {
        // After emptyToUndef normalization, every field is undefined →
        // the API client's "at least one of …" guard fires with the
        // clearer message instead of the lower-level "title must not be
        // empty" error.
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction(
                { pr_number: 42, repo: 'octo/r', title: '', body: '', state: '', base: '' },
                makeContext(),
            ),
        ).rejects.toThrow(/at least one of title\/body\/state\/base/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('drops non-string field values (number/boolean/null) instead of forwarding them', async () => {
        // emptyToUndef has three branches: non-string → undefined,
        // empty-string → undefined, populated string → value. The first
        // matters when an upstream wire produces a number or boolean
        // (e.g. a flow.if `then` output) — without the guard the API
        // client would coerce 42 to "42" and silently retitle the PR.
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 }),
        ]);
        await githubUpdatePrAction(
            // Cast through unknown so the test reflects what could
            // arrive from a wired upstream port at runtime. The non-string
            // state goes through emptyToUndef → undefined before reaching
            // validateState, so it's dropped, not rejected.
            { pr_number: 42, repo: 'octo/r', title: 'Real title', body: 42 as unknown as string, state: false as unknown as string, base: null as unknown as string },
            makeContext(),
        );
        const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit)?.body ?? '{}'));
        expect(body).toEqual({ title: 'Real title' });
    });

    it('rejects an unknown state value with a clear error (not an opaque 422 from GitHub)', async () => {
        // Previously `params.state` was cast through `as 'open' | 'closed'`,
        // so a value like 'draft' or a typo'd 'opened' would slip past
        // TypeScript and only fail at the API call with an opaque 422.
        // Now we validate against the canonical set up front.
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction(
                { pr_number: 42, repo: 'octo/r', state: 'draft' },
                makeContext(),
            ),
        ).rejects.toThrow(/state must be one of open, closed.*draft/);
        expect(spy).not.toHaveBeenCalled();
    });
});
