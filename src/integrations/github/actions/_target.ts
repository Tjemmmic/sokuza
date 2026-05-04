import type { ActionContext, ActionHandler } from '../../../core/types.js';

/**
 * Shared owner/repo/number resolution + token guard for GitHub action
 * handlers. Centralised so every handler errors out with the same
 * message format and so we don't duplicate the precedence rules
 * (params → event metadata → event payload).
 */

type Params = Parameters<ActionHandler>[0];

export interface RepoTarget {
    owner: string;
    repo: string;
    /** Issue number, PR number, or 0 if the call doesn't need one. */
    number: number;
}

export function requireToken(params: Params, context: ActionContext, callerName: string): string {
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string)
        ?? (githubConfig?.token as string)
        ?? process.env.GITHUB_TOKEN
        ?? '';
    if (!token) {
        throw new Error(`${callerName}: a GitHub token is required (params.token, integrations.github.token, or GITHUB_TOKEN env var)`);
    }
    return token;
}

/**
 * Resolve owner/repo/number from a uniform set of inputs:
 *   - params.repo ("owner/name"), params.owner+repo_name, params.pr_number/issue_number/number
 *   - event.metadata.{repo,owner,repoName,prNumber,issueNumber}
 *   - event.payload.pull_request.number / event.payload.issue.number
 */
export function resolveRepoTarget(params: Params, context: ActionContext, callerName: string): RepoTarget {
    const meta = (context.event.metadata ?? {}) as Record<string, unknown>;
    const payload = (context.event.payload ?? {}) as Record<string, unknown>;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;

    const repoStr = (params.repo as string) ?? (meta.repo as string) ?? '';
    const owner = (params.owner as string)
        ?? (meta.owner as string)
        ?? (repoStr.includes('/') ? repoStr.split('/')[0] : '');
    const repo = (params.repo_name as string)
        ?? (meta.repoName as string)
        ?? (repoStr.includes('/') ? repoStr.split('/')[1] : '');

    const number = (params.number as number)
        ?? (params.pr_number as number)
        ?? (params.issue_number as number)
        ?? (meta.prNumber as number)
        ?? (meta.issueNumber as number)
        ?? (typeof pr?.number === 'number' ? pr.number : undefined)
        ?? (typeof issue?.number === 'number' ? issue.number : undefined)
        ?? 0;

    if (!owner || !repo) {
        throw new Error(`${callerName}: could not resolve owner/repo (provide params.repo as "owner/name" or fire from a GitHub event)`);
    }
    if (!number) {
        throw new Error(`${callerName}: could not resolve PR/issue number (provide params.number or fire from a GitHub PR/issue event)`);
    }
    return { owner, repo, number };
}
