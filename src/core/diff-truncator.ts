/**
 * Smart diff truncation for AI code review.
 *
 * Splits a unified diff into per-file patches, then truncates
 * large patches to fit within a character budget. Prioritizes
 * smaller files (more likely to be meaningful hand-written code)
 * and skips auto-generated or binary diffs.
 */

export type FileOutcomeStatus = 'included' | 'truncated' | 'skipped';
export type FileSkipReason = 'pattern' | 'budget';

/** Per-file outcome of a truncation pass. Populated in both the fast-path
 *  (everything fits) and the truncation path so downstream consumers can
 *  answer "what did we drop?" without re-parsing the diff. */
export interface TruncatedDiffFile {
    filename: string;
    originalBytes: number;
    /** Bytes kept in the final diff. 0 for skipped files. */
    finalBytes: number;
    status: FileOutcomeStatus;
    /** Present only when status === 'skipped'. */
    skipReason?: FileSkipReason;
}

export interface TruncatedDiff {
    /** The truncated diff text, ready for the AI */
    diff: string;
    /** Summary header describing what was included */
    summary: string;
    /** Total number of files in the original diff */
    totalFiles: number;
    /** Number of files fully included */
    fullyIncludedFiles: number;
    /** Number of files truncated */
    truncatedFiles: number;
    /** Number of files skipped entirely */
    skippedFiles: number;
    /** Original character count */
    originalChars: number;
    /** Final character count */
    finalChars: number;
    /** Per-file outcome. Fast path preserves input order; truncation path
     *  emits pattern-skipped files first, then reviewable files in the
     *  size-sorted order used for budget allocation. */
    files: TruncatedDiffFile[];
}

interface FilePatch {
    filename: string;
    header: string;
    content: string;
    lines: number;
}

// ─── Default Config ─────────────────────────────────────────────────────────

/** Default max prompt size in characters (~25K tokens ≈ 100K chars) */
export const DEFAULT_MAX_CHARS = 100_000;

/** File extensions that are usually auto-generated or not worth reviewing */
const SKIP_PATTERNS = [
    /\.lock$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\.js$/,
    /\.min\.css$/,
    /\.map$/,
    /\.snap$/,
    /\.generated\./,
    /dist\//,
    /build\//,
    /node_modules\//,
];

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Truncate a unified diff to fit within a character budget.
 *
 * Strategy:
 * 1. Split into per-file patches
 * 2. Skip auto-generated/lock files
 * 3. Sort by size (smallest first — more likely meaningful changes)
 * 4. Allocate budget evenly, then redistribute unused budget
 * 5. Truncate oversized patches at the line level
 */
export function truncateDiff(
    rawDiff: string,
    maxChars: number = DEFAULT_MAX_CHARS,
): TruncatedDiff {
    const originalChars = rawDiff.length;

    // If it fits, return as-is
    if (originalChars <= maxChars) {
        const patches = splitIntoPatches(rawDiff);
        const files: TruncatedDiffFile[] = patches.map((p) => {
            const bytes = patchBytes(p);
            return {
                filename: p.filename,
                originalBytes: bytes,
                finalBytes: bytes,
                status: 'included',
            };
        });
        return {
            diff: rawDiff,
            summary: `${patches.length} files changed (${originalChars.toLocaleString()} chars)`,
            totalFiles: patches.length,
            fullyIncludedFiles: patches.length,
            truncatedFiles: 0,
            skippedFiles: 0,
            originalChars,
            finalChars: originalChars,
            files,
        };
    }

    // Split into per-file patches
    const patches = splitIntoPatches(rawDiff);
    const totalFiles = patches.length;

    // Separate into reviewable and skippable
    const skippable: FilePatch[] = [];
    const reviewable: FilePatch[] = [];

    for (const patch of patches) {
        if (shouldSkipFile(patch.filename)) {
            skippable.push(patch);
        } else {
            reviewable.push(patch);
        }
    }

    // Sort reviewable by size ascending (smallest first)
    reviewable.sort((a, b) => a.content.length - b.content.length);

    // Reserve space for the summary header (~500 chars)
    const headerReserve = 500;
    let remainingBudget = maxChars - headerReserve;
    const perFileBudget = Math.floor(remainingBudget / Math.max(reviewable.length, 1));

    const outputParts: string[] = [];
    const files: TruncatedDiffFile[] = [];
    let fullyIncluded = 0;
    let truncatedCount = 0;

    // Record pattern-skipped files up front; they never get a budget chance.
    for (const patch of skippable) {
        files.push({
            filename: patch.filename,
            originalBytes: patchBytes(patch),
            finalBytes: 0,
            status: 'skipped',
            skipReason: 'pattern',
        });
    }

    for (const patch of reviewable) {
        const patchText = `${patch.header}\n${patch.content}`;
        const originalBytes = patchText.length;

        if (patchText.length <= perFileBudget || patchText.length <= remainingBudget) {
            outputParts.push(patchText);
            remainingBudget -= patchText.length;
            fullyIncluded++;
            files.push({
                filename: patch.filename,
                originalBytes,
                finalBytes: patchText.length,
                status: 'included',
            });
        } else if (remainingBudget > 500) {
            const truncated = truncatePatch(patch, Math.min(remainingBudget, perFileBudget));
            outputParts.push(truncated);
            remainingBudget -= truncated.length;
            truncatedCount++;
            files.push({
                filename: patch.filename,
                originalBytes,
                finalBytes: truncated.length,
                status: 'truncated',
            });
        } else {
            files.push({
                filename: patch.filename,
                originalBytes,
                finalBytes: 0,
                status: 'skipped',
                skipReason: 'budget',
            });
        }
    }

    const skippedCount = files.filter((f) => f.status === 'skipped').length;
    const diff = outputParts.join('\n');

    const summaryParts = [
        `${totalFiles} files changed`,
        `${fullyIncluded} shown in full`,
    ];
    if (truncatedCount > 0) summaryParts.push(`${truncatedCount} truncated`);
    if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped (lock files, generated code, etc.)`);
    const summary = summaryParts.join(', ');

    return {
        diff,
        summary,
        totalFiles,
        fullyIncludedFiles: fullyIncluded,
        truncatedFiles: truncatedCount,
        skippedFiles: skippedCount,
        originalChars,
        finalChars: diff.length,
        files,
    };
}

function patchBytes(patch: FilePatch): number {
    // Matches the concatenation used when emitting `${header}\n${content}`.
    return patch.header.length + 1 + patch.content.length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Split a unified diff into per-file patches */
function splitIntoPatches(rawDiff: string): FilePatch[] {
    const patches: FilePatch[] = [];
    // Match "diff --git a/... b/..." lines
    const parts = rawDiff.split(/(?=^diff --git )/m);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed || !trimmed.startsWith('diff --git')) continue;

        // Extract filename from the diff header
        const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\//);
        const filename = headerMatch?.[1] ?? 'unknown';

        // Split header from content at the first hunk
        const hunkStart = trimmed.indexOf('\n@@');
        let header: string;
        let content: string;

        if (hunkStart !== -1) {
            header = trimmed.slice(0, hunkStart);
            content = trimmed.slice(hunkStart + 1);
        } else {
            header = trimmed;
            content = '';
        }

        patches.push({
            filename,
            header,
            content,
            lines: content.split('\n').length,
        });
    }

    return patches;
}

/** Check if a file should be skipped based on its path */
function shouldSkipFile(filename: string): boolean {
    return SKIP_PATTERNS.some(pattern => pattern.test(filename));
}

/** Truncate a single file patch to fit within a character budget */
function truncatePatch(patch: FilePatch, budget: number): string {
    const headerLine = patch.header;
    const lines = patch.content.split('\n');
    const result: string[] = [headerLine];
    let used = headerLine.length;
    let includedLines = 0;

    for (const line of lines) {
        if (used + line.length + 1 > budget - 100) { // Reserve 100 chars for truncation message
            break;
        }
        result.push(line);
        used += line.length + 1;
        includedLines++;
    }

    const omittedLines = lines.length - includedLines;
    if (omittedLines > 0) {
        result.push(`\n... [${omittedLines} lines truncated from ${patch.filename}]`);
    }

    return result.join('\n');
}
