import type { ActionHandler } from '../../../core/types.js';
import { ghText, ghJson, ghExec } from '../exec.js';
import { assembleDiffFromFiles } from '../../../core/diff-assembler.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../../../core/diff-truncator.js';

const DIFF_TOO_LARGE_PATTERNS = [
    'diff exceeded the maximum',
    'too_large',
    'HTTP 406',
];

function isDiffTooLargeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return DIFF_TOO_LARGE_PATTERNS.some((p) => msg.includes(p));
}

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

    let diff: string;
    let diffSource: 'bulk' | 'file-patches' | 'summary' = 'bulk';
    let incompleteFiles: string[] = [];

    try {
        diff = await ghText([
            'pr', 'diff', String(prNumber),
            '-R', repoSlug,
            '--color', 'never',
        ], { timeout: 30_000 });
    } catch (err) {
        if (!isDiffTooLargeError(err)) throw err;

        context.logger.warn(
            { owner, repo, prNumber },
            'gh pr diff failed (diff too large), falling back to per-file patches via gh api',
        );

        const fileEntries = await fetchFileEntriesViaGhApi(owner, repo, prNumber);
        const assembled = assembleDiffFromFiles(fileEntries);
        diff = assembled.diff;
        diffSource = assembled.source;
        incompleteFiles = assembled.incompleteFiles;
    }

    const prData = await ghJson<{ files: Array<{ path: string; additions: number; deletions: number }> }>([
        'pr', 'view', String(prNumber),
        '-R', repoSlug,
        '--json', 'files',
    ]);

    const fileNames = (prData.files ?? []).map((f) => f.path);

    if (diffSource !== 'bulk') {
        context.logger.warn(
            { owner, repo, prNumber, source: diffSource, incompleteFiles, fileCount: fileNames.length },
            'Used fallback diff source',
        );
    } else {
        context.logger.info({ owner, repo, prNumber, fileCount: fileNames.length }, 'Fetched PR diff');
    }

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
        diff_source: diffSource,
        incomplete_files: incompleteFiles,
        truncation: truncationSummary,
    };
};

async function fetchFileEntriesViaGhApi(
    owner: string,
    repo: string,
    prNumber: number,
): Promise<Array<{ filename: string; status: string; additions: number; deletions: number; patch: string | null | undefined }>> {
    const allFiles: Array<Record<string, unknown>> = [];
    let page = 1;
    const perPage = 100;

    while (true) {
        const result = await ghExec([
            'api',
            `repos/${owner}/${repo}/pulls/${prNumber}/files?page=${page}&per_page=${perPage}`,
        ], { timeout: 30_000 });

        if (result.exitCode !== 0) {
            throw new Error(`gh api files failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
        }

        const pageFiles = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
        allFiles.push(...pageFiles);

        if (pageFiles.length < perPage) break;
        page++;
    }

    return allFiles.map((f) => ({
        filename: f.filename as string,
        status: f.status as string,
        additions: f.additions as number,
        deletions: f.deletions as number,
        patch: f.patch as string | null | undefined,
    }));
}
