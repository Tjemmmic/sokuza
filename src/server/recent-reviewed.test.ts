import { describe, it, expect, vi } from 'vitest';
import { selectRecentReviewedPrs, type RecentReviewRun } from './recent-reviewed.js';

/** Build a run summary stub (newest-first order is the caller's contract). */
function run(source: string, repo: string | undefined, prNumber: number | undefined, createdAt: string): RecentReviewRun {
    return { createdAt, event: { source, repo, prNumber } };
}

/** An open PR detail stub. */
function openPr(title = 'T', author = 'alice', draft = false) {
    return { state: 'OPEN', title, author: { login: author }, url: 'https://x/pr', isDraft: draft };
}

describe('selectRecentReviewedPrs', () => {
    it('keeps only manual reviews, dropping automatic sources', async () => {
        const runs = [
            run('manual', 'o/a', 1, '2026-06-05T10:00:00Z'),
            run('github', 'o/b', 2, '2026-06-05T09:00:00Z'),
            run('gh-cli', 'o/c', 3, '2026-06-05T08:00:00Z'),
            run('github-poll', 'o/d', 4, '2026-06-05T07:00:00Z'),
        ];
        const getPrDetails = vi.fn(async () => openPr());
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(items.map((i) => i.repo)).toEqual(['o/a']);
        // Only the manual run triggers a live lookup.
        expect(getPrDetails).toHaveBeenCalledTimes(1);
        expect(getPrDetails).toHaveBeenCalledWith('o/a', 1);
    });

    it('dedupes by repo+PR, keeping the newest review timestamp', async () => {
        // Newest-first input: the first occurrence is the most recent review.
        const runs = [
            run('manual', 'o/a', 1, '2026-06-05T12:00:00Z'),
            run('manual', 'o/a', 1, '2026-06-04T12:00:00Z'),
            run('manual', 'o/a', 1, '2026-06-03T12:00:00Z'),
        ];
        const getPrDetails = vi.fn(async () => openPr());
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(items).toHaveLength(1);
        expect(items[0].lastReviewedAt).toBe('2026-06-05T12:00:00Z');
        expect(getPrDetails).toHaveBeenCalledTimes(1);
    });

    it('drops PRs that are no longer open (merged/closed)', async () => {
        const runs = [
            run('manual', 'o/open', 1, '2026-06-05T03:00:00Z'),
            run('manual', 'o/merged', 2, '2026-06-05T02:00:00Z'),
            run('manual', 'o/closed', 3, '2026-06-05T01:00:00Z'),
        ];
        const getPrDetails = vi.fn(async (repo: string) => {
            if (repo === 'o/merged') return { state: 'MERGED' };
            if (repo === 'o/closed') return { state: 'CLOSED' };
            return openPr();
        });
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(items.map((i) => i.repo)).toEqual(['o/open']);
    });

    it('ignores rejected gh lookups (deleted repo / lost access)', async () => {
        const runs = [
            run('manual', 'o/a', 1, '2026-06-05T03:00:00Z'),
            run('manual', 'o/gone', 2, '2026-06-05T02:00:00Z'),
            run('manual', 'o/b', 3, '2026-06-05T01:00:00Z'),
        ];
        const getPrDetails = vi.fn(async (repo: string) => {
            if (repo === 'o/gone') throw new Error('not found');
            return openPr();
        });
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(items.map((i) => i.repo)).toEqual(['o/a', 'o/b']);
    });

    it('caps the result at `limit` and bounds live lookups to limit*2', async () => {
        // 10 distinct manual-reviewed PRs, limit 3 → over-fetch cap = 6 lookups,
        // result capped at 3.
        const runs: RecentReviewRun[] = [];
        for (let n = 1; n <= 10; n++) {
            runs.push(run('manual', `o/r${n}`, n, `2026-06-05T${String(n).padStart(2, '0')}:00:00Z`));
        }
        const getPrDetails = vi.fn(async () => openPr());
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 3);
        expect(items).toHaveLength(3);
        expect(getPrDetails).toHaveBeenCalledTimes(6); // limit * 2
    });

    it('skips runs missing a repo or PR number', async () => {
        const runs = [
            run('manual', undefined, 1, '2026-06-05T03:00:00Z'),
            run('manual', 'o/a', undefined, '2026-06-05T02:00:00Z'),
            run('manual', 'o/b', 2, '2026-06-05T01:00:00Z'),
        ];
        const getPrDetails = vi.fn(async () => openPr());
        const items = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(items.map((i) => i.repo)).toEqual(['o/b']);
        expect(getPrDetails).toHaveBeenCalledTimes(1);
    });

    it('maps gh fields onto the quick-pick shape', async () => {
        const runs = [run('manual', 'o/a', 7, '2026-06-05T03:00:00Z')];
        const getPrDetails = vi.fn(async () => openPr('Fix the thing', 'bob', true));
        const [item] = await selectRecentReviewedPrs(runs, getPrDetails, 8);
        expect(item).toEqual({
            number: 7,
            repo: 'o/a',
            title: 'Fix the thing',
            author: 'bob',
            url: 'https://x/pr',
            draft: true,
            lastReviewedAt: '2026-06-05T03:00:00Z',
        });
    });
});
