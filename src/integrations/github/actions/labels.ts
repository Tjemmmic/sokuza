import type { ActionHandler } from '../../../core/types.js';
import { GitHubApiClient } from '../api.js';

/**
 * "github-add-label" / "github-remove-label" actions.
 *
 * Used by sokuza slash-command workflows (`/sokuza skip` /
 * `/sokuza unskip`) and by the address-review action's in-flight lock
 * label. Auto-resolves owner/repo/number from the event metadata when
 * not specified in params.
 */

function resolveTarget(
    params: Record<string, unknown>,
    context: Parameters<ActionHandler>[1],
): { owner: string; repo: string; number: number; token: string } {
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string) ?? (githubConfig?.token as string) ?? process.env.GITHUB_TOKEN!;
    if (!token) throw new Error('label action requires a GitHub token');

    const meta = context.event.metadata ?? {};
    const pr = context.event.payload?.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload?.issue as Record<string, unknown> | undefined;
    const repoStr = (params.repo as string) ?? (meta.repo as string);
    const owner = (params.owner as string)
        ?? (meta.owner as string)
        ?? (repoStr ? repoStr.split('/')[0] : undefined);
    const repo = (params.repo_name as string)
        ?? (meta.repoName as string)
        ?? (repoStr ? repoStr.split('/')[1] : undefined);
    const number = (params.number as number)
        ?? (meta.prNumber as number)
        ?? (pr?.number as number)
        ?? (issue?.number as number);
    if (!owner || !repo || typeof number !== 'number') {
        throw new Error('label action: could not resolve owner/repo/number from event');
    }
    return { owner, repo, number, token };
}

export const githubAddLabelAction: ActionHandler = async (params, context) => {
    const { owner, repo, number, token } = resolveTarget(params, context);
    const labelsParam = params.label ?? params.labels;
    const labels = Array.isArray(labelsParam) ? labelsParam : [labelsParam];
    const cleaned = labels.filter((l): l is string => typeof l === 'string' && l.length > 0);
    if (cleaned.length === 0) throw new Error('github-add-label: at least one label required');
    const client = new GitHubApiClient(token);
    await client.addLabels(owner, repo, number, cleaned);
    return { success: true, appliedLabels: cleaned, owner, repo, number };
};

export const githubRemoveLabelAction: ActionHandler = async (params, context) => {
    const { owner, repo, number, token } = resolveTarget(params, context);
    const label = params.label as string | undefined;
    if (!label) throw new Error('github-remove-label: label required');
    const client = new GitHubApiClient(token);
    await client.removeLabel(owner, repo, number, label);
    return { success: true, removedLabel: label, owner, repo, number };
};
