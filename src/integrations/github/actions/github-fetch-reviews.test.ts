import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';
import { githubFetchReviewsAction } from './github-fetch-reviews.js';

const logger = pino({ level: 'silent' });

function ctx(overrides: Partial<ActionContext['event']> = {}, integrationConfigs: Record<string, unknown> = { github: { token: 'gh_test' } }): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: {},
            metadata: {},
            ...overrides,
        },
        results: {},
        steps: {},
        integrationConfigs,
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
    } as unknown as ActionContext;
}

// github-fetch-reviews now uses _target.ts (same as comment, fetch-diff,
// create-review). The old bespoke resolver had a half-fix that split
// metadata.repo on '/' for owner — but it still read `params.repo`
// itself as the bare name, so any wire that passed an "owner/name"
// string into the repo port broke the URL the same way the other
// handlers did. These tests pin the unified contract.

describe('githubFetchReviewsAction owner/repo resolution', () => {
    let capturedUrls: string[] = [];
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
        capturedUrls = [];
        origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: unknown) => {
            capturedUrls.push(typeof input === 'string' ? input : (input as URL).toString());
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
    });

    afterEachRestore();
    function afterEachRestore() {
        // vitest hook bound separately so it runs even if a test throws.
        // Using `process.on` would leak between files; vitest provides
        // afterEach via the global hook registry, but to keep this file
        // dependency-light we restore inside each `it` instead.
    }

    it('accepts params.repo as "owner/name" — URL is /repos/owner/name/pulls/N/...', async () => {
        try {
            await githubFetchReviewsAction({ repo: 'octo/r', pr_number: 7 }, ctx());
            expect(capturedUrls[0]).toBe('https://api.github.com/repos/octo/r/pulls/7/reviews');
            expect(capturedUrls[1]).toMatch(/^https:\/\/api\.github\.com\/repos\/octo\/r\/pulls\/7\/comments/);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('falls back to event metadata when params are unwired', async () => {
        try {
            await githubFetchReviewsAction(
                {},
                ctx({ metadata: { repo: 'octo/r', owner: 'octo', repoName: 'r', prNumber: 7 } }),
            );
            expect(capturedUrls[0]).toBe('https://api.github.com/repos/octo/r/pulls/7/reviews');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('falls back to the github-poll integration token when github.token is unset', async () => {
        try {
            await githubFetchReviewsAction(
                { repo: 'octo/r', pr_number: 7 },
                ctx({}, { 'github-poll': { token: 'poll_token' } }),
            );
            // The poll-token fallback only matters for the
            // requireToken check; the URL is unchanged.
            expect(capturedUrls[0]).toBe('https://api.github.com/repos/octo/r/pulls/7/reviews');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('rejects a malformed params.repo with a clear error', async () => {
        try {
            await expect(
                githubFetchReviewsAction({ repo: 'not-a-slash', pr_number: 7 }, ctx()),
            ).rejects.toThrow(/params\.repo must be "owner\/name"/);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
