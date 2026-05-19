import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../../../core/diff-truncator.js';
import { resolveRepoTarget, requireToken } from './_target.js';

export const githubFetchDiffAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-fetch-diff');
    // `resolveRepoTarget` accepts `params.repo` as either "owner/name"
    // (what `data.pr-fields.repo` outputs and what the editor's
    // "Repository" port label implies) or just the bare name when
    // paired with `params.owner`. The previous bespoke resolver read
    // `repo` as the bare name only and produced a 404 when a graph
    // wired `pr_fields.repo → diff.repo`.
    const target = resolveRepoTarget(params, context, 'github-fetch-diff');
    const { owner, repo, number: prNumber } = target;

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
