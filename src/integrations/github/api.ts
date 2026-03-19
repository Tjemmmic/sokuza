/**
 * GitHub REST API client.
 * Uses native fetch — no external HTTP library required.
 */

const GITHUB_API_BASE = 'https://api.github.com';

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
        const res = await fetch(url, { headers: this.headers() });

        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching PR: ${res.status} ${res.statusText}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    /**
     * Fetch the unified diff for a pull request.
     */
    async getPullRequestDiff(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<string> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
        const res = await fetch(url, {
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
     * List files changed in a pull request.
     */
    async getPullRequestFiles(
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<Array<Record<string, unknown>>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/files`;
        const res = await fetch(url, { headers: this.headers() });

        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching files: ${res.status} ${res.statusText}`,
            );
        }

        return (await res.json()) as Array<Record<string, unknown>>;
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
        const res = await fetch(url, {
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

    /**
     * Submit a pull request review.
     * @param event  One of: APPROVE, REQUEST_CHANGES, COMMENT
     */
    async createReview(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT',
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
        const res = await fetch(url, {
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

    /**
     * Create a pull request.
     */
    async createPullRequest(
        owner: string,
        repo: string,
        options: { title: string; body: string; head: string; base: string },
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls`;
        const res = await fetch(url, {
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
