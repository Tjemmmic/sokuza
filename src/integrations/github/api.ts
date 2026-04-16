/**
 * GitHub REST API client.
 * Uses native fetch — no external HTTP library required.
 */

import { assembleDiffFromFiles } from '../../core/diff-assembler.js';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
    url: string | URL,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export interface DiffResult {
    diff: string;
    source: 'bulk' | 'file-patches' | 'summary';
    incompleteFiles: string[];
    files?: Array<Record<string, unknown>>;
}

export class GitHubApiClient {
    private token: string;
    private baseUrl: string;

    constructor(token: string, baseUrl?: string) {
        this.token = token;
        this.baseUrl = baseUrl ?? GITHUB_API_BASE;
    }

    private headers(accept?: string): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: accept ?? 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    /**
     * Fetch a pull request's metadata.
     */
    async getPullRequest(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
        const res = await fetchWithTimeout(url, { headers: this.headers() });

        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching PR: ${res.status} ${res.statusText}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    async getPullRequestDiff(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<string> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
        const res = await fetchWithTimeout(url, {
            headers: this.headers('application/vnd.github.diff'),
        });

        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching diff: ${res.status} ${res.statusText}`,
            );
        }

        return await res.text();
    }

    /**
     * List files changed in a pull request, paginating through all results.
     */
    async getPullRequestFiles(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<Array<Record<string, unknown>>> {
        const allFiles: Array<Record<string, unknown>> = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/files?page=${page}&per_page=${perPage}`;
            const res = await fetchWithTimeout(url, { headers: this.headers() });

            if (!res.ok) {
                throw new Error(
                    `GitHub API error fetching files: ${res.status} ${res.statusText}`,
                );
            }

            const pageFiles = (await res.json()) as Array<Record<string, unknown>>;
            allFiles.push(...pageFiles);

            if (pageFiles.length < perPage) break;
            page++;
        }

        return allFiles;
    }

    /**
     * Fetch the diff for a pull request with fallback handling for large PRs.
     *
     * Strategy:
     * 1. Try bulk diff via Accept: application/vnd.github.diff (fast path)
     * 2. On HTTP 406 (diff too large), assemble from per-file patches via
     *    the paginated /files endpoint
     * 3. If per-file patches are unavailable, return a summary from file stats
     */
    async getPullRequestDiffWithFallback(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<DiffResult> {
        try {
            const diff = await this.getPullRequestDiff(owner, repo, prNumber);
            return { diff, source: 'bulk', incompleteFiles: [] };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isTooLarge = msg.includes('406') || msg.toLowerCase().includes('too large');
            if (!isTooLarge) throw err;
        }

        const files = await this.getPullRequestFiles(owner, repo, prNumber);
        const fileEntries = files.map((f) => ({
            filename: f.filename as string,
            status: f.status as string,
            additions: f.additions as number,
            deletions: f.deletions as number,
            patch: f.patch as string | null | undefined,
        }));

        const assembled = assembleDiffFromFiles(fileEntries);
        return {
            diff: assembled.diff,
            source: assembled.source,
            incompleteFiles: assembled.incompleteFiles,
            files,
        };
    }

    /**
     * Post a comment on a PR or issue.
     */
    async createComment(
        owner: string,
        repo: string,
        issueNumber: number,
        body: string,
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ body }),
        });

        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error creating comment: ${res.status} ${res.statusText} — ${errorBody}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    async createReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT',
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ body, event }),
        });

        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error creating review: ${res.status} ${res.statusText} — ${errorBody}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    async createPullRequest(
        owner: string,
        repo: string,
        options: { title: string; body: string; head: string; base: string },
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(options),
        });

        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error creating PR: ${res.status} ${res.statusText} — ${errorBody}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }
}
