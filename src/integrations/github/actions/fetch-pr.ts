import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-fetch-pr" action — round-trip PR lookup by number.
 *
 * Closes the loop in graphs that have a PR number but not the PR object
 * itself (e.g. comment-driven workflows where the PR comes from
 * commentBody parsing). Output `pr` plugs straight into data.pr-fields.
 */
export const githubFetchPrAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-fetch-pr');
    const target = resolveRepoTarget(params, context, 'github-fetch-pr');
    const client = new GitHubApiClient(token);
    const pr = await client.getPullRequest(target.owner, target.repo, target.number);
    return { pr, number: target.number, repo: `${target.owner}/${target.repo}` };
};
