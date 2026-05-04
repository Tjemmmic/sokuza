import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-fetch-issue" — round-trip issue lookup by number. Output
 * `issue` plugs straight into data.issue-fields.
 */
export const githubFetchIssueAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-fetch-issue');
    const target = resolveRepoTarget(params, context, 'github-fetch-issue');
    const client = new GitHubApiClient(token);
    const issue = await client.getIssue(target.owner, target.repo, target.number);
    return { issue, number: target.number, repo: `${target.owner}/${target.repo}` };
};
