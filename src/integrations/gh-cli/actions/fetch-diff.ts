/**
 * GH CLI powered fetch-diff action.
 * Uses `gh pr diff` and `gh pr view --json files` — no token needed.
 */

import type { ActionHandler } from '../../../core/types.js';
import { ghText, ghJson } from '../exec.js';

export const ghFetchDiffAction: ActionHandler = async (params, context) => {
    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;

    const owner = (params.owner as string)
        ?? (context.event.metadata.owner as string);
    const repo = (params.repo as string)
        ?? (context.event.metadata.repoName as string);
    const prNumber = (params.pr_number as number)
        ?? (context.event.metadata.prNumber as number)
        ?? (pr?.number as number);

    if (!owner || !repo || !prNumber) {
        throw new Error('github-fetch-diff: could not determine owner, repo, or pr_number');
    }

    const repoSlug = `${owner}/${repo}`;

    context.logger.info({ owner, repo, prNumber }, 'Fetching PR diff via gh CLI');

    // Fetch diff
    const diff = await ghText([
        'pr', 'diff', String(prNumber),
        '-R', repoSlug,
        '--color', 'never',
    ], { timeout: 30_000 });

    // Fetch file list
    const prData = await ghJson<{ files: Array<{ path: string; additions: number; deletions: number }> }>([
        'pr', 'view', String(prNumber),
        '-R', repoSlug,
        '--json', 'files',
    ]);

    const fileNames = (prData.files ?? []).map((f) => f.path);

    context.logger.info({ owner, repo, prNumber, fileCount: fileNames.length }, 'Fetched PR diff');

    return {
        diff,
        files: fileNames,
        fileCount: fileNames.length,
        owner,
        repo,
        pr_number: prNumber,
    };
};
