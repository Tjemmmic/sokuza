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
    // GitHub's documented contract is that 200 on /merge means the merge
    // happened. Two failure modes the previous version conflated:
    //   1. merged: false       — GitHub explicitly said the merge didn't happen
    //   2. merged: undefined   — response shape changed (proxy, API revision)
    // Distinct messages let an operator triage the right thing.
    if (!result.mergedFieldPresent) {
        throw new Error(
            `github-merge-pr: GitHub returned 200 but the response is missing the "merged" field — possible API shape change (${result.message || 'no message'})`,
        );
    }
    if (!result.merged) {
        throw new Error(`github-merge-pr: GitHub returned 200 but merged=false (${result.message || 'no message'})`);
    }
    return {
        merged: true,
        // `mergeSha` is the canonical port name on the github.merge-pr
        // node; `sha` is kept as an alias so workflows authored before
        // the rename keep resolving {{nodes.x.sha}} to the merge commit.
        mergeSha: result.sha,
        sha: result.sha,
        message: result.message,
        method,
    };
};
