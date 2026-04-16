import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubApiClient } from '../integrations/github/api.js';
import { truncateDiff } from '../core/diff-truncator.js';

describe('GitHubApiClient', () => {
    const token = 'test-token-123';
    let client: GitHubApiClient;

    beforeEach(() => {
        client = new GitHubApiClient(token);
        vi.restoreAllMocks();
    });

    it('should fetch a pull request', async () => {
        const mockPr = { number: 1, title: 'Test PR' };

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify(mockPr), { status: 200 }),
        );

        const result = await client.getPullRequest('owner', 'repo', 1);
        expect(result).toEqual(mockPr);

        const fetchCall = vi.mocked(fetch).mock.calls[0];
        expect(fetchCall[0]).toBe('https://api.github.com/repos/owner/repo/pulls/1');
        expect(fetchCall[1]?.headers).toHaveProperty('Authorization', `Bearer ${token}`);
    });

    it('should fetch a PR diff as text', async () => {
        const mockDiff = 'diff --git a/file.ts b/file.ts\n+new line\n-old line';

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(mockDiff, { status: 200 }),
        );

        const result = await client.getPullRequestDiff('owner', 'repo', 1);
        expect(result).toBe(mockDiff);

        const fetchCall = vi.mocked(fetch).mock.calls[0];
        expect(fetchCall[1]?.headers).toHaveProperty(
            'Accept',
            'application/vnd.github.diff',
        );
    });

    it('should fetch PR files', async () => {
        const mockFiles = [
            { filename: 'src/a.ts', status: 'modified' },
            { filename: 'src/b.ts', status: 'added' },
        ];

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify(mockFiles), { status: 200 }),
        );

        const result = await client.getPullRequestFiles('owner', 'repo', 1);
        expect(result).toHaveLength(2);
        expect(result[0].filename).toBe('src/a.ts');
    });

    it('should paginate through PR files', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}.ts` }));
        const page2 = [{ filename: 'file100.ts' }];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

        const result = await client.getPullRequestFiles('owner', 'repo', 1);
        expect(result).toHaveLength(101);

        const call1Url = vi.mocked(fetch).mock.calls[0][0];
        const call2Url = vi.mocked(fetch).mock.calls[1][0];
        expect(call1Url).toContain('page=1');
        expect(call2Url).toContain('page=2');
    });

    it('should create a comment', async () => {
        const mockComment = { id: 123, body: 'Great PR!' };

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify(mockComment), { status: 201 }),
        );

        const result = await client.createComment('owner', 'repo', 1, 'Great PR!');
        expect(result.id).toBe(123);

        const fetchCall = vi.mocked(fetch).mock.calls[0];
        expect(fetchCall[0]).toBe('https://api.github.com/repos/owner/repo/issues/1/comments');
        expect(fetchCall[1]?.method).toBe('POST');
    });

    it('should create a review', async () => {
        const mockReview = { id: 456, state: 'COMMENTED' };

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify(mockReview), { status: 200 }),
        );

        const result = await client.createReview('owner', 'repo', 1, 'Looks good', 'COMMENT');
        expect(result.id).toBe(456);

        const fetchCall = vi.mocked(fetch).mock.calls[0];
        expect(fetchCall[0]).toBe('https://api.github.com/repos/owner/repo/pulls/1/reviews');
    });

    it('should throw on API error', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response('Not found', { status: 404, statusText: 'Not Found' }),
        );

        await expect(client.getPullRequest('owner', 'repo', 999)).rejects.toThrow(
            'GitHub API error fetching PR: 404 Not Found',
        );
    });
});

describe('getPullRequestDiffWithFallback', () => {
    const token = 'test-token-123';
    let client: GitHubApiClient;

    beforeEach(() => {
        client = new GitHubApiClient(token);
        vi.restoreAllMocks();
    });

    it('should return bulk diff when available', async () => {
        const mockDiff = 'diff --git a/file.ts b/file.ts\n+new line';

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(mockDiff, { status: 200 }),
        );

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.source).toBe('bulk');
        expect(result.diff).toBe(mockDiff);
        expect(result.incompleteFiles).toEqual([]);
    });

    it('should fall back to file patches on HTTP 406', async () => {
        const mockFiles = [
            {
                filename: 'src/a.ts',
                status: 'modified',
                additions: 3,
                deletions: 1,
                patch: '@@ -1,4 +1,6 @@\n old\n+new\n+new2\n rest',
            },
            {
                filename: 'src/b.ts',
                status: 'added',
                additions: 5,
                deletions: 0,
                patch: '@@ -0,0 +1,5 @@\n+line1\n+line2\n+line3\n+line4\n+line5',
            },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.source).toBe('file-patches');
        expect(result.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
        expect(result.diff).toContain('diff --git a/src/b.ts b/src/b.ts');
        expect(result.diff).toContain('@@ -1,4 +1,6 @@');
        expect(result.incompleteFiles).toEqual([]);
    });

    it('should track files with null patches as incomplete', async () => {
        const mockFiles = [
            {
                filename: 'src/small.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: '@@ -1 +1 @@\n-old\n+new',
            },
            {
                filename: 'assets/image.png',
                status: 'added',
                additions: 0,
                deletions: 0,
                patch: null,
            },
            {
                filename: 'src/generated.pb.ts',
                status: 'modified',
                additions: 5000,
                deletions: 5000,
                patch: null,
            },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.source).toBe('file-patches');
        expect(result.diff).toContain('src/small.ts');
        expect(result.incompleteFiles).toEqual(['assets/image.png', 'src/generated.pb.ts']);
    });

    it('should return summary when all patches are null', async () => {
        const mockFiles = [
            { filename: 'large1.ts', status: 'modified', additions: 10000, deletions: 10000, patch: null },
            { filename: 'large2.ts', status: 'modified', additions: 5000, deletions: 5000, patch: null },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.source).toBe('summary');
        expect(result.diff).toContain('large1.ts');
        expect(result.diff).toContain('large2.ts');
        expect(result.incompleteFiles).toEqual(['large1.ts', 'large2.ts']);
    });

    it('should propagate non-406 errors', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
        );

        await expect(
            client.getPullRequestDiffWithFallback('owner', 'repo', 1),
        ).rejects.toThrow('GitHub API error fetching diff: 401 Unauthorized');
    });

    it('should include proper diff headers for added files', async () => {
        const mockFiles = [
            {
                filename: 'src/new.ts',
                status: 'added',
                additions: 5,
                deletions: 0,
                patch: '@@ -0,0 +1,5 @@\n+line1\n+line2',
            },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.diff).toContain('new file mode 100644');
        expect(result.diff).toContain('--- /dev/null');
        expect(result.diff).toContain('+++ b/src/new.ts');
    });

    it('should include proper diff headers for removed files', async () => {
        const mockFiles = [
            {
                filename: 'src/old.ts',
                status: 'removed',
                additions: 0,
                deletions: 5,
                patch: '@@ -1,5 +0,0 @@\n-line1\n-line2',
            },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const result = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        expect(result.diff).toContain('deleted file mode 100644');
        expect(result.diff).toContain('--- a/src/old.ts');
        expect(result.diff).toContain('+++ /dev/null');
    });

    it('should produce diffs compatible with truncateDiff', async () => {
        const mockFiles = [
            {
                filename: 'src/a.ts',
                status: 'modified',
                additions: 10,
                deletions: 5,
                patch: '@@ -1,5 +1,10 @@\n-old\n+new\n rest',
            },
            {
                filename: 'src/b.ts',
                status: 'added',
                additions: 3,
                deletions: 0,
                patch: '@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3',
            },
        ];

        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('too large', { status: 406, statusText: 'Not Acceptable' }))
            .mockResolvedValueOnce(new Response(JSON.stringify(mockFiles), { status: 200 }));

        const diffResult = await client.getPullRequestDiffWithFallback('owner', 'repo', 1);
        const truncated = truncateDiff(diffResult.diff, 100_000);

        expect(truncated.totalFiles).toBe(2);
        expect(truncated.fullyIncludedFiles).toBe(2);
        expect(truncated.diff).toContain('diff --git');
        expect(truncated.diff).toContain('@@');
    });
});
