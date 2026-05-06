import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-update-pr" — PATCH a PR. Pass any subset of {title, body,
 * state, base} and only those fields are sent. Used for closing PRs
 * (state="closed"), retitling, retargeting, etc.
 */
export const githubUpdatePrAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-update-pr');
    const target = resolveRepoTarget(params, context, 'github-update-pr');
    const client = new GitHubApiClient(token);
    const updated = await client.updatePullRequest(target.owner, target.repo, target.number, {
        title: params.title as string | undefined,
        body: params.body as string | undefined,
        state: params.state as 'open' | 'closed' | undefined,
        base: params.base as string | undefined,
    });
    return {
        url: updated.html_url,
        // `newState` is the canonical port name; `state` stays as an alias
        // so workflows authored before the rename keep resolving.
        newState: updated.state,
        state: updated.state,
        number: target.number,
    };
};
