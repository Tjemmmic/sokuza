// Integration tests for the read-side round-trip handlers
// (github-fetch-pr, github-fetch-issue) — i.e. the ones that GET a
// resource from the GitHub API and re-emit it onto downstream ports.
// merge-pr and update-pr now have their own dedicated test files
// (merge-pr.test.ts, update-pr.test.ts) so the validation logic in
// each can be pinned at the unit level too. wait-for-checks lives in
// wait-for-checks.test.ts because its fixtures (timer mocks, stage
// sequencer) are quite different.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubFetchPrAction } from './fetch-pr.js';
import { githubFetchIssueAction } from './fetch-issue.js';
import { makeContext, mockFetch } from './_test-helpers.js';

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
