import { describe, it, expect } from 'vitest';
import { assembleDiffFromFiles } from './diff-assembler.js';
import type { AssembledDiff } from './diff-assembler.js';

interface FileEntry {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null | undefined;
}

describe('assembleDiffFromFiles', () => {
    it('returns file-patches source when all files have patches', () => {
        const files: FileEntry[] = [
            { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@ -1,3 +1,5 @@\n+new line' },
            { filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -10 +10,2 @@\n+extra' },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.source).toBe('file-patches');
        expect(result.incompleteFiles).toEqual([]);
        expect(result.diff).toContain('src/a.ts');
        expect(result.diff).toContain('src/b.ts');
    });

    it('tracks incomplete files when some patches are null', () => {
        const files: FileEntry[] = [
            { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@ -1 +1 @@\n+fix' },
            { filename: 'src/large.ts', status: 'modified', additions: 500, deletions: 300, patch: null },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.source).toBe('file-patches');
        expect(result.incompleteFiles).toEqual(['src/large.ts']);
    });

    it('returns summary source when no files have patches', () => {
        const files: FileEntry[] = [
            { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: null },
            { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0, patch: undefined },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.source).toBe('summary');
        expect(result.incompleteFiles).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('formats added files with new file mode and /dev/null', () => {
        const files: FileEntry[] = [
            { filename: 'src/new.ts', status: 'added', additions: 20, deletions: 0, patch: '@@ -0,0 +1,20 @@\n+content' },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.diff).toContain('new file mode 100644');
        expect(result.diff).toContain('--- /dev/null');
        expect(result.diff).toContain('+++ b/src/new.ts');
    });

    it('formats removed files with deleted file mode and /dev/null', () => {
        const files: FileEntry[] = [
            { filename: 'src/old.ts', status: 'removed', additions: 0, deletions: 15, patch: '@@ -1,15 +0,0 @@\n-old' },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.diff).toContain('deleted file mode 100644');
        expect(result.diff).toContain('--- a/src/old.ts');
        expect(result.diff).toContain('+++ /dev/null');
    });

    it('formats modified files with a/ and b/ prefixes', () => {
        const files: FileEntry[] = [
            { filename: 'src/mod.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@\n+change' },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.diff).toContain('--- a/src/mod.ts');
        expect(result.diff).toContain('+++ b/src/mod.ts');
        expect(result.diff).not.toContain('new file mode');
        expect(result.diff).not.toContain('deleted file mode');
    });

    it('handles empty file list', () => {
        const result = assembleDiffFromFiles([]);

        expect(result.diff).toBe('');
        expect(result.source).toBe('summary');
        expect(result.incompleteFiles).toEqual([]);
    });

    it('handles a single file', () => {
        const files: FileEntry[] = [
            { filename: 'solo.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-fix\n+fix2' },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.source).toBe('file-patches');
        expect(result.incompleteFiles).toEqual([]);
        expect(result.diff).toContain('diff --git a/solo.ts b/solo.ts');
    });

    it('includes status, additions, and deletions in summary format', () => {
        const files: FileEntry[] = [
            { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: null },
            { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0, patch: undefined },
        ];
        const result = assembleDiffFromFiles(files);

        expect(result.diff).toContain('modified');
        expect(result.diff).toContain('(+5 -2)');
        expect(result.diff).toContain('added');
        expect(result.diff).toContain('(+10 -0)');
    });
});
