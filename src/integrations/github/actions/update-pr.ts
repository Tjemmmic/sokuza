import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/** Treat an empty string the same as `undefined`. The graph runtime's
 *  actionNode wrapper already drops empty inputs, but the legacy steps
 *  executor in workflow.ts forwards interpolated empty strings ("" when a
 *  {{...}} placeholder fails to resolve) verbatim. Without this guard a
 *  legacy workflow that passes `body: "{{steps.x.unset}}"` would PATCH
 *  the PR with body="", silently blanking the description on GitHub.
 *
 *  Exported for unit testing — every regression in the empty-string
 *  contract has caused real PR data loss in past incidents, so the
 *  function is pinned at the unit level too. */
export function emptyToUndef(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    return v.length === 0 ? undefined : v;
}

export const VALID_PR_STATES = ['open', 'closed'] as const;
export type PrState = typeof VALID_PR_STATES[number];

/** Coerce params.state to GitHub's accepted state values. Anything not
 *  in the whitelist (e.g. 'draft', 'merged', or a typo'd 'opened') is
 *  rejected up front rather than passed through to GitHub which would
 *  return an opaque 422. The previous `as 'open' | 'closed' | undefined`
 *  assertion let invalid values slip past TypeScript.
 *
 *  Exported for unit testing — a regression that adds 'draft' to the
 *  list (or drops 'closed') would otherwise only surface in production. */
export function validateState(raw: string | undefined): PrState | undefined {
    if (raw === undefined) return undefined;
    if ((VALID_PR_STATES as readonly string[]).includes(raw)) return raw as PrState;
    throw new Error(
        `github-update-pr: state must be one of ${VALID_PR_STATES.join(', ')} (got ${JSON.stringify(raw)})`,
    );
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
        state: validateState(emptyToUndef(params.state)),
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
