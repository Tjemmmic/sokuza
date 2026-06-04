/**
 * GH CLI Integration for Sokuza.
 *
 * Zero-config GitHub integration powered by the `gh` CLI tool.
 * Automatically detects gh auth status. All actions use `gh` commands
 * instead of raw API calls, so no GITHUB_TOKEN config is needed.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
    ActionHandler,
    EventHandler,
    EventPayload,
    Integration,
    IntegrationConfig,
} from '../../core/types.js';
import type { Logger } from 'pino';
import { getGhAuthStatus, ghJson } from './exec.js';

// ─── GH CLI powered actions ────────────────────────────────────────────────

import { ghCloneRepoAction } from './actions/clone-repo.js';
import { ghFetchDiffAction } from './actions/fetch-diff.js';
import { ghCommentAction } from './actions/comment.js';
import { ghFetchReviewsAction } from './actions/fetch-reviews.js';
import { ghCreatePrAction } from './actions/create-pr.js';
import { ghReviewAction } from './actions/review.js';

/** PR shape returned by gh search/pr commands */
export interface GhPullRequest {
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    updatedAt: string;
    author?: { login: string };
    labels?: Array<{ name: string }>;
    headRefName?: string;
    baseRefName?: string;
    headRefOid?: string; // HEAD commit SHA — used to detect new commits
    repository?: { name: string; nameWithOwner: string };
}

/** Issue shape returned by gh search/issue commands */
export interface GhIssue {
    number: number;
    title: string;
    url: string;
    state: string;
    updatedAt: string;
    createdAt?: string;
    body?: string;
    author?: { login: string };
    assignees?: Array<{ login: string }>;
    labels?: Array<{ name: string; color?: string }>;
    repository?: { name: string; nameWithOwner: string };
    comments?: Array<{ body: string; author: { login: string }; createdAt: string }>;
}

const SUPPORTED_EVENTS = [
    'pull_request.opened',
    'pull_request.closed',
    'pull_request.synchronize',
    'pull_request_review.submitted',
    'issue_comment.created',
];

const DEFAULT_INTERVAL = 60;

/**
 * Build the `gh search prs` selector flags for the poller from
 * `integrations.gh-cli.prs`. Default (unset) = the authenticated user's own
 * PRs (`--author @me`) — fully backward-compatible.
 *
 * Widen it to watch other people's / an org's PRs:
 *   integrations:
 *     gh-cli:
 *       prs:
 *         owners: [my-org]        # PRs in this org/user    → --owner
 *         authors: [alice]        # PRs by this author      → --author
 *         repos: [my-org/api]     # this repo               → --repo
 *         involves: ["@me"]       # PRs you're involved in  → --involves
 *         search: 'draft:false'   # extra raw qualifiers (positional)
 * Then a workflow's `exclude.author: <you>` carves your own PRs back out.
 * Each gh result still flows through matchesTrigger per workflow, so one
 * poll fans out to every matching workflow (no extra `gh` calls).
 *
 * Multi-value note: `gh search prs` does NOT OR a repeated selector flag —
 * the LAST value wins (verified: `--author a --author b` returns only b's).
 * So prefer one value per selector for the common case (a single org/user is
 * all most setups need), and use the raw `search` field for genuine OR
 * queries (e.g. `search: 'org:a org:b'`, which GitHub's search engine ORs).
 */
export function buildPrSearchArgs(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object') return ['--author', '@me'];
    const cfg = raw as Record<string, unknown>;
    const args: string[] = [];
    const pushFlag = (key: string, flag: string): void => {
        const val = cfg[key];
        const list = Array.isArray(val) ? val : typeof val === 'string' ? [val] : [];
        for (const v of list) {
            if (typeof v === 'string' && v.trim()) args.push(flag, v.trim());
        }
    };
    pushFlag('authors', '--author');
    pushFlag('owners', '--owner');
    pushFlag('repos', '--repo');
    pushFlag('involves', '--involves');
    // Raw extra qualifiers ride as the positional query, before the flags.
    const search = typeof cfg.search === 'string' ? cfg.search.trim() : '';
    if (search) args.unshift(search);
    // An empty `prs: {}` shouldn't become a fetch-the-whole-world query.
    if (args.length === 0) return ['--author', '@me'];
    return args;
}

export class GhCliIntegration implements Integration {
    readonly name = 'gh-cli';
    readonly supportedEvents = [...SUPPORTED_EVENTS];
    readonly actions: Record<string, ActionHandler> = {
        'gh-cli-clone-repo': ghCloneRepoAction,
        'gh-cli-fetch-diff': ghFetchDiffAction,
        'gh-cli-comment': ghCommentAction,
        'gh-cli-fetch-reviews': ghFetchReviewsAction,
        'gh-cli-create-pr': ghCreatePrAction,
        'gh-cli-review': ghReviewAction,
    };

    private username = '';
    private pollInterval = DEFAULT_INTERVAL;
    // `gh search prs` selector flags for the poll. Defaults to the
    // authenticated user's own PRs; widen via `integrations.gh-cli.prs`
    // (e.g. owners: [my-org]) to review OTHER people's / org PRs.
    private prSearchArgs: string[] = ['--author', '@me'];
    private timer: ReturnType<typeof setInterval> | null = null;
    private onEvent: EventHandler | null = null;

    // Poll state
    // Track both updatedAt (cheap change signal) and headSha (commit tracking)
    private lastPrUpdatedAt = new Map<string, string>(); // "owner/repo#num" → updatedAt
    private lastPrHeadSha = new Map<string, string>(); // "owner/repo#num" → HEAD commit SHA
    private lastReviewIds = new Map<string, Set<string>>(); // "owner/repo#num" → review IDs
    private lastCommentIds = new Map<string, Set<string>>(); // "owner/repo#num" → comment IDs
    private seeded = false;

    async initialize(config: IntegrationConfig, _logger: Logger): Promise<void> {
        const status = await getGhAuthStatus();
        if (!status.available) {
            throw new Error(
                'gh-cli integration requires the GitHub CLI (`gh`) to be installed and authenticated.\n' +
                'Install: https://cli.github.com/\n' +
                'Auth: gh auth login',
            );
        }
        this.username = status.username ?? '';
        this.pollInterval = (config.interval as number) ?? DEFAULT_INTERVAL;
        this.prSearchArgs = buildPrSearchArgs(config.prs);
    }

    registerRoutes(_server: FastifyInstance, onEvent: EventHandler): void {
        this.onEvent = onEvent;

        // Start polling after a short delay (like github-poll)
        const interval = this.pollInterval * 1000;
        setTimeout(() => {
            this.poll();
            this.timer = setInterval(() => this.poll(), interval);
        }, 2000);
    }

    parseEvent(_request: FastifyRequest): EventPayload {
        // gh-cli doesn't receive webhooks — this is unused
        throw new Error('gh-cli integration does not handle incoming webhook requests');
    }

    /** Stop polling timer */
    stopPolling(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // ─── Public API (used by dashboard endpoints) ───────────────────────

    /** List all open PRs for the authenticated user across all repos.
     *  Used by the dashboard's "my PRs" view — always scoped to @me. */
    static async listMyPrs(): Promise<GhPullRequest[]> {
        return GhCliIntegration.searchPrs(['--author', '@me']);
    }

    /** Run `gh search prs` with the given selector flags (e.g. `--author @me`,
     *  `--owner my-org`). The poller passes its configured `prSearchArgs`;
     *  per-workflow `author`/`exclude.author` filters then split the results. */
    static async searchPrs(selectorArgs: string[]): Promise<GhPullRequest[]> {
        return ghJson<GhPullRequest[]>([
            'search', 'prs',
            ...selectorArgs,
            '--state', 'open',
            // `author` is required: when the search is widened past @me (org
            // watching), the emitted payload's pull_request.user.login comes
            // from here, and that's what trigger `exclude.author` matches on.
            // Without it the author is only known via the per-PR enrichment
            // call and falls back to the poller's own username.
            '--json', 'number,title,url,state,isDraft,updatedAt,labels,repository,author',
            '--limit', '50',
        ]);
    }

    /** Get detailed PR info */
    static async getPrDetails(repo: string, number: number): Promise<Record<string, unknown>> {
        return ghJson([
            'pr', 'view', String(number),
            '-R', repo,
            '--json', 'number,title,url,state,isDraft,updatedAt,labels,author,headRefName,baseRefName,body,additions,deletions,changedFiles,files,latestReviews',
        ]);
    }

    // ─── Issue API (used by dashboard) ──────────────────────────────────

    /** List all open issues assigned to the authenticated user across all repos */
    static async listMyIssues(): Promise<GhIssue[]> {
        return ghJson<GhIssue[]>([
            'search', 'issues',
            '--assignee', '@me',
            '--state', 'open',
            '--json', 'number,title,url,state,updatedAt,labels,repository,assignees',
            '--limit', '50',
        ]);
    }

    /** List open issues for a specific repo */
    static async listRepoIssues(repo: string, state = 'open'): Promise<GhIssue[]> {
        return ghJson<GhIssue[]>([
            'issue', 'list',
            '-R', repo,
            '--state', state,
            '--json', 'number,title,url,state,updatedAt,labels,assignees,author',
            '--limit', '30',
        ]);
    }

    /** Get detailed issue info including body and comments */
    static async getIssueDetails(repo: string, number: number): Promise<GhIssue> {
        return ghJson<GhIssue>([
            'issue', 'view', String(number),
            '-R', repo,
            '--json', 'number,title,url,state,updatedAt,labels,assignees,author,body,comments',
        ]);
    }

    /** Get authenticated username */
    getUsername(): string {
        return this.username;
    }

    // ─── Polling ────────────────────────────────────────────────────────

    private async poll(): Promise<void> {
        if (!this.onEvent) return;

        try {
            const prs = await GhCliIntegration.searchPrs(this.prSearchArgs);

            for (const pr of prs) {
                const repo = pr.repository?.nameWithOwner;
                if (!repo) continue;

                const key = `${repo}#${pr.number}`;
                const lastUpdated = this.lastPrUpdatedAt.get(key);

                if (!this.seeded) {
                    // First run: seed all state without emitting events
                    const enriched = await this.enrichPr(repo, pr);
                    this.lastPrUpdatedAt.set(key, pr.updatedAt);
                    this.lastPrHeadSha.set(key, enriched.headRefOid ?? '');
                    await this.seedActivityIds(repo, pr);
                    continue;
                }

                if (!lastUpdated) {
                    // New PR appeared since last poll
                    const enriched = await this.enrichPr(repo, pr);
                    this.lastPrUpdatedAt.set(key, pr.updatedAt);
                    this.lastPrHeadSha.set(key, enriched.headRefOid ?? '');
                    await this.emitPrEvent('pull_request.opened', repo, enriched);
                } else if (lastUpdated !== pr.updatedAt) {
                    // Something changed on this PR — figure out WHAT changed
                    this.lastPrUpdatedAt.set(key, pr.updatedAt);
                    const enriched = await this.enrichPr(repo, pr);

                    // Check if HEAD SHA changed → new commits pushed
                    const oldSha = this.lastPrHeadSha.get(key) ?? '';
                    const newSha = enriched.headRefOid ?? '';
                    if (newSha && newSha !== oldSha) {
                        this.lastPrHeadSha.set(key, newSha);
                        await this.emitPrEvent('pull_request.synchronize', repo, enriched);
                    }

                    // Always check for new reviews and comments
                    await this.checkNewActivity(repo, enriched);
                }
            }

            // Detect closed PRs
            const currentKeys = new Set(prs.map((p) => `${p.repository?.nameWithOwner}#${p.number}`));
            for (const [key] of this.lastPrUpdatedAt) {
                if (!currentKeys.has(key)) {
                    const [repo, numStr] = key.split('#');
                    if (this.seeded) {
                        await this.emitPrEvent('pull_request.closed', repo, {
                            number: Number(numStr), title: '', url: '',
                            state: 'closed', isDraft: false,
                            updatedAt: new Date().toISOString(),
                        });
                    }
                    this.lastPrUpdatedAt.delete(key);
                    this.lastPrHeadSha.delete(key);
                    this.lastCommentIds.delete(key);
                    this.lastReviewIds.delete(key);
                }
            }

            if (!this.seeded) {
                this.seeded = true;
            }
        } catch {
            // Errors logged by caller in github-poll pattern
        }
    }

    /** Enrich a PR from gh search (missing headRefName/headRefOid) with full details from gh pr view */
    private async enrichPr(repo: string, pr: GhPullRequest): Promise<GhPullRequest> {
        if (pr.headRefName && pr.headRefOid) return pr; // Already has all info
        try {
            const details = await ghJson<{ headRefName: string; baseRefName: string; headRefOid: string; author: { login: string } }>([
                'pr', 'view', String(pr.number),
                '-R', repo,
                '--json', 'headRefName,baseRefName,headRefOid,author',
            ]);
            return {
                ...pr,
                headRefName: details.headRefName,
                baseRefName: details.baseRefName,
                headRefOid: details.headRefOid,
                author: details.author ? { login: details.author.login } : pr.author,
            };
        } catch {
            return pr; // Graceful fallback
        }
    }

    /** Fetch comments and reviews for a PR in a single gh call */
    private static async fetchPrActivity(repo: string, prNumber: number): Promise<{
        comments: Array<{ id: string; body: string; author: { login: string }; createdAt: string; url: string }>;
        reviews: Array<{ id: string; state: string; body: string; author: { login: string }; submittedAt: string }>;
    }> {
        const data = await ghJson<{
            comments: Array<{ id: string; body: string; author: { login: string }; createdAt: string; url: string }>;
            reviews: Array<{ id: string; state: string; body: string; author: { login: string }; submittedAt: string }>;
        }>([
            'pr', 'view', String(prNumber), '-R', repo,
            '--json', 'comments,reviews',
        ]);
        return { comments: data.comments ?? [], reviews: data.reviews ?? [] };
    }

    /** Seed comment and review IDs on startup so we don't fire events for existing ones */
    private async seedActivityIds(repo: string, pr: GhPullRequest): Promise<void> {
        const key = `${repo}#${pr.number}`;
        try {
            const { comments, reviews } = await GhCliIntegration.fetchPrActivity(repo, pr.number);
            this.lastCommentIds.set(key, new Set(comments.map(c => c.id)));
            this.lastReviewIds.set(key, new Set(reviews.map(r => r.id)));
        } catch {
            this.lastCommentIds.set(key, new Set());
            this.lastReviewIds.set(key, new Set());
        }
    }

    /** Check for new comments and reviews — emits events for ALL new entries, no filtering */
    private async checkNewActivity(repo: string, pr: GhPullRequest): Promise<void> {
        if (!this.onEvent) return;
        const key = `${repo}#${pr.number}`;

        try {
            const { comments, reviews } = await GhCliIntegration.fetchPrActivity(repo, pr.number);

            // ── Comments ────────────────────────────────────────────
            const oldCommentIds = this.lastCommentIds.get(key) ?? new Set<string>();
            const newCommentIds = new Set<string>(oldCommentIds);

            for (const comment of comments) {
                newCommentIds.add(comment.id);
                if (oldCommentIds.has(comment.id)) continue;
                // Emit for ALL new comments — the workflow decides what to do
                await this.emitCommentEvent(repo, pr, comment);
            }
            this.lastCommentIds.set(key, newCommentIds);

            // ── Reviews ─────────────────────────────────────────────
            const oldReviewIds = this.lastReviewIds.get(key) ?? new Set<string>();
            const newReviewIds = new Set<string>(oldReviewIds);

            for (const review of reviews) {
                newReviewIds.add(review.id);
                if (oldReviewIds.has(review.id)) continue;
                // Emit for ALL new reviews — the workflow decides what to do
                await this.emitReviewEvent(repo, pr, review);
            }
            this.lastReviewIds.set(key, newReviewIds);
        } catch {
            // Silently continue — next poll will retry
        }
    }

    private async emitPrEvent(event: string, repo: string, pr: GhPullRequest): Promise<void> {
        if (!this.onEvent) return;
        const [owner, repoName] = repo.split('/');

        await this.onEvent({
            source: 'gh-cli',
            event,
            action: event.split('.')[1],
            timestamp: new Date().toISOString(),
            payload: {
                action: event.split('.')[1],
                pull_request: {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    draft: pr.isDraft,
                    user: { login: pr.author?.login ?? this.username },
                    head: { ref: pr.headRefName ?? '' },
                    base: { ref: pr.baseRefName ?? '' },
                    labels: (pr.labels ?? []).map((l) => ({ name: l.name })),
                    html_url: pr.url,
                },
            },
            metadata: { repo, owner, repoName, prNumber: pr.number },
        });
    }

    private async emitReviewEvent(
        repo: string,
        pr: GhPullRequest,
        review: { id: string; state: string; body: string; author: { login: string }; submittedAt: string },
    ): Promise<void> {
        if (!this.onEvent) return;
        const [owner, repoName] = repo.split('/');

        await this.onEvent({
            source: 'gh-cli',
            event: 'pull_request_review.submitted',
            action: 'submitted',
            timestamp: new Date().toISOString(),
            payload: {
                action: 'submitted',
                review: {
                    id: review.id,
                    state: review.state,
                    body: review.body,
                    user: { login: review.author.login },
                    submitted_at: review.submittedAt,
                },
                pull_request: {
                    number: pr.number, title: pr.title, state: pr.state,
                    user: { login: pr.author?.login ?? this.username },
                    head: { ref: pr.headRefName ?? '' },
                    base: { ref: pr.baseRefName ?? '' },
                },
            },
            metadata: { repo, owner, repoName, prNumber: pr.number },
        });
    }

    private async emitCommentEvent(
        repo: string,
        pr: GhPullRequest,
        comment: { id: string; body: string; author: { login: string }; createdAt: string; url: string },
    ): Promise<void> {
        if (!this.onEvent) return;
        const [owner, repoName] = repo.split('/');

        await this.onEvent({
            source: 'gh-cli',
            event: 'issue_comment.created',
            action: 'created',
            timestamp: new Date().toISOString(),
            payload: {
                action: 'created',
                comment: {
                    id: comment.id,
                    body: comment.body,
                    user: { login: comment.author.login },
                    created_at: comment.createdAt,
                    html_url: comment.url,
                },
                // Include pull_request so shorthand filters (author, repo, branch) work
                pull_request: {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    user: { login: pr.author?.login ?? this.username },
                    head: { ref: pr.headRefName ?? '' },
                    base: { ref: pr.baseRefName ?? '' },
                },
                issue: {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    pull_request: { url: pr.url },
                    user: { login: pr.author?.login ?? this.username },
                },
            },
            metadata: { repo, owner, repoName, prNumber: pr.number },
        });
    }
}
