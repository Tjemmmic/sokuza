/**
 * GitHub REST API client.
 * Uses native fetch — no external HTTP library required.
 */

import { assembleDiffFromFiles } from '../../core/diff-assembler.js';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const ERROR_BODY_MAX_CHARS = 500;

/** Truncate API response bodies before they land in error messages — they
 *  can carry sensitive context (PR titles from private repos) and propagate
 *  to downstream loggers. */
function truncateErrorBody(body: string): string {
    if (body.length <= ERROR_BODY_MAX_CHARS) return body;
    return body.slice(0, ERROR_BODY_MAX_CHARS) + `… [truncated, ${body.length} chars total]`;
}

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
        // Inline the bulk-diff fetch so we can branch on the actual HTTP
        // status code instead of substring-matching '406' in an error
        // message (which would also match '/pulls/4060', SHA fragments, etc).
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
        const res = await fetchWithTimeout(url, {
            headers: this.headers('application/vnd.github.diff'),
        });
        if (res.ok) {
            const diff = await res.text();
            return { diff, source: 'bulk', incompleteFiles: [] };
        }
        if (res.status !== 406) {
            throw new Error(
                `GitHub API error fetching diff: ${res.status} ${res.statusText}`,
            );
        }

        // 406 = diff too large — fall back to per-file assembly.
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
                `GitHub API error creating comment: ${res.status} ${res.statusText} — ${truncateErrorBody(errorBody)}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    async createReview(
        owner: string,
        repo: string,
        prNumber: number,
        opts: {
            body: string;
            event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
            /** Inline review comments anchored to file+line. The reviewed
             *  PR's diff is what `line` references. Lines that aren't in
             *  the diff cause GitHub to reject the review entirely, so
             *  callers should drop unanchorable issues into `body`. */
            comments?: Array<{
                path: string;
                line: number;
                side?: 'RIGHT' | 'LEFT';
                start_line?: number;
                start_side?: 'RIGHT' | 'LEFT';
                body: string;
            }>;
            commit_id?: string;
        },
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
        const payload: Record<string, unknown> = {
            body: opts.body,
            event: opts.event ?? 'COMMENT',
        };
        if (opts.commit_id) payload.commit_id = opts.commit_id;
        if (opts.comments && opts.comments.length > 0) payload.comments = opts.comments;

        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error creating review: ${res.status} ${res.statusText} — ${truncateErrorBody(errorBody)}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    async addLabels(
        owner: string,
        repo: string,
        issueNumber: number,
        labels: string[],
    ): Promise<void> {
        if (labels.length === 0) return;
        const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ labels }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`GitHub API error adding labels: ${res.status} — ${truncateErrorBody(body)}`);
        }
    }

    async removeLabel(
        owner: string,
        repo: string,
        issueNumber: number,
        label: string,
    ): Promise<void> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
        const res = await fetchWithTimeout(url, {
            method: 'DELETE',
            headers: this.headers(),
        });
        // 404 means "label wasn't on the issue" — same desired end state.
        if (!res.ok && res.status !== 404) {
            const body = await res.text();
            throw new Error(`GitHub API error removing label: ${res.status} — ${truncateErrorBody(body)}`);
        }
    }

    async listLabels(
        owner: string,
        repo: string,
        issueNumber: number,
    ): Promise<string[]> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
        const res = await fetchWithTimeout(url, { headers: this.headers() });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`GitHub API error listing labels: ${res.status} — ${truncateErrorBody(body)}`);
        }
        const json = (await res.json()) as Array<{ name: string }>;
        return json.map((l) => l.name);
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
                `GitHub API error creating PR: ${res.status} ${res.statusText} — ${truncateErrorBody(errorBody)}`,
            );
        }

        return (await res.json()) as Record<string, unknown>;
    }

    /** PATCH a pull request — title, body, state, base. Any subset works,
     *  but at least one field must be supplied (sending {} would burn an
     *  authenticated round-trip for a no-op). */
    async updatePullRequest(
        owner: string,
        repo: string,
        prNumber: number,
        options: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
        const payload: Record<string, unknown> = {};
        if (options.title !== undefined) payload.title = options.title;
        if (options.body !== undefined) payload.body = options.body;
        if (options.state !== undefined) payload.state = options.state;
        if (options.base !== undefined) payload.base = options.base;
        if (Object.keys(payload).length === 0) {
            throw new Error('updatePullRequest: at least one of title/body/state/base must be supplied');
        }
        const res = await fetchWithTimeout(url, {
            method: 'PATCH',
            headers: this.headers(),
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error updating PR: ${res.status} ${res.statusText} — ${truncateErrorBody(errorBody)}`,
            );
        }
        return (await res.json()) as Record<string, unknown>;
    }

    /** Merge a pull request. Method defaults to "merge"; use "squash"/"rebase"
     *  for those merge styles. Throws on 405 (not mergeable) — caller decides
     *  whether to retry or surface the failure. */
    async mergePullRequest(
        owner: string,
        repo: string,
        prNumber: number,
        options: {
            method?: 'merge' | 'squash' | 'rebase';
            commit_title?: string;
            commit_message?: string;
            sha?: string;
        } = {},
    ): Promise<{ merged: boolean; sha: string; message: string }> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
        const payload: Record<string, unknown> = { merge_method: options.method ?? 'merge' };
        if (options.commit_title) payload.commit_title = options.commit_title;
        if (options.commit_message) payload.commit_message = options.commit_message;
        if (options.sha) payload.sha = options.sha;
        const res = await fetchWithTimeout(url, {
            method: 'PUT',
            headers: this.headers(),
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(
                `GitHub API error merging PR: ${res.status} ${res.statusText} — ${truncateErrorBody(errorBody)}`,
            );
        }
        const json = (await res.json()) as { merged?: boolean; sha?: string; message?: string };
        return {
            merged: json.merged === true,
            sha: typeof json.sha === 'string' ? json.sha : '',
            message: typeof json.message === 'string' ? json.message : '',
        };
    }

    async getIssue(
        owner: string,
        repo: string,
        issueNumber: number,
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`;
        const res = await fetchWithTimeout(url, { headers: this.headers() });
        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching issue: ${res.status} ${res.statusText}`,
            );
        }
        return (await res.json()) as Record<string, unknown>;
    }

    /** Fetch check runs for a commit SHA, paginating up to maxPages.
     *  The default cap (5 pages × 100 per page = 500 runs) is comfortably
     *  above any realistic CI count and bounds rate-limit exposure when the
     *  caller polls in a loop. */
    async getCheckRuns(
        owner: string,
        repo: string,
        sha: string,
        maxPages = 5,
    ): Promise<Array<Record<string, unknown>>> {
        const all: Array<Record<string, unknown>> = [];
        const perPage = 100;
        for (let page = 1; page <= maxPages; page++) {
            const url = `${this.baseUrl}/repos/${owner}/${repo}/commits/${sha}/check-runs?page=${page}&per_page=${perPage}`;
            const res = await fetchWithTimeout(url, { headers: this.headers() });
            if (!res.ok) {
                throw new Error(
                    `GitHub API error listing check-runs: ${res.status} ${res.statusText}`,
                );
            }
            const json = (await res.json()) as { check_runs?: Array<Record<string, unknown>>; total_count?: number };
            const runs = json.check_runs ?? [];
            all.push(...runs);
            if (runs.length < perPage) break;
        }
        return all;
    }

    /** Combined commit status (the legacy "statuses" API — separate from
     *  check-runs and used by some CIs like Travis/CircleCI). */
    async getCombinedStatus(
        owner: string,
        repo: string,
        sha: string,
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}/repos/${owner}/${repo}/commits/${sha}/status`;
        const res = await fetchWithTimeout(url, { headers: this.headers() });
        if (!res.ok) {
            throw new Error(
                `GitHub API error fetching combined status: ${res.status} ${res.statusText}`,
            );
        }
        return (await res.json()) as Record<string, unknown>;
    }
}
