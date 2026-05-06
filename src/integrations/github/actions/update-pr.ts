import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/** Treat an empty string the same as `undefined`. The graph runtime's
 *  actionNode wrapper already drops empty inputs, but the legacy steps
 *  executor in workflow.ts forwards interpolated empty strings ("" when a
 *  {{...}} placeholder fails to resolve) verbatim. Without this guard a
 *  legacy workflow that passes `body: "{{steps.x.unset}}"` would PATCH
 *  the PR with body="", silently blanking the description on GitHub. */
function emptyToUndef(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    return v.length === 0 ? undefined : v;
}

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
        title: emptyToUndef(params.title),
        body: emptyToUndef(params.body),
        state: emptyToUndef(params.state) as 'open' | 'closed' | undefined,
        base: emptyToUndef(params.base),
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
