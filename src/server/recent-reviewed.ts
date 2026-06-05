// Core selection logic for the "Recently reviewed" PR quick-pick
// (GET /api/pr-picker/recent-reviewed), extracted from the route so the
// non-trivial filter/dedupe/open-check behavior is unit-testable without
// standing up the HTTP server or the gh CLI.

/** Minimal shape of an ai-review run summary this selection needs. */
export interface RecentReviewRun {
    createdAt: string;
    event?: { source?: string; repo?: string; prNumber?: number };
}

/** A PR offered in the quick-pick, enriched from live gh state. */
export interface RecentReviewedPr {
    number: number;
    repo: string;
    title: string;
    author: string;
    url: string;
    draft: boolean;
    lastReviewedAt: string;
}

/** The subset of a `gh pr view --json` detail object this module reads. */
export interface PrDetail {
    state?: string;
    title?: string;
    author?: { login?: string };
    url?: string;
    isDraft?: boolean;
}

/**
 * Pick open PRs that recently received a *manual* (non-automatic) AI review,
 * newest review first.
 *
 * `runs` MUST be ordered newest-first (the contract of `listAiReviewRuns`) —
 * the first time a PR is seen is therefore its most-recent review, which
 * becomes `lastReviewedAt`. We keep one entry per PR, re-check live state via
 * `getPrDetails`, and drop anything not open or unreadable (deleted repo /
 * lost access surface as a rejected lookup). At most `limit * 2` live lookups
 * are issued so a few closed PRs can't starve the list while still bounding
 * gh calls.
 */
export async function selectRecentReviewedPrs(
    runs: RecentReviewRun[],
    getPrDetails: (repo: string, prNumber: number) => Promise<Record<string, unknown>>,
    limit: number,
): Promise<RecentReviewedPr[]> {
    const seen = new Set<string>();
    const candidates: { repo: string; number: number; lastReviewedAt: string }[] = [];
    for (const run of runs) {
        if (run.event?.source !== 'manual') continue;
        const repo = run.event.repo;
        const number = run.event.prNumber;
        if (!repo || typeof number !== 'number') continue;
        const key = `${repo}#${number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ repo, number, lastReviewedAt: run.createdAt });
        if (candidates.length >= limit * 2) break;
    }

    const settled = await Promise.allSettled(
        candidates.map(async (c) => ({ c, pr: await getPrDetails(c.repo, c.number) })),
    );

    const items: RecentReviewedPr[] = [];
    for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { c } = result.value;
        const pr = result.value.pr as PrDetail;
        if (String(pr.state ?? '').toLowerCase() !== 'open') continue;
        items.push({
            number: c.number,
            repo: c.repo,
            title: pr.title ?? '',
            author: pr.author?.login ?? '',
            url: pr.url ?? '',
            draft: Boolean(pr.isDraft),
            lastReviewedAt: c.lastReviewedAt,
        });
        if (items.length >= limit) break;
    }
    return items;
}
