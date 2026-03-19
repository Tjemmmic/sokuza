/**
 * "github-fetch-reviews" action.
 *
 * Fetches all reviews and review comments for a pull request.
 * Returns structured data that can be used by AI actions to respond.
 *
 * Params:
 *   - owner: Repository owner (auto-resolved from event metadata)
 *   - repo: Repository name (auto-resolved from event metadata)
 *   - pr_number: Pull request number (auto-resolved from event payload)
 *
 * Returns: { reviews, comments, summary }
 */

import type { ActionHandler } from '../../../core/types.js';

export const githubFetchReviewsAction: ActionHandler = async (params, context) => {
    const owner = (params.owner as string)
        ?? (context.event.metadata?.owner as string)
        ?? (context.event.metadata?.repo as string)?.split('/')[0];
    const repo = (params.repo as string)
        ?? (context.event.metadata?.repoName as string)
        ?? (context.event.metadata?.repo as string)?.split('/')[1];
    const prNumber = (params.pr_number as number)
        ?? (context.event.metadata?.prNumber as number)
        ?? (context.event.payload?.pull_request as Record<string, unknown>)?.number as number;

    if (!owner || !repo || !prNumber) {
        throw new Error(
            'github-fetch-reviews: could not resolve owner, repo, and pr_number. ' +
            'Ensure the event has metadata.repo or pass params explicitly.',
        );
    }

    // Get the GitHub token from integration configs
    const ghConfig = context.integrationConfigs?.github as Record<string, unknown> | undefined;
    const ghPollConfig = context.integrationConfigs?.['github-poll'] as Record<string, unknown> | undefined;
    const token = (ghConfig?.token as string) ?? (ghPollConfig?.token as string);

    if (!token) {
        throw new Error('github-fetch-reviews: no GitHub token configured');
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    // Fetch PR reviews
    const reviewsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        { headers },
    );
    if (!reviewsRes.ok) {
        throw new Error(`GitHub API error fetching reviews: ${reviewsRes.status} ${reviewsRes.statusText}`);
    }
    const rawReviews = await reviewsRes.json() as Array<Record<string, unknown>>;

    // Fetch review comments (inline/file-level comments)
    const commentsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?sort=created&direction=desc&per_page=100`,
        { headers },
    );
    if (!commentsRes.ok) {
        throw new Error(`GitHub API error fetching review comments: ${commentsRes.status} ${commentsRes.statusText}`);
    }
    const rawComments = await commentsRes.json() as Array<Record<string, unknown>>;

    // Structure the output
    const reviews = rawReviews.map((r) => ({
        id: r.id,
        user: (r.user as Record<string, unknown>)?.login,
        state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
        body: r.body,
        submitted_at: r.submitted_at,
    }));

    const comments = rawComments.map((c) => ({
        id: c.id,
        review_id: c.pull_request_review_id,
        user: (c.user as Record<string, unknown>)?.login,
        path: c.path,
        line: c.line ?? c.original_line,
        side: c.side,
        body: c.body,
        created_at: c.created_at,
        in_reply_to_id: c.in_reply_to_id,
    }));

    // Build a human-readable summary for the AI
    const reviewSummary = reviews
        .filter((r) => r.body || r.state !== 'COMMENTED')
        .map((r) => `**${r.user}** (${r.state}): ${r.body || '(no body)'}`)
        .join('\n\n');

    const commentSummary = comments
        .filter((c) => !c.in_reply_to_id) // Only top-level comments
        .map((c) => `**${c.user}** on \`${c.path}:${c.line}\`: ${c.body}`)
        .join('\n\n');

    const summary = [
        `## PR #${prNumber} Reviews (${owner}/${repo})`,
        `### Reviews (${reviews.length})`,
        reviewSummary || '_No reviews yet_',
        `### Inline Comments (${comments.filter((c) => !c.in_reply_to_id).length})`,
        commentSummary || '_No inline comments_',
    ].join('\n\n');

    context.logger.info(
        { owner, repo, prNumber, reviewCount: reviews.length, commentCount: comments.length },
        'Fetched PR reviews and comments',
    );

    return { reviews, comments, summary, owner, repo, prNumber };
};
