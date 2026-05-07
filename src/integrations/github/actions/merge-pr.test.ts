import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubMergePrAction } from './merge-pr.js';
import { makeContext, mockFetch } from './_test-helpers.js';

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('github-merge-pr', () => {
    it('PUTs to /pulls/:n/merge with the chosen method and returns mergeSha + sha', async () => {
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

    it('throws on a 200 response with merged=false (silent-failure guard)', async () => {
        // GitHub returns 200 + merged:false for "behind base" / "checks
        // failing" cases. Treating this as success would be a real
        // production hazard — pin the explicit failure path.
        mockFetch([
            () => new Response(JSON.stringify({ merged: false, message: 'Pull Request is not mergeable' }), { status: 200 }),
        ]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/200 but merged=false.*not mergeable/);
    });

    it('throws a distinct error when the response is missing the "merged" field (API shape change)', async () => {
        // A proxy or future API revision could drop the merged field.
        // Distinguishing this from merged=false in the error message
        // lets an operator triage the right thing.
        mockFetch([
            () => new Response(JSON.stringify({ sha: 'abc123', message: 'ok' }), { status: 200 }),
        ]);
        await expect(
            githubMergePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/missing the "merged" field.*possible API shape change/);
    });

    it('passes commit_title and commit_message through to the API body when supplied', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ merged: true, sha: 's1' }), { status: 200 }),
        ]);
        await githubMergePrAction(
            { pr_number: 42, repo: 'octo/r', commit_title: 'Squashed: x', commit_message: 'details' },
            makeContext(),
        );
        const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit)?.body ?? '{}'));
        expect(body).toMatchObject({ commit_title: 'Squashed: x', commit_message: 'details' });
    });
});
