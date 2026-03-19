/**
 * GH CLI powered PR review action.
 * Uses `gh pr review` — no token needed.
 *
 * This is a NEW action (not in the token-based integration) that allows
 * submitting formal PR reviews (approve, request changes, comment).
 */

import type { ActionHandler } from '../../../core/types.js';
import { ghExec } from '../exec.js';

export const ghReviewAction: ActionHandler = async (params, context) => {
    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;

    const owner = (params.owner as string)
        ?? (context.event.metadata.owner as string);
    const repo = (params.repo as string)
        ?? (context.event.metadata.repoName as string);
    const prNumber = (params.pr_number as number)
        ?? (context.event.metadata.prNumber as number)
        ?? (pr?.number as number);

    if (!owner || !repo || !prNumber) {
        throw new Error('github-review: could not determine owner, repo, or pr_number');
    }

    const body = params.body as string;
    if (!body) {
        throw new Error('github-review: "body" is required');
    }

    // Determine review event: approve, request-changes, or comment
    const event = (params.event as string) ?? 'comment';
    const validEvents = ['approve', 'request-changes', 'comment'];
    if (!validEvents.includes(event)) {
        throw new Error(`github-review: "event" must be one of: ${validEvents.join(', ')}`);
    }

    const repoSlug = `${owner}/${repo}`;

    context.logger.info({ owner, repo, prNumber, event }, 'Submitting PR review via gh CLI');

    const args = [
        'pr', 'review', String(prNumber),
        '-R', repoSlug,
        '-b', body,
    ];

    // Add the review type flag
    switch (event) {
        case 'approve':
            args.push('--approve');
            break;
        case 'request-changes':
            args.push('--request-changes');
            break;
        case 'comment':
            args.push('--comment');
            break;
    }

    const result = await ghExec(args, { timeout: 15_000 });

    if (result.exitCode !== 0) {
        throw new Error(`gh pr review failed: ${result.stderr.trim()}`);
    }

    context.logger.info({ owner, repo, prNumber, event }, 'PR review submitted via gh CLI');

    return {
        event,
        html_url: `https://github.com/${repoSlug}/pull/${prNumber}`,
    };
};
