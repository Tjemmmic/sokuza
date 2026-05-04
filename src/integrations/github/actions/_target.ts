import type { ActionContext, ActionHandler } from '../../../core/types.js';

/**
 * Shared owner/repo/number resolution + token guard for GitHub action
 * handlers. Centralised so every handler errors out with the same
 * message format and so we don't duplicate the precedence rules
 * (params → event metadata → event payload).
 *
 * Precedence is enforced by `firstNonEmpty()` rather than `??`, because
 * UI form fields commonly post empty strings ('', 0) for "not set" — we
 * don't want a stray empty input to overshadow real metadata downstream.
 */

type Params = Parameters<ActionHandler>[0];

export interface RepoTarget {
    owner: string;
    repo: string;
    /** Issue number or PR number. Always > 0 (else the resolver throws). */
    number: number;
}

/** Walks the chain and returns the first value that's not undefined / null /
 *  empty string. Numeric 0 is also treated as "not set" because the contexts
 *  here (issue/PR numbers, etc.) never legitimately use 0. */
function firstNonEmpty<T>(...candidates: Array<T | undefined | null>): T | undefined {
    for (const c of candidates) {
        if (c === undefined || c === null) continue;
        if (typeof c === 'string' && c === '') continue;
        if (typeof c === 'number' && (c === 0 || !Number.isFinite(c))) continue;
        return c;
    }
    return undefined;
}

export function requireToken(params: Params, context: ActionContext, callerName: string): string {
    const githubConfig = context.integrationConfigs.github;
    const token = firstNonEmpty(
        params.token as string | undefined,
        githubConfig?.token as string | undefined,
        process.env.GITHUB_TOKEN,
    );
    if (!token) {
        throw new Error(`${callerName}: a GitHub token is required (params.token, integrations.github.token, or GITHUB_TOKEN env var)`);
    }
    return token;
}

/**
 * Split an "owner/name" string. Returns undefined for any input that doesn't
 * have exactly two non-empty segments — callers should treat that as "not
 * supplied" so the next link of the precedence chain wins.
 */
function splitRepo(raw: string | undefined): { owner: string; repo: string } | undefined {
    if (!raw) return undefined;
    const parts = raw.split('/');
    if (parts.length !== 2) return undefined;
    const [owner, repo] = parts;
    if (!owner || !repo) return undefined;
    return { owner, repo };
}

/**
 * Resolve owner/repo/number from a uniform set of inputs:
 *   - params.repo ("owner/name"), params.owner+repo_name, params.pr_number/issue_number/number
 *   - event.metadata.{repo,owner,repoName,prNumber,issueNumber}
 *   - event.payload.pull_request.number / event.payload.issue.number
 *
 * Each layer is consulted in order; empty strings and zeros count as "not
 * supplied" (see firstNonEmpty), so a UI field left blank won't overshadow
 * a perfectly good event metadata value.
 */
export function resolveRepoTarget(params: Params, context: ActionContext, callerName: string): RepoTarget {
    const meta = (context.event.metadata ?? {}) as Record<string, unknown>;
    const payload = (context.event.payload ?? {}) as Record<string, unknown>;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;

    const paramsRepoSplit = splitRepo(firstNonEmpty(params.repo as string | undefined));
    const metaRepoSplit = splitRepo(firstNonEmpty(meta.repo as string | undefined));

    const owner = firstNonEmpty(
        params.owner as string | undefined,
        meta.owner as string | undefined,
        paramsRepoSplit?.owner,
        metaRepoSplit?.owner,
    );
    const repo = firstNonEmpty(
        params.repo_name as string | undefined,
        meta.repoName as string | undefined,
        paramsRepoSplit?.repo,
        metaRepoSplit?.repo,
    );

    const number = firstNonEmpty(
        params.number as number | undefined,
        params.pr_number as number | undefined,
        params.issue_number as number | undefined,
        meta.prNumber as number | undefined,
        meta.issueNumber as number | undefined,
        typeof pr?.number === 'number' ? pr.number : undefined,
        typeof issue?.number === 'number' ? issue.number : undefined,
    );

    // Only complain about a malformed params.repo when *no* other source
    // resolved owner+repo. A workflow that supplies params.owner+repo_name
    // alongside an accidentally-bad params.repo (e.g. URL paste) would
    // otherwise fail loudly even though we have everything we need.
    if (!owner || !repo) {
        if (typeof params.repo === 'string' && params.repo.length > 0 && !paramsRepoSplit) {
            throw new Error(`${callerName}: params.repo must be "owner/name" (got "${params.repo}")`);
        }
        throw new Error(`${callerName}: could not resolve owner/repo (provide params.repo as "owner/name" or fire from a GitHub event)`);
    }
    if (!number) {
        throw new Error(`${callerName}: could not resolve PR/issue number (provide params.number or fire from a GitHub PR/issue event)`);
    }
    return { owner, repo, number };
}
