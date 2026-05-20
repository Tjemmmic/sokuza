import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { renderReviewForApi, type StructuredReview } from '../../../actions/review-templates.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-create-review" action.
 *
 * Submits a pull request review using the GitHub REST API. Supports two
 * input shapes:
 *
 *   1. **Plain mode** (legacy): pass `body` and `event`. Posts a review
 *      with that body and state. No inline comments.
 *
 *   2. **Structured mode** (preferred for AI reviews): pass `structured`
 *      (a `StructuredReview` from a preceding `ai-review` step's `parsed`
 *      output). The action builds inline review comments anchored to the
 *      diff for issues with line info, falls back to body listing for
 *      orphans, and derives the review event from `parsed.decision`.
 *
 *      `run_id` is stamped into the body as a `<!-- sokuza:run-id=... -->`
 *      marker so the auto address-review workflow can identify AI reviews
 *      from comment-event filters and look up the structured record.
 *
 * Robustness: GitHub rejects an entire review if any inline comment
 * references a line that's not present in the diff. On 422 (or any
 * failure), the action retries body-only with a notice — this trades a
 * bit of richness for never-ever silently dropping a review.
 *
 * Params:
 *   - structured: StructuredReview (optional; activates structured mode)
 *   - run_id: string (optional; embedded as marker comment)
 *   - body: string (required if structured absent)
 *   - event: 'approve' | 'request-changes' | 'comment' (default 'comment'; ignored in structured mode)
 *   - token: GitHub token (optional, falls back to integration config)
 *   - owner / repo / pr_number: optional, auto-detected from event metadata
 *
 * Returns: { event, html_url, review_id, inline_comments, fallback_used }
 */
export const githubCreateReviewAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-create-review');
    // `resolveRepoTarget` accepts `params.repo` as either "owner/name"
    // (what `data.pr-fields.repo` outputs and what the editor's
    // "Repository" port label implies) or just the bare name when
    // paired with `params.owner`. The previous bespoke resolver read
    // `params.repo` as the bare name only — wiring `pr_fields.repo`
    // (= "owner/name") into this action would produce a URL like
    // `/repos/<owner>/owner/name/pulls/<n>/reviews` and 404.
    const target = resolveRepoTarget(params, context, 'github-create-review');
    const { owner, repo, number: prNumber } = target;

    const structured = params.structured as StructuredReview | undefined;
    const runId = params.run_id as string | undefined;

    let body: string;
    let event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    let comments: Array<{
        path: string;
        line: number;
        side: 'RIGHT';
        start_line?: number;
        body: string;
    }> = [];

    if (structured && Array.isArray(structured.issues)) {
        const payload = renderReviewForApi(structured, runId);
        body = payload.body;
        event = payload.event;
        comments = payload.comments;
    } else {
        body = params.body as string;
        if (!body) {
            throw new Error('github-create-review requires either "structured" or "body".');
        }
        event = mapEvent(params.event as string | undefined);
        if (runId) body = `<!-- sokuza:run-id=${runId} -->\n${body}`;
    }

    const client = new GitHubApiClient(token);
    context.logger.info(
        { owner, repo, prNumber, event, inlineCount: comments.length },
        'Submitting PR review to GitHub',
    );

    let result: Record<string, unknown>;
    let fallbackUsed = false;
    try {
        result = await client.createReview(owner, repo, prNumber, { body, event, comments });
    } catch (err) {
        // GitHub rejects the entire review if any inline comment line
        // isn't in the diff. Don't drop the review — retry without
        // comments and append a notice so the reviewer still sees content.
        if (comments.length === 0) throw err;
        context.logger.warn(
            { err: (err as Error).message, owner, repo, prNumber },
            'Inline comments rejected; retrying with body-only review',
        );
        fallbackUsed = true;
        const fallbackBody = `${body}\n\n---\n_Note: ${comments.length} inline comments could not be anchored to the diff and were posted to the body above._`;
        result = await client.createReview(owner, repo, prNumber, {
            body: fallbackBody,
            event,
        });
    }

    context.logger.info(
        { owner, repo, prNumber, event, reviewId: result.id, fallbackUsed },
        'PR review submitted',
    );

    return {
        event,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        review_id: result.id,
        inline_comments: fallbackUsed ? 0 : comments.length,
        fallback_used: fallbackUsed,
    };
};

function mapEvent(input?: string): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
    const lc = (input ?? 'comment').toLowerCase();
    if (lc === 'approve') return 'APPROVE';
    if (lc === 'request-changes' || lc === 'request_changes') return 'REQUEST_CHANGES';
    return 'COMMENT';
}
