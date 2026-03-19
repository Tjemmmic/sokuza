import { describe, it, expect } from 'vitest';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../core/diff-truncator.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Generate a fake patch for a file */
function makePatch(filename: string, lines: number): string {
    const content = Array.from({ length: lines }, (_, i) =>
        `+line ${i + 1} of ${filename}`
    ).join('\n');
    return `diff --git a/${filename} b/${filename}
index 1234567..abcdefg 100644
--- a/${filename}
+++ b/${filename}
@@ -0,0 +1,${lines} @@
${content}`;
}

/** Create a multi-file diff */
function makeMultiDiff(files: Array<{ name: string; lines: number }>): string {
    return files.map(f => makePatch(f.name, f.lines)).join('\n');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('truncateDiff', () => {
    it('should return small diffs unchanged', () => {
        const diff = makePatch('src/foo.ts', 5);
        const result = truncateDiff(diff, DEFAULT_MAX_CHARS);

        expect(result.diff).toBe(diff);
        expect(result.totalFiles).toBe(1);
        expect(result.fullyIncludedFiles).toBe(1);
        expect(result.truncatedFiles).toBe(0);
        expect(result.skippedFiles).toBe(0);
        expect(result.originalChars).toBe(result.finalChars);
    });

    it('should truncate very large diffs', () => {
        // Create a diff with 10K lines (way over 1000 char budget)
        const diff = makePatch('src/big.ts', 10000);
        const result = truncateDiff(diff, 1000);

        expect(result.finalChars).toBeLessThanOrEqual(1000);
        expect(result.originalChars).toBeGreaterThan(1000);
        // File is either truncated or skipped entirely if budget is very tight
        expect(result.truncatedFiles + result.skippedFiles).toBeGreaterThanOrEqual(1);
    });

    it('should skip lock files', () => {
        const diff = makeMultiDiff([
            { name: 'src/index.ts', lines: 5 },
            { name: 'package-lock.json', lines: 5000 },
        ]);
        const result = truncateDiff(diff, 2000);

        expect(result.skippedFiles).toBe(1);
        expect(result.diff).toContain('src/index.ts');
        expect(result.diff).not.toContain('package-lock.json');
    });

    it('should skip yarn.lock, pnpm-lock.yaml, and .min.js files', () => {
        const diff = makeMultiDiff([
            { name: 'src/app.ts', lines: 5 },
            { name: 'yarn.lock', lines: 100 },
            { name: 'pnpm-lock.yaml', lines: 100 },
            { name: 'dist/bundle.min.js', lines: 100 },
        ]);
        const result = truncateDiff(diff, 3000);

        expect(result.skippedFiles).toBe(3);
        expect(result.diff).toContain('src/app.ts');
    });

    it('should prioritize smaller files (more meaningful changes)', () => {
        const diff = makeMultiDiff([
            { name: 'src/big-generated.ts', lines: 500 },
            { name: 'src/small-fix.ts', lines: 3 },
        ]);
        // Very tight budget — only room for the small file
        const result = truncateDiff(diff, 800);

        expect(result.diff).toContain('src/small-fix.ts');
        expect(result.fullyIncludedFiles).toBeGreaterThanOrEqual(1);
    });

    it('should handle multiple files with partial inclusion', () => {
        const diff = makeMultiDiff([
            { name: 'src/a.ts', lines: 10 },
            { name: 'src/b.ts', lines: 10 },
            { name: 'src/c.ts', lines: 10 },
        ]);
        const result = truncateDiff(diff, 1500);

        expect(result.totalFiles).toBe(3);
        expect(result.fullyIncludedFiles + result.truncatedFiles).toBeGreaterThanOrEqual(1);
    });

    it('should include summary metadata', () => {
        const diff = makeMultiDiff([
            { name: 'src/a.ts', lines: 5 },
            { name: 'src/b.ts', lines: 5 },
        ]);
        const result = truncateDiff(diff, DEFAULT_MAX_CHARS);

        expect(result.summary).toContain('2 files changed');
    });

    it('should handle empty diff', () => {
        const result = truncateDiff('', DEFAULT_MAX_CHARS);
        expect(result.totalFiles).toBe(0);
        expect(result.diff).toBe('');
    });

    it('should preserve diff structure in output', () => {
        const diff = makePatch('src/foo.ts', 3);
        const result = truncateDiff(diff, DEFAULT_MAX_CHARS);

        expect(result.diff).toContain('diff --git');
        expect(result.diff).toContain('@@');
        expect(result.diff).toContain('+line 1');
    });
});
