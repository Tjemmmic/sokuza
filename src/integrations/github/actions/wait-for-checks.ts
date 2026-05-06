import { GitHubApiClient } from '../api.js';
import type { ActionContext, ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

const DEFAULT_TIMEOUT_S = 600; // 10 min — long enough for typical CI
const DEFAULT_INTERVAL_S = 15;
const MIN_INTERVAL_S = 1;          // guard against tight loops hammering the API
const MAX_INTERVAL_S = 600;        // 10 min — anything coarser is a misconfig, not a feature
const MAX_TIMEOUT_S = 6 * 60 * 60; // 6h hard ceiling so a typo can't run forever
// Default 15s interval × 6h ceiling = 1440 polls × 2 HTTP requests = 2880
// req/invocation. GitHub's authenticated quota is 5000/h, so a single
// long-running action can still consume the full org budget. The interval
// floor keeps misconfigs from making this worse; the parallelised polls
// halve wall-clock time for large CI matrices.

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale']);

/**
 * "github-wait-for-checks" — poll commit checks (both Checks API
 * runs and the legacy combined status) until they're all complete or
 * the timeout fires.
 *
 * Resolves the SHA from (in order):
 *   1. params.sha
 *   2. params.head_sha
 *   3. event.payload.pull_request.head.sha
 *   4. — fail with a clear message
 *
 * Output `success` is true only when every check concluded with a
 * non-failed conclusion AND the rollup combined-status state is
 * 'success' (or empty, meaning no legacy statuses exist).
 */
export const githubWaitForChecksAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-wait-for-checks');
    const target = resolveRepoTarget(params, context, 'github-wait-for-checks');

    const sha = resolveSha(params, context);
    if (!sha) {
        throw new Error('github-wait-for-checks: no commit SHA found (params.sha, head_sha, or event payload pull_request.head.sha)');
    }

    const timeoutSec = clampPositive(params.timeout, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, 'timeout');
    const intervalSec = clampPositive(params.interval, DEFAULT_INTERVAL_S, MAX_INTERVAL_S, 'interval', MIN_INTERVAL_S);
    if (intervalSec > timeoutSec) {
        throw new Error(`github-wait-for-checks: interval (${intervalSec}s) cannot exceed timeout (${timeoutSec}s)`);
    }
    const client = new GitHubApiClient(token);

    const deadline = Date.now() + timeoutSec * 1000;
    let lastSnapshot = { totalChecks: 0, pending: 0, failed: [] as string[], state: '' };
    // Log only when the snapshot meaningfully changes — keeps the log
    // from drowning at default 15s/40-poll-cap settings.
    let lastLoggedKey = '';

    while (Date.now() < deadline) {
        // Honour aborts before each poll so a workflow cancelled mid-sleep
        // doesn't fire one final HTTP call after waking up. The runtime's
        // outer abort race unblocks the await, but the action itself keeps
        // running unless we bail here too.
        if (context.signal?.aborted) throw new Error('Workflow aborted');
        const snapshot = await pollOnce(client, target.owner, target.repo, sha);
        lastSnapshot = snapshot;

        if (snapshot.pending === 0 && snapshot.state !== 'pending') {
            return {
                success: snapshot.failed.length === 0 && (snapshot.state === '' || snapshot.state === 'success'),
                failedChecks: snapshot.failed,
                totalChecks: snapshot.totalChecks,
                state: snapshot.state,
                sha,
                timedOut: false,
            };
        }

        const key = `${snapshot.pending}/${snapshot.failed.length}/${snapshot.state}`;
        if (key !== lastLoggedKey) {
            context.logger.info(
                { sha, pending: snapshot.pending, failed: snapshot.failed.length, total: snapshot.totalChecks, state: snapshot.state },
                'Checks still running, will retry',
            );
            lastLoggedKey = key;
        }
        await sleep(intervalSec * 1000, context.signal);
    }

    return {
        success: false,
        failedChecks: lastSnapshot.failed,
        totalChecks: lastSnapshot.totalChecks,
        state: lastSnapshot.state,
        sha,
        timedOut: true,
    };
};

interface CheckSnapshot {
    totalChecks: number;
    pending: number;
    failed: string[];
    /** Aggregate combined-status rollup state (empty when no legacy statuses exist). */
    state: string;
}

/** Single read of check-runs + combined-status for one SHA, normalised.
 *  Issues both API calls in parallel — they're independent and each round-
 *  trip dominates pollOnce wall-time. */
async function pollOnce(client: GitHubApiClient, owner: string, repo: string, sha: string): Promise<CheckSnapshot> {
    const [runs, combined] = await Promise.all([
        client.getCheckRuns(owner, repo, sha),
        client.getCombinedStatus(owner, repo, sha),
    ]);
    const failed: string[] = [];
    let pending = 0;
    for (const run of runs) {
        const status = String((run as { status?: unknown }).status ?? '');
        const conclusion = String((run as { conclusion?: unknown }).conclusion ?? '');
        const name = String((run as { name?: unknown }).name ?? 'check');
        if (status !== 'completed') {
            pending++;
            continue;
        }
        if (FAILED_CONCLUSIONS.has(conclusion)) failed.push(name);
    }

    // Legacy combined-status. The `statuses[]` array can carry stale
    // older postings for the same context — dedupe by context, keeping
    // the most recent updated_at, before tallying.
    const state = String((combined as { state?: unknown }).state ?? '');
    const rawStatuses = Array.isArray((combined as { statuses?: unknown }).statuses)
        ? (combined as { statuses: Array<Record<string, unknown>> }).statuses
        : [];
    const latestByContext = new Map<string, Record<string, unknown>>();
    for (const s of rawStatuses) {
        const ctx = String(s.context ?? 'status');
        const updated = typeof s.updated_at === 'string' ? Date.parse(s.updated_at) : 0;
        const prev = latestByContext.get(ctx);
        const prevUpdated = prev && typeof prev.updated_at === 'string' ? Date.parse(prev.updated_at) : 0;
        if (!prev || updated >= prevUpdated) latestByContext.set(ctx, s);
    }
    for (const s of latestByContext.values()) {
        const sState = String(s.state ?? '');
        if (sState === 'pending') pending++;
        else if (sState === 'failure' || sState === 'error') failed.push(String(s.context ?? 'status'));
    }

    return {
        totalChecks: runs.length + latestByContext.size,
        pending,
        failed,
        state,
    };
}

function resolveSha(params: Parameters<ActionHandler>[0], context: ActionContext): string {
    if (typeof params.sha === 'string' && params.sha) return params.sha;
    if (typeof params.head_sha === 'string' && params.head_sha) return params.head_sha;
    const payload = context.event.payload as Record<string, unknown> | undefined;
    const pr = payload?.pull_request as Record<string, unknown> | undefined;
    const head = pr?.head as Record<string, unknown> | undefined;
    return typeof head?.sha === 'string' ? head.sha : '';
}

/** Coerce + range-check a positive-number param, falling back to a default
 *  when the user supplied no value. Throws on NaN/non-finite/below-min;
 *  silently clamps an over-max input down to max so a paste-typo (e.g.
 *  "60000" instead of "600") doesn't lock up an invocation forever. */
function clampPositive(raw: unknown, fallback: number, max: number, name: string, min = 0.001): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < min) {
        throw new Error(`github-wait-for-checks: ${name} must be a positive number >= ${min} (got ${String(raw)})`);
    }
    return Math.min(n, max);
}

/** Abort-aware sleep. Resolves on the timer normally; rejects with
 *  "Workflow aborted" the moment the signal fires (or immediately, if it
 *  was already aborted on entry). The single cleanup point clears the
 *  timer and removes the listener regardless of which event wins, so the
 *  workflow signal — which can outlive many sleeps — never accumulates
 *  dead listeners. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (cb: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            cb();
        };
        const onAbort = () => finish(() => reject(new Error('Workflow aborted')));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(() => resolve()), ms);
    });
}
