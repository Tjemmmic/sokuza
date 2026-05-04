import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubApiClient } from './api.js';

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('GitHubApiClient — error body truncation (L2)', () => {
    it('caps error body at 500 chars and notes the original length', async () => {
        const huge = 'X'.repeat(2000);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(huge, { status: 500, statusText: 'oops' }),
        );
        const client = new GitHubApiClient('tok');
        try {
            await client.createComment('o', 'r', 1, 'hi');
            throw new Error('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            // Body slice + the [truncated, ...] suffix; total length should be much less than 2000
            expect(msg.length).toBeLessThan(800);
            expect(msg).toContain('truncated, 2000 chars total');
            expect(msg).toContain('XXXX'); // the truncated body fragment is included
        }
    });

    it('leaves short bodies untouched', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('not found', { status: 404, statusText: 'Not Found' }),
        );
        const client = new GitHubApiClient('tok');
        try {
            await client.createComment('o', 'r', 1, 'hi');
            throw new Error('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('not found');
            expect(msg).not.toContain('truncated');
        }
    });
});

describe('GitHubApiClient — 406 fallback (L1)', () => {
    it('falls back to per-file assembly on a real 406 (status check, not substring match)', async () => {
        let call = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            call++;
            if (call === 1) {
                // First call: bulk diff → 406
                return new Response('diff too large', { status: 406, statusText: 'Not Acceptable' });
            }
            // Second call: paginated /files
            return new Response(JSON.stringify([
                { filename: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+A' },
            ]), { status: 200 });
        });
        const client = new GitHubApiClient('tok');
        const res = await client.getPullRequestDiffWithFallback('o', 'r', 4060);
        expect(res.source).toBe('file-patches');
        expect(res.diff).toContain('a.txt');
    });

    it('does not trigger the fallback when an error message merely contains "406" (regression for sloppy substring match)', async () => {
        // PR number 4060 → URL contains "4060" → previous heuristic would have
        // mis-fired. With the status-code check the 500 propagates correctly.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('upstream error: 406 oops', { status: 500, statusText: 'Server Error' }),
        );
        const client = new GitHubApiClient('tok');
        await expect(client.getPullRequestDiffWithFallback('o', 'r', 4060))
            .rejects.toThrow(/error fetching diff: 500/);
    });
});
