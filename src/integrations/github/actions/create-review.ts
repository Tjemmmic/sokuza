import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "github-create-review" action.
 *
 * Submits a pull request review using the GitHub REST API.
 * Supports three review events: APPROVE, REQUEST_CHANGES, or COMMENT.
 *
 * Params:
 *   - event: "approve" | "request-changes" | "comment" (default: "comment")
 *   - body: Review body text (required)
 *   - token: GitHub token (optional, falls back to config)
 *   - owner: Repository owner (optional, auto-detected from event)
 *   - repo: Repository name (optional, auto-detected from event)
 *   - pr_number: PR number (optional, auto-detected from event)
 *
 * Returns: { event, html_url }
 */
export const githubCreateReviewAction: ActionHandler = async (params, context) => {
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string) ?? (githubConfig?.token as string);

    if (!token) {
        throw new Error(
            'github-create-review requires a GitHub token. Set integrations.github.token in config or pass params.token.',
        );
    }

    const body = params.body as string;
    if (!body) {
        throw new Error('github-create-review requires a "body" param.');
    }

    // Try to resolve owner/repo/pr_number from the event
    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload.issue as Record<string, unknown> | undefined;

    const owner =
        (params.owner as string) ??
        (context.event.metadata.owner as string);

    const repo =
        (params.repo as string) ??
        (context.event.metadata.repoName as string);

    const prNumber =
        (params.pr_number as number) ??
        (context.event.metadata.prNumber as number) ??
        (pr?.number as number) ??
        (issue?.number as number);

    if (!owner || !repo || !prNumber) {
        throw new Error(
            'github-create-review: could not determine owner, repo, or pr_number.',
        );
    }

    // Map event string to API event type
    const eventParam = (params.event as string) ?? 'comment';
    const eventMap: Record<string, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'> = {
        'approve': 'APPROVE',
        'request-changes': 'REQUEST_CHANGES',
        'request_changes': 'REQUEST_CHANGES',
        'comment': 'COMMENT',
    };

    const apiEvent = eventMap[eventParam.toLowerCase()] ?? 'COMMENT';

    const client = new GitHubApiClient(token);

    context.logger.info(
        { owner, repo, prNumber, event: apiEvent },
        'Submitting PR review to GitHub',
    );

    const result = await client.createReview(owner, repo, prNumber, body, apiEvent);

    context.logger.info(
        { owner, repo, prNumber, event: apiEvent, reviewId: result.id },
        'PR review submitted',
    );

    return {
        event: apiEvent,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        review_id: result.id,
    };
};
