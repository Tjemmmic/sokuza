/**
 * GH CLI powered create-pr action.
 * Uses `gh pr create` — no token needed.
 */

import type { ActionHandler } from '../../../core/types.js';
import { ghExec } from '../exec.js';

export const ghCreatePrAction: ActionHandler = async (params, context) => {
    const owner = (params.owner as string) ?? (context.event.metadata.owner as string);
    const repo = (params.repo as string) ?? (context.event.metadata.repoName as string);
    const title = params.title as string;
    const body = params.body as string;
    const head = params.head as string;
    const base = (params.base as string) ?? 'main';

    if (!owner || !repo) {
        throw new Error('github-create-pr: could not determine owner/repo');
    }
    if (!title) {
        throw new Error('github-create-pr: "title" is required');
    }
    if (!head) {
        throw new Error('github-create-pr: "head" branch is required');
    }

    const repoSlug = `${owner}/${repo}`;

    context.logger.info({ owner, repo, title, head, base }, 'Creating PR via gh CLI');

    const args = [
        'pr', 'create',
        '-R', repoSlug,
        '-t', title,
        '-B', base,
        '-H', head,
    ];

    if (body) {
        args.push('-b', body);
    }

    const result = await ghExec(args, { timeout: 15_000, cwd: params.workdir as string });

    if (result.exitCode !== 0) {
        throw new Error(`gh pr create failed: ${result.stderr.trim()}`);
    }

    // gh pr create outputs the PR URL
    const prUrl = result.stdout.trim();

    context.logger.info({ owner, repo, prUrl }, 'PR created via gh CLI');

    return {
        url: prUrl,
        html_url: prUrl,
    };
};
