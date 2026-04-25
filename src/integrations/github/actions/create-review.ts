import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { renderReviewForApi, type StructuredReview } from '../../../actions/review-templates.js';

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
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string) ?? (githubConfig?.token as string);
    if (!token) {
        throw new Error(
            'github-create-review requires a GitHub token. Set integrations.github.token in config or pass params.token.',
        );
    }

    const pr = context.event.payload?.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload?.issue as Record<string, unknown> | undefined;
    const owner = (params.owner as string) ?? (context.event.metadata?.owner as string);
    const repo = (params.repo as string) ?? (context.event.metadata?.repoName as string);
    const prNumber =
        (params.pr_number as number) ??
        (context.event.metadata?.prNumber as number) ??
        (pr?.number as number) ??
        (issue?.number as number);
    if (!owner || !repo || !prNumber) {
        throw new Error('github-create-review: could not determine owner, repo, or pr_number.');
    }

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
