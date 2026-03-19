import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "github-comment" action.
 *
 * Posts a comment on a PR or issue. Auto-extracts owner/repo/number
 * from the event payload, or they can be provided as explicit params.
 */
export const githubCommentAction: ActionHandler = async (params, context) => {
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string) ?? (githubConfig?.token as string);

    if (!token) {
        throw new Error(
            'github-comment requires a GitHub token. Set integrations.github.token in config or pass params.token.',
        );
    }

    const body = params.body as string;
    if (!body) {
        throw new Error('github-comment requires a "body" param.');
    }

    // Try to resolve owner/repo/number from the event
    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload.issue as Record<string, unknown> | undefined;

    const owner =
        (params.owner as string) ??
        (context.event.metadata.owner as string);

    const repo =
        (params.repo as string) ??
        (context.event.metadata.repoName as string);

    const issueNumber =
        (params.pr_number as number) ??
        (params.issue_number as number) ??
        (context.event.metadata.prNumber as number) ??
        (pr?.number as number) ??
        (issue?.number as number);

    if (!owner || !repo || !issueNumber) {
        throw new Error(
            'github-comment: could not determine owner, repo, or issue/PR number.',
        );
    }

    const client = new GitHubApiClient(token);

    context.logger.info(
        { owner, repo, issueNumber },
        'Posting comment to GitHub',
    );

    const result = await client.createComment(owner, repo, issueNumber, body);

    context.logger.info(
        { owner, repo, issueNumber, commentId: result.id },
        'Comment posted',
    );

    return {
        comment_id: result.id,
        html_url: result.html_url,
    };
};
