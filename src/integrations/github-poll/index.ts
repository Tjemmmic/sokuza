/**
 * GitHub Polling Integration
 *
 * Alternative to webhooks — polls the GitHub REST API on a timer to detect
 * new PRs, issues, pushes, comments, etc. Zero public URL required.
 *
 * Config:
 *   github-poll:
 *     token: ${GITHUB_TOKEN}
 *     repos:             # explicit repos to watch (at least one of
 *       - owner/repo     # `repos` or `orgs` is required)
 *     orgs:              # OPTIONAL: orgs whose repos to auto-enumerate
 *       - my-org         # — refreshed every `org_refresh` seconds so
 *                        # newly-created org repos start being watched.
 *     events:
 *       - pull_request.opened
 *       - pull_request.synchronize
 *       - pull_request.closed
 *       - push
 *       - issues.opened
 *       - issues.closed
 *       - issue_comment.created
 *     interval: 60         # seconds between polls
 *     org_refresh: 3600    # seconds between org-repo re-enumerations
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
    /** Explicit repos to watch (always included). Either this or `orgs`
     *  — or both — must be supplied. Order: explicit repos are always
     *  watched; org-enumerated repos are added on top. */
    repos?: string[];
    /** Orgs whose accessible repos to auto-enumerate via
     *  `GET /orgs/{org}/repos`. Refreshed every `org_refresh` seconds. */
    orgs?: string[];
    events?: string[];
    interval?: number;
    /** Seconds between re-enumerations of `orgs`. Defaults to 3600 (1h).
     *  Orgs don't churn often; the refresh primarily exists so a newly-
     *  created repo eventually shows up in the watch set without a
     *  restart. */
    org_refresh?: number;
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
    /** Per-repo seed flag. A repo enters this set after its first
     *  `pollRepo()` completes, marking that we've recorded its current
     *  PR/issue/branch/comment/review snapshot. Subsequent polls only
     *  emit events for changes against that snapshot.
     *
     *  Per-repo (not global) because dynamic org enumeration can add
     *  repos to the watch set AFTER the first poll cycle has flipped a
     *  global flag. A global flag would let the freshly-discovered
     *  repo's first poll fire `pull_request.opened` / `issues.opened` /
     *  `push` events for every existing PR/issue/branch on it — exactly
     *  the flood the seed-run guard exists to prevent. */
    seededRepos: Set<string>;
}

const GITHUB_API = 'https://api.github.com';
const DEFAULT_INTERVAL = 60;
/** Default cadence for re-enumerating orgs. 1 hour is well below the
 *  rate-limit budget for `/orgs/{org}/repos` (5000/h authenticated) for
 *  any realistic number of orgs, and is short enough that newly-created
 *  org repos start being watched within an hour without a restart. */
const DEFAULT_ORG_REFRESH = 3600;

/** Trim whitespace, drop empty entries, dedupe. Shared by `repos` and
 *  `orgs` so the two config inputs go through the same cleaning. */
function clean(xs: string[] | undefined): string[] {
    return Array.from(new Set(
        (xs ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
    ));
}

/** Best-effort string representation of an unknown thrown value. `(err as
 *  Error).message` would coerce non-Error throws (strings, plain objects,
 *  `null`) to `undefined` and pino would then log `{ err: undefined }`,
 *  losing the actual cause. We expect the only thing we ever throw to be
 *  an Error, but the type system can't enforce that across third-party
 *  code we call, and the per-org "isolation" guarantee leans on the log
 *  being legible. */
function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

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
    private logger!: Logger;
    private state: PollState = {
        lastPrIds: new Map(),
        lastPrHeadShas: new Map(),
        lastPrStates: new Map(),
        lastIssueIds: new Map(),
        lastIssueStates: new Map(),
        lastBranchShas: new Map(),
        lastCommentIds: new Map(),
        lastReviewIds: new Map(),
        seededRepos: new Set(),
    };
    private timer: ReturnType<typeof setInterval> | null = null;
    private orgRefreshTimer: ReturnType<typeof setInterval> | null = null;
    /** Startup-delay timer scheduled in registerRoutes. Stored so `stop()`
     *  can cancel it during the first 2s of an integration's life — without
     *  this handle a fast graceful shutdown leaks the deferred poll/refresh
     *  intervals it would otherwise arm on a supposedly-stopped instance. */
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    /** Sticky shutdown flag. Set in `stop()` so any deferred callback that
     *  was already in flight when stop was called bails out instead of
     *  arming a fresh interval on a stopped integration. */
    private stopped = false;
    /** Re-entrance guard for `refreshOrgRepos`. Without this, a slow
     *  enumeration cycle (large org, retries) running longer than
     *  `org_refresh` would race a second concurrent refresh — both writing
     *  to `this.orgRepos` for the same key with last-writer-wins ordering
     *  that isn't tied to data freshness. */
    private refreshing = false;
    private onEvent: EventHandler | null = null;
    private enabledEvents: Set<string> = new Set();
    /** Repos supplied verbatim in `config.repos`. Never mutated after init —
     *  these are always watched regardless of org-refresh outcomes. */
    private explicitRepos = new Set<string>();
    /** Cleaned org list (trimmed, non-empty, deduped) derived from
     *  `config.orgs` at init time. Empty/whitespace entries would otherwise
     *  hit `/orgs//repos` (404), and duplicate entries would burn API quota
     *  re-enumerating the same org on every refresh. */
    private orgs: string[] = [];
    /** Per-org enumerated repo sets, keyed by org name. Each entry is
     *  REPLACED on every refresh so repos that were removed or made
     *  private silently drop out of the watch set instead of accumulating. */
    private orgRepos = new Map<string, Set<string>>();

    async initialize(config: IntegrationConfig, logger: Logger): Promise<void> {
        this.config = config as unknown as PollConfig;
        this.logger = logger;
        if (!this.config.token) {
            throw new Error('github-poll: token is required');
        }
        // Trim+filter+dedupe both inputs before validation. An empty or
        // whitespace-only entry passes the raw `xs?.length > 0` check
        // (length is 1) but is meaningless: empty orgs hit `/orgs//repos`
        // and 404, empty repos are dropped at poll time by the owner/repo
        // split guard. Duplicates waste API quota. Cleaning both inputs
        // through the same pipeline keeps explicit-repos and orgs
        // symmetric — there's no reason orgs would be stricter.
        const repos = clean(this.config.repos);
        const orgs = clean(this.config.orgs);
        if (repos.length === 0 && orgs.length === 0) {
            throw new Error('github-poll: at least one of `repos` or `orgs` is required');
        }
        this.orgs = orgs;
        this.enabledEvents = new Set(this.config.events ?? SUPPORTED_EVENTS);

        // Seed explicit repos immediately. Org enumeration is async and
        // happens in registerRoutes (we don't want initialize to block on
        // network during engine startup).
        this.explicitRepos = new Set(repos);
    }

    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void {
        this.onEvent = onEvent;
        // No HTTP routes needed — polling is timer-based.
        // Start polling after a short delay to let the server finish booting.
        const interval = (this.config.interval ?? DEFAULT_INTERVAL) * 1000;
        const orgRefreshMs = (this.config.org_refresh ?? DEFAULT_ORG_REFRESH) * 1000;

        // Wrapped invocation of refreshOrgRepos with a terminal `.catch`.
        // refreshOrgRepos doesn't reject today — per-org failures are
        // already caught inside — but the org-refresh setInterval below
        // and the startup chain don't await the promise. A future
        // refactor that lets a top-level synchronous throw escape (e.g.
        // adding a metrics call, a snapshot helper, or a config
        // re-validation) would otherwise produce an unhandledRejection
        // and crash the process under Node's default behaviour. Cheap
        // hardening while the surface is small.
        const safeRefresh = (): Promise<void> => {
            return this.refreshOrgRepos().catch((err: unknown) => {
                this.logger.error(
                    { err: errMessage(err) },
                    'github-poll: refreshOrgRepos failed',
                );
            });
        };

        // Store the startup-delay handle and re-check `stopped` at every
        // async boundary. Without these guards, `stop()` called during the
        // first 2s (common in tests and fast graceful shutdowns) would
        // race: the setTimeout still fires, refreshOrgRepos issues a
        // network call, and then `setInterval` arms two timers that the
        // already-returned stop() can never clear.
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null;
            if (this.stopped) return;
            // Block the first poll on the initial org enumeration so the
            // seed run sees the full repo set. Subsequent refreshes
            // happen on a separate timer in the background.
            void safeRefresh().then(() => {
                if (this.stopped) return;
                void this.poll();
                this.timer = setInterval(() => this.poll(), interval);
                if (this.orgs.length > 0) {
                    this.orgRefreshTimer = setInterval(safeRefresh, orgRefreshMs);
                }
            });
        }, 2000);
    }

    parseEvent(_request: FastifyRequest): EventPayload {
        // Not used — events are emitted directly from poll()
        throw new Error('github-poll does not use parseEvent');
    }

    /** Stop the poll timer (for clean shutdown).
     *
     *  Idempotent: clears the startup setTimeout, the poll setInterval, the
     *  org-refresh setInterval, and flips `stopped` so any deferred
     *  callback that was already scheduled bails out before re-arming
     *  intervals on an already-stopped integration. */
    stop(): void {
        this.stopped = true;
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.orgRefreshTimer) {
            clearInterval(this.orgRefreshTimer);
            this.orgRefreshTimer = null;
        }
    }

    /** Union of explicit repos + every org's enumerated repos. Computed
     *  on demand so the poll loop always sees the latest refresh state. */
    private allRepos(): Set<string> {
        const out = new Set<string>(this.explicitRepos);
        for (const repos of this.orgRepos.values()) {
            for (const r of repos) out.add(r);
        }
        return out;
    }

    /** Re-enumerate every configured org and REPLACE its slot in
     *  `this.orgRepos`. A network failure for one org logs and keeps
     *  that org's previous set in place — beats blanking the watch
     *  list because of a transient API hiccup.
     *
     *  Re-entrance guard (`this.refreshing`): if a previous refresh is
     *  still in flight when the interval timer fires (slow API, large
     *  org, retries inside `apiGetAllPages`), the second invocation
     *  exits immediately rather than racing the first. Without this,
     *  both runs would write to `this.orgRepos.set(org, ...)` for the
     *  same key with last-writer-wins ordering that isn't tied to data
     *  freshness — the late writer might be stale.
     *
     *  State pruning: any repo that dropped out of the watch-set union
     *  between the pre- and post-refresh snapshots has its per-repo
     *  entries deleted from `this.state`. Diffing the *union* (not just
     *  one org's set) is what makes this safe — a repo that's also in
     *  the explicit list, or that's still enumerated by another org,
     *  stays in the union and isn't pruned. Without that nuance, a
     *  cross-org or explicit-list overlap would lose its state and
     *  reseed on the next poll (re-emitting every PR as "new"). */
    private async refreshOrgRepos(): Promise<void> {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
            const previousUnion = this.allRepos();
            for (const org of this.orgs) {
                // Cooperative cancellation point: stop() may have been
                // called while we were awaiting the previous org's
                // enumeration. The startup-tick guard alone doesn't help
                // mid-refresh — bail before issuing the next fetch so
                // we don't burn API quota on a stopped integration.
                if (this.stopped) return;
                try {
                    const repos = await this.enumerateOrgRepos(org);
                    // Re-check after the await: stop() could have fired
                    // while the fetch was in flight. We DO want to
                    // discard the response rather than mutate
                    // `this.orgRepos` post-stop.
                    if (this.stopped) return;
                    this.orgRepos.set(org, new Set(repos));
                } catch (err) {
                    this.logger.error(
                        { org, err: errMessage(err) },
                        'github-poll: failed to refresh repos for org',
                    );
                }
            }
            if (this.stopped) return;
            const currentUnion = this.allRepos();
            for (const repoFull of previousUnion) {
                if (!currentUnion.has(repoFull)) {
                    this.pruneState(repoFull);
                }
            }
        } finally {
            this.refreshing = false;
        }
    }

    /** Drop every per-repo entry from the poll state. Called for repos
     *  that just fell out of the watch-set union (org removed them, or
     *  the user re-configured). Long-lived processes with org churn
     *  would otherwise accumulate map entries without bound.
     *
     *  Also removes the repo from `seededRepos` so that if it later
     *  re-enters the watch set (a "briefly private, then public again"
     *  churn path that org enumeration specifically enables), its first
     *  re-poll is treated as a seed — populates the lastXxxIds snapshots
     *  silently — rather than flooding `pull_request.opened` /
     *  `issues.opened` / `push` / `issue_comment.created` for every
     *  existing item it sees on the re-introduced repo. Forgetting this
     *  delete defeats the entire per-repo seeding invariant on the
     *  re-join case. */
    private pruneState(repoFull: string): void {
        this.state.lastPrIds.delete(repoFull);
        this.state.lastPrHeadShas.delete(repoFull);
        this.state.lastPrStates.delete(repoFull);
        this.state.lastIssueIds.delete(repoFull);
        this.state.lastIssueStates.delete(repoFull);
        this.state.lastBranchShas.delete(repoFull);
        this.state.lastCommentIds.delete(repoFull);
        this.state.lastReviewIds.delete(repoFull);
        this.state.seededRepos.delete(repoFull);
    }

    private async enumerateOrgRepos(org: string): Promise<string[]> {
        // `type=all` returns public + private repos the token can see;
        // `sort=updated` puts active repos first which doesn't matter
        // for correctness but makes the early-pagination cancel paths
        // (rate-limit, network blip) skew toward useful entries.
        const url = `${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos?per_page=100&type=all&sort=updated`;
        const data = await this.apiGet(url);
        if (!Array.isArray(data)) return [];
        return data
            .map((r) => (r as Record<string, unknown>).full_name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
    }

    // ─── Polling Logic ──────────────────────────────────────────────────

    private async poll(): Promise<void> {
        // Iterate the union of explicit + org-enumerated repos. Computed
        // fresh each poll so a background org refresh that landed
        // between cycles is picked up immediately.
        for (const repoFull of this.allRepos()) {
            try {
                await this.pollRepo(repoFull);
            } catch (err) {
                // Don't crash on individual repo errors
                this.logger.error(
                    { repo: repoFull, err: errMessage(err) },
                    'github-poll: error polling repo',
                );
            }
        }
    }

    private async pollRepo(repoFull: string): Promise<void> {
        const [owner, repo] = repoFull.split('/');
        if (!owner || !repo) return;

        // Per-repo first-sight flag. A repo that joins the watch set via
        // a post-startup org refresh has empty per-repo state maps; the
        // first cycle must populate them silently rather than firing
        // pull_request.opened / issues.opened / push events for every
        // existing item on that repo. Sub-pollers gate their emit logic
        // on this flag and we commit it to `seededRepos` only after the
        // full repo's poll completes successfully — a partial-failure
        // cycle (one sub-poller throws) replays as another first-sight
        // next time instead of leaving a half-seeded repo that would
        // emit events for the un-snapshotted sub-categories.
        const firstSight = !this.state.seededRepos.has(repoFull);

        if (this.wantsEvent('pull_request')) {
            await this.pollPullRequests(owner, repo, firstSight);
        }
        if (this.wantsEvent('issues')) {
            await this.pollIssues(owner, repo, firstSight);
        }
        if (this.enabledEvents.has('push')) {
            await this.pollPushes(owner, repo, firstSight);
        }
        if (this.enabledEvents.has('issue_comment.created')) {
            await this.pollComments(owner, repo, firstSight);
        }
        if (this.enabledEvents.has('pull_request_review.submitted')) {
            await this.pollPullRequestReviews(owner, repo, firstSight);
        }

        // Mid-poll guard: an org-refresh that landed between our awaits
        // may have pruneState()'d this repo (dropped from the watch-set
        // union). Re-adding it to seededRepos here would mean a later
        // re-entry finds firstSight=false against empty lastXxxIds and
        // floods every existing PR/issue/comment/branch as a "new"
        // event — exactly the failure mode the per-repo seeding refactor
        // exists to prevent. Skip the seed bookkeeping for a repo we no
        // longer watch.
        if (firstSight && this.allRepos().has(repoFull)) {
            this.state.seededRepos.add(repoFull);
        }
    }

    private wantsEvent(prefix: string): boolean {
        for (const e of this.enabledEvents) {
            if (e.startsWith(prefix)) return true;
        }
        return false;
    }

    // ─── PR Polling ─────────────────────────────────────────────────────

    private async pollPullRequests(owner: string, repo: string, firstSight: boolean): Promise<void> {
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

            if (firstSight) continue; // Seed run — just collect state

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

        // Mid-poll guard: see comment in pollRepo. If a refresh has
        // pruneState()'d this repo while our awaits were in flight,
        // restoring the snapshot would resurrect state that the prune
        // intentionally cleared.
        if (this.allRepos().has(key)) {
            this.state.lastPrIds.set(key, newIds);
            this.state.lastPrHeadShas.set(key, newHeadShas);
            this.state.lastPrStates.set(key, newStates);
        }
    }

    // ─── Issue Polling ──────────────────────────────────────────────────

    private async pollIssues(owner: string, repo: string, firstSight: boolean): Promise<void> {
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

            if (firstSight) continue;

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

        if (this.allRepos().has(key)) {
            this.state.lastIssueIds.set(key, newIds);
            this.state.lastIssueStates.set(key, newStates);
        }
    }

    // ─── Push Polling (via branches) ────────────────────────────────────

    private async pollPushes(owner: string, repo: string, firstSight: boolean): Promise<void> {
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

            if (firstSight) continue;

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

        if (this.allRepos().has(key)) {
            this.state.lastBranchShas.set(key, newShas);
        }
    }

    // ─── Comment Polling ────────────────────────────────────────────────

    private async pollComments(owner: string, repo: string, firstSight: boolean): Promise<void> {
        const key = `${owner}/${repo}`;
        const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/comments?sort=updated&direction=desc&per_page=20`;
        const comments = await this.apiGet(url) as Array<Record<string, unknown>>;

        const oldIds = this.state.lastCommentIds.get(key) ?? new Set<number>();
        const newIds = new Set<number>();

        for (const comment of comments) {
            const id = comment.id as number;
            newIds.add(id);

            if (firstSight) continue;

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

        if (this.allRepos().has(key)) {
            this.state.lastCommentIds.set(key, newIds);
        }
    }

    // ─── PR Review Polling ──────────────────────────────────────────────

    private async pollPullRequestReviews(owner: string, repo: string, firstSight: boolean): Promise<void> {
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

                if (firstSight) continue;
                if (oldIds.has(id)) continue;

                // Emit event for new reviews
                await this.emit('pull_request_review.submitted', owner, repo, {
                    action: 'submitted',
                    review,
                    pull_request: pr,
                });
            }
        }

        if (this.allRepos().has(key)) {
            this.state.lastReviewIds.set(key, newIds);
        }
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
