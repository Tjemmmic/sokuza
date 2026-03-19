import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubApiClient } from '../integrations/github/api.js';

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
