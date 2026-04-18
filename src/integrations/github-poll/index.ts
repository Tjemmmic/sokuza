/**
 * GitHub Polling Integration
 *
 * Alternative to webhooks — polls the GitHub REST API on a timer to detect
 * new PRs, issues, pushes, comments, etc. Zero public URL required.
 *
 * Config:
 *   github-poll:
 *     token: ${GITHUB_TOKEN}
 *     repos:
 *       - owner/repo
 *     events:
 *       - pull_request.opened
 *       - pull_request.synchronize
 *       - pull_request.closed
 *       - push
 *       - issues.opened
 *       - issues.closed
 *       - issue_comment.created
 *     interval: 60  # seconds
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
    EventHandler,
    EventPayload,
    Integration,
    IntegrationConfig,
} from '../../core/types.js';
import type { Logger } from 'pino';

interface PollConfig {
    token: string;
    repos: string[];
    events?: string[];
    interval?: number;
}

interface PollState {
    /** Last-seen PR numbers per repo */
    lastPrIds: Map<string, Set<number>>;
    /** Last-seen PR head SHAs per repo (repo → pr# → sha) — for synchronize detection */
    lastPrHeadShas: Map<string, Map<number, string>>;
    /** Last-seen PR states per repo (repo → pr# → state) — for closed detection */
    lastPrStates: Map<string, Map<number, string>>;
    /** Last-seen issue numbers per repo */
    lastIssueIds: Map<string, Set<number>>;
    /** Last-seen issue states per repo (repo → issue# → state) — for closed detection */
    lastIssueStates: Map<string, Map<number, string>>;
    /** Last-seen branch SHAs per repo (repo → branch → sha) — for push detection */
    lastBranchShas: Map<string, Map<string, string>>;
    /** Last-seen comment IDs per repo */
    lastCommentIds: Map<string, Set<number>>;
    /** Last-seen PR review IDs per repo */
    lastReviewIds: Map<string, Set<number>>;
    /** Whether initial seed has completed (skip first batch) */
    seeded: boolean;
}

const GITHUB_API = 'https://api.github.com';
const DEFAULT_INTERVAL = 60;

const SUPPORTED_EVENTS = [
    'pull_request.opened',
    'pull_request.closed',
    'pull_request.synchronize',
    'push',
    'issues.opened',
    'issues.closed',
    'issue_comment.created',
    'pull_request_review.submitted',
];

export class GitHubPollIntegration implements Integration {
    readonly name = 'github-poll';
    readonly supportedEvents = SUPPORTED_EVENTS;

    private config!: PollConfig;
    private state: PollState = {
        lastPrIds: new Map(),
        lastPrHeadShas: new Map(),
        lastPrStates: new Map(),
        lastIssueIds: new Map(),
        lastIssueStates: new Map(),
        lastBranchShas: new Map(),
        lastCommentIds: new Map(),
        lastReviewIds: new Map(),
        seeded: false,
    };
    private timer: ReturnType<typeof setInterval> | null = null;
    private onEvent: EventHandler | null = null;
    private enabledEvents: Set<string> = new Set();

    async initialize(config: IntegrationConfig, _logger: Logger): Promise<void> {
        this.config = config as unknown as PollConfig;
        if (!this.config.token) {
            throw new Error('github-poll: token is required');
        }
        if (!this.config.repos?.length) {
            throw new Error('github-poll: at least one repo is required');
        }
        this.enabledEvents = new Set(this.config.events ?? SUPPORTED_EVENTS);
    }

    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void {
        this.onEvent = onEvent;
        // No HTTP routes needed — polling is timer-based
        // Start polling after a short delay to let the server finish booting
        const interval = (this.config.interval ?? DEFAULT_INTERVAL) * 1000;
        setTimeout(() => {
            this.poll(); // Initial poll to seed state
            this.timer = setInterval(() => this.poll(), interval);
        }, 2000);
    }

    parseEvent(_request: FastifyRequest): EventPayload {
        // Not used — events are emitted directly from poll()
        throw new Error('github-poll does not use parseEvent');
    }

    /** Stop the poll timer (for clean shutdown) */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // ─── Polling Logic ──────────────────────────────────────────────────

    private async poll(): Promise<void> {
        for (const repoFull of this.config.repos) {
            try {
                await this.pollRepo(repoFull);
            } catch (err) {
                // Don't crash on individual repo errors
                console.error(`github-poll: error polling ${repoFull}:`, (err as Error).message);
            }
        }
        // After first run, mark as seeded so subsequent runs emit events
        if (!this.state.seeded) {
            this.state.seeded = true;
        }
    }

    private async pollRepo(repoFull: string): Promise<void> {
        const [owner, repo] = repoFull.split('/');
        if (!owner || !repo) return;

        // Poll PRs
        if (this.wantsEvent('pull_request')) {
            await this.pollPullRequests(owner, repo);
        }

        // Poll issues
        if (this.wantsEvent('issues')) {
            await this.pollIssues(owner, repo);
        }

        // Poll pushes (via branch SHAs)
        if (this.enabledEvents.has('push')) {
            await this.pollPushes(owner, repo);
        }

        // Poll comments
        if (this.enabledEvents.has('issue_comment.created')) {
            await this.pollComments(owner, repo);
        }

        // Poll PR reviews
        if (this.enabledEvents.has('pull_request_review.submitted')) {
            await this.pollPullRequestReviews(owner, repo);
        }
    }

    private wantsEvent(prefix: string): boolean {
        for (const e of this.enabledEvents) {
            if (e.startsWith(prefix)) return true;
        }
        return false;
    }

    // ─── PR Polling ─────────────────────────────────────────────────────

    private async pollPullRequests(owner: string, repo: string): Promise<void> {
        const key = `${owner}/${repo}`;
        const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=20`;
        const prs = await this.apiGet(url) as Array<Record<string, unknown>>;

        const oldIds = this.state.lastPrIds.get(key) ?? new Set<number>();
        const oldHeadShas = this.state.lastPrHeadShas.get(key) ?? new Map<number, string>();
        const oldStates = this.state.lastPrStates.get(key) ?? new Map<number, string>();

        const newIds = new Set<number>();
        const newHeadShas = new Map<number, string>();
        const newStates = new Map<number, string>();

        for (const pr of prs) {
            const num = pr.number as number;
            const head = pr.head as Record<string, unknown> | undefined;
            const headSha = (head?.sha as string) ?? '';
            const state = pr.state as string;
            const merged = !!(pr.merged_at);

            newIds.add(num);
            newHeadShas.set(num, headSha);
            newStates.set(num, merged ? 'merged' : state);

            if (!this.state.seeded) continue; // Seed run — just collect state

            if (!oldIds.has(num)) {
                // ── New PR ───────────────────────────────────────────────
                if (this.enabledEvents.has('pull_request.opened')) {
                    await this.emit('pull_request.opened', owner, repo, {
                        action: 'opened',
                        number: num,
                        pull_request: pr,
                    });
                }
            } else {
                // ── Existing PR — check for synchronize and closed ───────
                const oldSha = oldHeadShas.get(num);
                if (
                    oldSha &&
                    headSha !== oldSha &&
                    state === 'open' &&
                    this.enabledEvents.has('pull_request.synchronize')
                ) {
                    await this.emit('pull_request.synchronize', owner, repo, {
                        action: 'synchronize',
                        number: num,
                        pull_request: pr,
                        before: oldSha,
                        after: headSha,
                    });
                }

                const oldState = oldStates.get(num);
                if (
                    oldState === 'open' &&
                    (state === 'closed' || merged) &&
                    this.enabledEvents.has('pull_request.closed')
                ) {
                    await this.emit('pull_request.closed', owner, repo, {
                        action: 'closed',
                        number: num,
                        pull_request: pr,
                    });
                }
            }
        }

        this.state.lastPrIds.set(key, newIds);
        this.state.lastPrHeadShas.set(key, newHeadShas);
        this.state.lastPrStates.set(key, newStates);
    }

    // ─── Issue Polling ──────────────────────────────────────────────────

    private async pollIssues(owner: string, repo: string): Promise<void> {
        const key = `${owner}/${repo}`;
        const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc&per_page=20&filter=all`;
        const issues = await this.apiGet(url) as Array<Record<string, unknown>>;

        const oldIds = this.state.lastIssueIds.get(key) ?? new Set<number>();
        const oldStates = this.state.lastIssueStates.get(key) ?? new Map<number, string>();

        const newIds = new Set<number>();
        const newStates = new Map<number, string>();

        for (const issue of issues) {
            // Skip pull requests (GitHub includes them in /issues)
            if (issue.pull_request) continue;

            const num = issue.number as number;
            const state = issue.state as string;

            newIds.add(num);
            newStates.set(num, state);

            if (!this.state.seeded) continue;

            if (!oldIds.has(num)) {
                // ── New issue ────────────────────────────────────────────
                if (this.enabledEvents.has('issues.opened')) {
                    await this.emit('issues.opened', owner, repo, {
                        action: 'opened',
                        issue,
                    });
                }
            } else {
                // ── Existing issue — check for closed transition ─────────
                const oldState = oldStates.get(num);
                if (
                    oldState === 'open' &&
                    state === 'closed' &&
                    this.enabledEvents.has('issues.closed')
                ) {
                    await this.emit('issues.closed', owner, repo, {
                        action: 'closed',
                        issue,
                    });
                }
            }
        }

        this.state.lastIssueIds.set(key, newIds);
        this.state.lastIssueStates.set(key, newStates);
    }

    // ─── Push Polling (via branches) ────────────────────────────────────

    private async pollPushes(owner: string, repo: string): Promise<void> {
        const key = `${owner}/${repo}`;
        const url = `${GITHUB_API}/repos/${owner}/${repo}/branches?per_page=50`;
        const branches = await this.apiGet(url) as Array<Record<string, unknown>>;

        const oldShas = this.state.lastBranchShas.get(key) ?? new Map<string, string>();
        const newShas = new Map<string, string>();

        for (const branch of branches) {
            const name = branch.name as string;
            const commit = branch.commit as Record<string, unknown>;
            const sha = commit.sha as string;

            newShas.set(name, sha);

            if (!this.state.seeded) continue;

            const oldSha = oldShas.get(name);
            if (oldSha && sha !== oldSha) {
                await this.emit('push', owner, repo, {
                    ref: `refs/heads/${name}`,
                    after: sha,
                    before: oldSha,
                    head_commit: commit,
                });
            }
        }

        this.state.lastBranchShas.set(key, newShas);
    }

    // ─── Comment Polling ────────────────────────────────────────────────

    private async pollComments(owner: string, repo: string): Promise<void> {
        const key = `${owner}/${repo}`;
        const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/comments?sort=updated&direction=desc&per_page=20`;
        const comments = await this.apiGet(url) as Array<Record<string, unknown>>;

        const oldIds = this.state.lastCommentIds.get(key) ?? new Set<number>();
        const newIds = new Set<number>();

        for (const comment of comments) {
            const id = comment.id as number;
            newIds.add(id);

            if (!this.state.seeded) continue;

            if (!oldIds.has(id)) {
                // Extract the issue number from the issue_url
                // Format: https://api.github.com/repos/owner/repo/issues/42
                const issueUrl = comment.issue_url as string | undefined;
                const issueNumber = issueUrl
                    ? parseInt(issueUrl.split('/').pop() ?? '0', 10)
                    : undefined;

                await this.emit('issue_comment.created', owner, repo, {
                    action: 'created',
                    comment,
                    issue: { number: issueNumber },
                });
            }
        }

        this.state.lastCommentIds.set(key, newIds);
    }

    // ─── PR Review Polling ──────────────────────────────────────────────

    private async pollPullRequestReviews(owner: string, repo: string): Promise<void> {
        const key = `${owner}/${repo}`;

        // Get open PRs to check reviews on
        const prsUrl = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=10`;
        const prs = await this.apiGet(prsUrl) as Array<Record<string, unknown>>;

        const oldIds = this.state.lastReviewIds.get(key) ?? new Set<number>();
        const newIds = new Set<number>(oldIds);

        for (const pr of prs) {
            const prNum = pr.number as number;
            const reviewsUrl = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNum}/reviews`;

            let reviews: Array<Record<string, unknown>>;
            try {
                reviews = await this.apiGet(reviewsUrl) as Array<Record<string, unknown>>;
            } catch {
                continue; // Skip PRs we can't fetch reviews for
            }

            for (const review of reviews) {
                const id = review.id as number;
                newIds.add(id);

                if (!this.state.seeded) continue;
                if (oldIds.has(id)) continue;

                // Emit event for new reviews
                await this.emit('pull_request_review.submitted', owner, repo, {
                    action: 'submitted',
                    review,
                    pull_request: pr,
                });
            }
        }

        this.state.lastReviewIds.set(key, newIds);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    private async apiGet(url: string): Promise<unknown> {
        return this.apiGetAllPages(url);
    }

    private async apiGetAllPages(url: string): Promise<unknown> {
        const all: unknown[] = [];
        let nextUrl: string | null = url;

        while (nextUrl) {
            const res = await fetch(nextUrl, {
                headers: {
                    Authorization: `Bearer ${this.config.token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });

            if (res.status === 304) return all;
            if (!res.ok) {
                throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
            }

            const data: unknown = await res.json();
            if (!Array.isArray(data)) return data;
            all.push(...data);

            const link = res.headers?.get?.('link');
            if (!link) break;

            const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
            nextUrl = nextMatch ? nextMatch[1] : null;
        }

        return all;
    }

    private async emit(
        event: string,
        owner: string,
        repo: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.onEvent) return;

        const eventPayload: EventPayload = {
            source: 'github-poll',
            event,
            action: payload.action as string | undefined,
            timestamp: new Date().toISOString(),
            payload,
            metadata: {
                repo: `${owner}/${repo}`,
                pollSource: true,
            },
        };

        await this.onEvent(eventPayload);
    }
}
