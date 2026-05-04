import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-merge-pr" — merge a PR via the API. Method defaults to plain
 * merge; squash and rebase are the other two GitHub-supported options.
 *
 * Returns `merged: false` only when GitHub explicitly says so (the
 * "behind base"/"checks failing" case raises 405 and throws).
 */
export const githubMergePrAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-merge-pr');
    const target = resolveRepoTarget(params, context, 'github-merge-pr');
    const method = (params.method as 'merge' | 'squash' | 'rebase') ?? 'merge';
    const client = new GitHubApiClient(token);
    const result = await client.mergePullRequest(target.owner, target.repo, target.number, {
        method,
        commit_title: params.commit_title as string | undefined,
        commit_message: params.commit_message as string | undefined,
        sha: params.sha as string | undefined,
    });
    return {
        merged: result.merged,
        sha: result.sha,
        message: result.message,
        method,
    };
};
