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

    it('compacts pretty-printed JSON so the message field survives the truncation budget (L6)', async () => {
        // Pretty-printed JSON with leading whitespace and outer braces would
        // otherwise eat the first ~50 chars. Compact form puts the "message"
        // field within the budget.
        const pretty = JSON.stringify({
            message: 'Validation Failed',
            errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }],
            documentation_url: 'https://docs.github.com/...',
        }, null, 2); // 2-space indent
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(pretty, { status: 422, statusText: 'Unprocessable' }),
        );
        const client = new GitHubApiClient('tok');
        try {
            await client.createComment('o', 'r', 1, 'hi');
            throw new Error('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('Validation Failed');
            expect(msg).toContain('missing_field');
            // Compact form has no leading newlines or 2-space indents
            expect(msg).not.toContain('\n  ');
        }
    });
});

describe('updatePullRequest — empty-string field guards (L7)', () => {
    it('rejects empty-string title without making an HTTP call', async () => {
        const spy = vi.spyOn(globalThis, 'fetch');
        const client = new GitHubApiClient('tok');
        await expect(client.updatePullRequest('o', 'r', 1, { title: '' })).rejects.toThrow(/title must not be empty/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('rejects empty-string base without making an HTTP call', async () => {
        const spy = vi.spyOn(globalThis, 'fetch');
        const client = new GitHubApiClient('tok');
        await expect(client.updatePullRequest('o', 'r', 1, { base: '' })).rejects.toThrow(/base must not be empty/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('allows empty-string body (GitHub accepts blank PR descriptions)', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ html_url: 'x' }), { status: 200 }),
        );
        const client = new GitHubApiClient('tok');
        await client.updatePullRequest('o', 'r', 1, { body: '' });
        expect(spy).toHaveBeenCalledTimes(1);
        const init = spy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ body: '' });
    });
});

describe('GitHubApiClient — getCheckRuns pagination cap (M8)', () => {
    it('stops paginating at maxPages even when GitHub keeps returning full pages', async () => {
        let calls = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            calls++;
            // Always return a full page (100) so the natural break never fires.
            const runs = Array.from({ length: 100 }, (_, i) => ({ name: `run-${calls}-${i}`, status: 'completed', conclusion: 'success' }));
            return new Response(JSON.stringify({ check_runs: runs, total_count: 1000 }), { status: 200 });
        });
        const client = new GitHubApiClient('tok');
        const runs = await client.getCheckRuns('o', 'r', 'sha', 3);
        expect(calls).toBe(3); // capped at maxPages, not infinite
        expect(runs.length).toBe(300);
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
