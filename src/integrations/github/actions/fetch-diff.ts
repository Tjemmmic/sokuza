import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../../../core/diff-truncator.js';

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

    const diffResult = await client.getPullRequestDiffWithFallback(owner, repo, prNumber);

    let fileNames: string[];
    if (diffResult.files && diffResult.files.length > 0) {
        fileNames = diffResult.files.map((f) => f.filename as string);
    } else {
        const files = await client.getPullRequestFiles(owner, repo, prNumber);
        fileNames = files.map((f) => f.filename as string);
    }

    if (diffResult.source !== 'bulk') {
        context.logger.warn(
            {
                owner,
                repo,
                prNumber,
                source: diffResult.source,
                incompleteFiles: diffResult.incompleteFiles,
                fileCount: fileNames.length,
            },
            'Bulk diff unavailable, fell back to per-file patches',
        );
    } else {
        context.logger.info(
            { owner, repo, prNumber, fileCount: fileNames.length },
            'Fetched PR diff',
        );
    }

    let diff = diffResult.diff;
    let truncationSummary: string | undefined;

    const maxDiffChars = (params.max_diff_chars as number | undefined) ?? DEFAULT_MAX_CHARS;
    if (diff.length > maxDiffChars) {
        const truncated = truncateDiff(diff, maxDiffChars);
        diff = truncated.diff;
        truncationSummary = truncated.summary;
        context.logger.info(
            {
                originalChars: truncated.originalChars,
                finalChars: truncated.finalChars,
                totalFiles: truncated.totalFiles,
                truncated: truncated.truncatedFiles,
                skipped: truncated.skippedFiles,
            },
            'Diff truncated at fetch time',
        );
    }

    return {
        diff,
        files: fileNames,
        fileCount: fileNames.length,
        owner,
        repo,
        pr_number: prNumber,
        diff_source: diffResult.source,
        incomplete_files: diffResult.incompleteFiles,
        truncation: truncationSummary,
    };
};
