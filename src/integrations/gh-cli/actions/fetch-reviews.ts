/**
 * GH CLI powered fetch-reviews action.
 * Uses `gh api` to fetch PR reviews and comments — no token needed.
 */

import type { ActionHandler } from '../../../core/types.js';
import { ghJson } from '../exec.js';

export const ghFetchReviewsAction: ActionHandler = async (params, context) => {
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
        throw new Error('github-fetch-reviews: could not resolve owner, repo, and pr_number');
    }

    context.logger.info({ owner, repo, prNumber }, 'Fetching PR reviews via gh CLI');

    // Fetch reviews via gh api (formal APPROVE/REQUEST_CHANGES/COMMENT)
    const rawReviews = await ghJson<Array<Record<string, unknown>>>([
        'api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    ]);

    // Fetch review comments (inline code comments on diffs)
    const rawInlineComments = await ghJson<Array<Record<string, unknown>>>([
        'api', `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        '--paginate',
    ]);

    // Fetch regular PR comments (posted via gh pr comment / conversation tab)
    const rawPrComments = await ghJson<Array<Record<string, unknown>>>([
        'api', `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        '--paginate',
    ]);

    const reviews = rawReviews.map((r) => ({
        id: r.id,
        user: (r.user as Record<string, unknown>)?.login,
        state: r.state,
        body: r.body,
        submitted_at: r.submitted_at,
    }));

    const inlineComments = rawInlineComments.map((c) => ({
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

    const prComments = rawPrComments.map((c) => ({
        id: c.id,
        user: (c.user as Record<string, unknown>)?.login,
        body: c.body as string,
        created_at: c.created_at,
        html_url: c.html_url,
    }));

    // Build summary
    const reviewSummary = reviews
        .filter((r) => r.body || r.state !== 'COMMENTED')
        .map((r) => `**${r.user}** (${r.state}): ${r.body || '(no body)'}`)
        .join('\n\n');

    const inlineCommentSummary = inlineComments
        .filter((c) => !c.in_reply_to_id)
        .map((c) => `**${c.user}** on \`${c.path}:${c.line}\`: ${c.body}`)
        .join('\n\n');

    const prCommentSummary = prComments
        .map((c) => `**${c.user}**: ${c.body}`)
        .join('\n\n');

    const summary = [
        `## PR #${prNumber} Reviews (${owner}/${repo})`,
        `### Formal Reviews (${reviews.length})`,
        reviewSummary || '_No formal reviews_',
        `### Inline Code Comments (${inlineComments.filter((c) => !c.in_reply_to_id).length})`,
        inlineCommentSummary || '_No inline comments_',
        `### PR Comments (${prComments.length})`,
        prCommentSummary || '_No PR comments_',
    ].join('\n\n');

    context.logger.info(
        { owner, repo, prNumber, reviewCount: reviews.length, inlineCommentCount: inlineComments.length, prCommentCount: prComments.length },
        'Fetched PR reviews via gh CLI',
    );

    return { reviews, comments: inlineComments, prComments, summary, owner, repo, prNumber };
};
