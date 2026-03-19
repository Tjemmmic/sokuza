/**
 * GitHub event constants and helpers.
 *
 * Event names follow the pattern: `<resource>.<action>`
 * Canonical Sokuza names are prefixed: `github.<resource>.<action>`
 */

/** Events that Sokuza's GitHub integration supports out of the box */
export const SUPPORTED_GITHUB_EVENTS = [
    'issues.opened',
    'issues.closed',
    'issues.labeled',
    'issues.assigned',
    'pull_request.opened',
    'pull_request.closed',
    'pull_request.synchronize',
    'pull_request.review_requested',
    'push',
    'issue_comment.created',
    'pull_request_review.submitted',
] as const;

export type GitHubEventName = (typeof SUPPORTED_GITHUB_EVENTS)[number];

/**
 * Build the canonical Sokuza event name from header + body.
 *
 * GitHub puts the top-level event in `x-github-event` header (e.g. "issues")
 * and the sub-action in `body.action` (e.g. "opened").
 */
export function canonicalEventName(
    headerEvent: string,
    bodyAction?: string,
): string {
    if (bodyAction) {
        return `${headerEvent}.${bodyAction}`;
    }
    return headerEvent;
}

/**
 * Extract repo full name from a GitHub webhook payload.
 */
export function extractRepoName(
    payload: Record<string, unknown>,
): string | undefined {
    const repo = payload.repository as Record<string, unknown> | undefined;
    return repo?.full_name as string | undefined;
}
