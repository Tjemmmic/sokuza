import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "github-fetch-diff" action.
 *
 * Fetches the unified diff and file list for a pull request.
 * Automatically extracts owner/repo/pr_number from the event payload,
 * or they can be provided as explicit params.
 *
 * Returns: { diff, files, owner, repo, pr_number }
 */
export const githubFetchDiffAction: ActionHandler = async (params, context) => {
    const githubConfig = context.integrationConfigs.github;
    const token = (params.token as string) ?? (githubConfig?.token as string);

    if (!token) {
        throw new Error(
            'github-fetch-diff requires a GitHub token. Set integrations.github.token in config or pass params.token.',
        );
    }

    const pr = context.event.payload.pull_request as Record<string, unknown> | undefined;

    const owner =
        (params.owner as string) ??
        (context.event.metadata.owner as string | undefined);

    const repo =
        (params.repo as string) ??
        (context.event.metadata.repoName as string | undefined);

    const prNumber =
        (params.pr_number as number) ??
        (context.event.metadata.prNumber as number | undefined) ??
        (pr?.number as number | undefined);

    if (!owner || !repo || !prNumber) {
        throw new Error(
            'github-fetch-diff: could not determine owner, repo, or pr_number from event payload or params.',
        );
    }

    const client = new GitHubApiClient(token);

    context.logger.info(
        { owner, repo, prNumber },
        'Fetching PR diff from GitHub',
    );

    const [diff, files] = await Promise.all([
        client.getPullRequestDiff(owner, repo, prNumber),
        client.getPullRequestFiles(owner, repo, prNumber),
    ]);

    const fileNames = files.map((f) => f.filename as string);

    context.logger.info(
        { owner, repo, prNumber, fileCount: fileNames.length },
        'Fetched PR diff',
    );

    return {
        diff,
        files: fileNames,
        fileCount: fileNames.length,
        owner,
        repo,
        pr_number: prNumber,
    };
};
