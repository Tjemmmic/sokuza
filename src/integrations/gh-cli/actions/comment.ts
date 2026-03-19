/**
 * GH CLI powered comment action.
 * Uses `gh pr comment` or `gh issue comment` — no token needed.
 */

import type { ActionHandler } from '../../../core/types.js';
import { ghExec } from '../exec.js';

export const ghCommentAction: ActionHandler = async (params, context) => {
    const body = params.body as string;
    if (!body) {
        throw new Error('github-comment requires a "body" param.');
    }

    // Skip posting if body contains the skip marker
    const skipMarker = params.skip_if_contains as string | undefined;
    if (skipMarker && body.includes(skipMarker)) {
        context.logger.info({ skipMarker }, 'Skipping comment — body contains skip marker');
        return { skipped: true, reason: `Body contains "${skipMarker}"` };
    }

    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload.issue as Record<string, unknown> | undefined;

    const owner = (params.owner as string)
        ?? (context.event.metadata.owner as string);
    const repo = (params.repo as string)
        ?? (context.event.metadata.repoName as string);
    const number = (params.pr_number as number)
        ?? (params.issue_number as number)
        ?? (context.event.metadata.prNumber as number)
        ?? (pr?.number as number)
        ?? (issue?.number as number);

    if (!owner || !repo || !number) {
        throw new Error('github-comment: could not determine owner, repo, or issue/PR number.');
    }

    const repoSlug = `${owner}/${repo}`;
    const isPr = !!(pr || context.event.metadata.prNumber || params.pr_number);

    context.logger.info({ owner, repo, number }, 'Posting comment via gh CLI');

    // Use gh pr comment or gh issue comment
    const cmd = isPr ? 'pr' : 'issue';
    const result = await ghExec([
        cmd, 'comment', String(number),
        '-R', repoSlug,
        '-b', body,
    ], { timeout: 15_000 });

    if (result.exitCode !== 0) {
        throw new Error(`gh ${cmd} comment failed: ${result.stderr.trim()}`);
    }

    context.logger.info({ owner, repo, number }, 'Comment posted via gh CLI');

    return {
        comment_id: null, // gh CLI doesn't return the comment ID
        html_url: `https://github.com/${repoSlug}/${isPr ? 'pull' : 'issues'}/${number}`,
    };
};
