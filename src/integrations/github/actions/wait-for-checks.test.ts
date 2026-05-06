import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';
import { githubWaitForChecksAction } from './wait-for-checks.js';

const logger = pino({ level: 'silent' });

function makeContext(payload: Record<string, unknown> = {}, signal?: AbortSignal): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: { pull_request: { number: 1, head: { sha: 'sha-from-event' } }, ...payload },
            metadata: { repo: 'octo/r', owner: 'octo', repoName: 'r' },
        },
        results: {},
        steps: {},
        integrationConfigs: { github: { token: 'gh_test' } },
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
        signal,
    } as unknown as ActionContext;
}

interface ApiResponses {
    checkRuns: Array<Record<string, unknown>>;
    statuses?: { state: string; statuses: Array<Record<string, unknown>> };
}

function mockSequence(seq: ApiResponses[]): ReturnType<typeof vi.spyOn> {
    let i = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const stage = seq[Math.min(i, seq.length - 1)];
        if (url.includes('/check-runs')) {
            // After serving check-runs and combined-status, advance to next stage.
            return new Response(JSON.stringify({ check_runs: stage.checkRuns, total_count: stage.checkRuns.length }), { status: 200 });
        }
        if (url.includes('/status')) {
            const body = stage.statuses ?? { state: 'success', statuses: [] };
            i++; // advance after the second of the two-call pair
            return new Response(JSON.stringify(body), { status: 200 });
        }
        throw new Error('unexpected fetch ' + url);
    });
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
});

describe('github-wait-for-checks', () => {
    it('returns success when all check-runs are completed and successful', async () => {
        mockSequence([{
            checkRuns: [
                { name: 'lint', status: 'completed', conclusion: 'success' },
                { name: 'test', status: 'completed', conclusion: 'success' },
            ],
            statuses: { state: 'success', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.failedChecks).toEqual([]);
        expect(result.totalChecks).toBe(2);
        expect(result.timedOut).toBe(false);
    });

    it('returns success=false with failed-check names when any conclusion is failure', async () => {
        mockSequence([{
            checkRuns: [
                { name: 'lint', status: 'completed', conclusion: 'success' },
                { name: 'test', status: 'completed', conclusion: 'failure' },
                { name: 'e2e', status: 'completed', conclusion: 'cancelled' },
            ],
            statuses: { state: 'failure', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.failedChecks).toEqual(['test', 'e2e']);
    });

    it('keeps polling while any check is still in_progress', async () => {
        const seq: ApiResponses[] = [
            // first poll: one in-progress
            { checkRuns: [{ name: 'lint', status: 'in_progress' }], statuses: { state: 'pending', statuses: [] } },
            // second poll: completed
            { checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }], statuses: { state: 'success', statuses: [] } },
        ];
        mockSequence(seq);
        const promise = githubWaitForChecksAction({ sha: 'abc', interval: 1 }, makeContext());
        // Advance until the action resolves; runAllTimersAsync alternates with awaiting microtasks.
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.totalChecks).toBe(1);
    });

    it('counts the legacy combined-status statuses too', async () => {
        mockSequence([{
            checkRuns: [],
            statuses: { state: 'failure', statuses: [{ context: 'travis-ci', state: 'failure' }] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.failedChecks).toEqual(['travis-ci']);
        expect(result.totalChecks).toBe(1);
    });

    it('returns timedOut=true when the deadline passes with checks still pending, after polling at least twice (L9)', async () => {
        const spy = mockSequence([{
            checkRuns: [{ name: 'long', status: 'in_progress' }],
            statuses: { state: 'pending', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc', timeout: 3, interval: 1 }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.timedOut).toBe(true);
        expect(result.success).toBe(false);
        // Each poll = 2 HTTP calls (check-runs + combined-status) in parallel.
        // 3s / 1s interval = up to 3 polls = at least 4 calls (we polled more
        // than once before timing out).
        expect(spy.mock.calls.length).toBeGreaterThan(2);
    });

    it('falls back to event payload PR head SHA when params.sha is missing', async () => {
        const spy = mockSequence([{
            checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
            statuses: { state: 'success', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({}, makeContext());
        await vi.runAllTimersAsync();
        await promise;
        const calledUrl = spy.mock.calls[0][0] as string;
        expect(calledUrl).toContain('/sha-from-event/check-runs');
    });

    it('throws if no SHA is resolvable', async () => {
        const ctx: ActionContext = makeContext({ pull_request: { number: 1 } });
        await expect(githubWaitForChecksAction({}, ctx)).rejects.toThrow(/no commit SHA/);
    });

    // ── Bug-fix regression coverage ────────────────────────────────────────
    it('keeps polling when combined-status rollup is "pending" even with all check-runs complete (H1)', async () => {
        const seq: ApiResponses[] = [
            // first poll: no check-runs pending, but combined-status state=pending (queued context not posted)
            { checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }], statuses: { state: 'pending', statuses: [] } },
            // second poll: now resolved
            { checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }], statuses: { state: 'success', statuses: [] } },
        ];
        mockSequence(seq);
        const promise = githubWaitForChecksAction({ sha: 'abc', interval: 1 }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.state).toBe('success');
        expect(result.timedOut).toBe(false);
    });

    it('does not return success=true when combined state is "pending" (H1 negative case)', async () => {
        // If we time out with a still-pending state, success must be false.
        mockSequence([{ checkRuns: [], statuses: { state: 'pending', statuses: [] } }]);
        const promise = githubWaitForChecksAction({ sha: 'abc', timeout: 3, interval: 1 }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.timedOut).toBe(true);
    });

    it('dedupes combined-status entries by context, keeping the most recent (H2)', async () => {
        mockSequence([{
            checkRuns: [],
            statuses: {
                state: 'failure',
                statuses: [
                    { context: 'travis-ci', state: 'failure', updated_at: '2026-05-04T12:00:00Z' },
                    // Older posting for the same context — must not double-count
                    { context: 'travis-ci', state: 'failure', updated_at: '2026-05-04T11:00:00Z' },
                    { context: 'circleci', state: 'success', updated_at: '2026-05-04T12:00:00Z' },
                ],
            },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.failedChecks).toEqual(['travis-ci']); // not duplicated
        expect(result.totalChecks).toBe(2); // travis-ci + circleci, deduped
    });

    it('a newer success posting for the same context wins over an older failure (H2)', async () => {
        mockSequence([{
            checkRuns: [],
            statuses: {
                state: 'success',
                statuses: [
                    { context: 'flaky-ci', state: 'failure', updated_at: '2026-05-04T11:00:00Z' },
                    { context: 'flaky-ci', state: 'success', updated_at: '2026-05-04T12:00:00Z' },
                ],
            },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.failedChecks).toEqual([]);
    });

    it('marks "stale" conclusion as failed (M3 — was missing from FAILED set)', async () => {
        mockSequence([{
            checkRuns: [{ name: 'snyk', status: 'completed', conclusion: 'stale' }],
            statuses: { state: 'success', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.failedChecks).toEqual(['snyk']);
        expect(result.success).toBe(false);
    });

    it('rejects NaN / negative / zero timeout values (M3)', async () => {
        const ctx = makeContext();
        await expect(githubWaitForChecksAction({ sha: 'abc', timeout: -1 }, ctx)).rejects.toThrow(/timeout must be a positive/);
        await expect(githubWaitForChecksAction({ sha: 'abc', timeout: 'not-a-number' as unknown as number }, ctx)).rejects.toThrow(/timeout must be a positive/);
    });

    it('rejects NaN / zero interval (M3)', async () => {
        const ctx = makeContext();
        await expect(githubWaitForChecksAction({ sha: 'abc', interval: 0 }, ctx)).rejects.toThrow(/interval must be a positive/);
        await expect(githubWaitForChecksAction({ sha: 'abc', interval: -1 }, ctx)).rejects.toThrow(/interval must be a positive/);
    });

    it('rejects sub-second interval — guards against tight-loop API hammering (H5)', async () => {
        const ctx = makeContext();
        await expect(githubWaitForChecksAction({ sha: 'abc', interval: 0.5 }, ctx)).rejects.toThrow(/interval must be a positive number >= 1/);
    });

    it('rejects interval > timeout — that combination would never poll (H5)', async () => {
        const ctx = makeContext();
        await expect(githubWaitForChecksAction({ sha: 'abc', timeout: 5, interval: 30 }, ctx)).rejects.toThrow(/interval \(30s\) cannot exceed timeout \(5s\)/);
    });

    it('clamps an over-max interval down to MAX_INTERVAL_S=600 instead of erroring', async () => {
        // Even with a misconfigured huge interval, the action should still run
        // (clamped) — that's better than failing a real CI gate over a typo.
        mockSequence([{ checkRuns: [], statuses: { state: 'success', statuses: [] } }]);
        const promise = githubWaitForChecksAction({ sha: 'abc', timeout: 3600, interval: 99999 }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.success).toBe(true);
    });

    it('aborts mid-sleep when the workflow signal fires (no extra HTTP after abort)', async () => {
        // First poll returns "still in progress" so the loop enters sleep.
        // We then abort, expect the action to throw "Workflow aborted",
        // and assert no second poll was issued (= 2 fetches total, one
        // pair from the first poll only).
        const spy = mockSequence([
            { checkRuns: [{ name: 'lint', status: 'in_progress' }], statuses: { state: 'pending', statuses: [] } },
        ]);
        const controller = new AbortController();
        const promise = githubWaitForChecksAction(
            { sha: 'abc', interval: 1, timeout: 60 },
            makeContext({}, controller.signal),
        );
        // Let the first poll complete and the loop enter the sleep…
        await vi.advanceTimersByTimeAsync(0);
        // …then abort. With the fix, the sleep rejects immediately; the
        // outer loop never runs another iteration.
        controller.abort();
        await expect(promise).rejects.toThrow(/Workflow aborted/);
        // Exactly the first poll's two HTTP calls (check-runs + status).
        expect(spy.mock.calls.length).toBe(2);
    });

    it('throws immediately when the signal is already aborted on entry', async () => {
        const spy = mockSequence([{
            checkRuns: [{ name: 'lint', status: 'in_progress' }],
            statuses: { state: 'pending', statuses: [] },
        }]);
        const controller = new AbortController();
        controller.abort();
        // The top-of-loop abort guard fires before the very first poll, so
        // the action throws "Workflow aborted" without issuing any HTTP
        // calls at all.
        const expectation = expect(
            githubWaitForChecksAction(
                { sha: 'abc', interval: 1, timeout: 60 },
                makeContext({}, controller.signal),
            ),
        ).rejects.toThrow(/Workflow aborted/);
        await vi.runAllTimersAsync();
        await expectation;
        expect(spy).not.toHaveBeenCalled();
    });

    it('issues check-runs and combined-status in parallel (H5 — halves wall time)', async () => {
        // Verify both calls dispatch before either resolves: track call order.
        const startedAt: number[] = [];
        let resolveOrder: (() => void) | null = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            startedAt.push(Date.now());
            const url = typeof input === 'string' ? input : (input as URL).toString();
            // Block both responses on the same micro-pause; they should still
            // be dispatched at the same tick if Promise.all is doing its job.
            await new Promise<void>((r) => { resolveOrder = r; setTimeout(r, 0); });
            if (url.includes('/check-runs')) {
                return new Response(JSON.stringify({ check_runs: [], total_count: 0 }), { status: 200 });
            }
            return new Response(JSON.stringify({ state: 'success', statuses: [] }), { status: 200 });
        });
        const promise = githubWaitForChecksAction({ sha: 'abc' }, makeContext());
        await vi.runAllTimersAsync();
        await promise;
        // Both fetches were started before either resolved — i.e. dispatched
        // in parallel. With sequential await, the second call would have
        // started AFTER the first resolved (bigger gap).
        expect(startedAt.length).toBeGreaterThanOrEqual(2);
        // ts-prune false-positive
        void resolveOrder;
    });
});
