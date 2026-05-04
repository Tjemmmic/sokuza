import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';
import { githubWaitForChecksAction } from './wait-for-checks.js';

const logger = pino({ level: 'silent' });

function makeContext(payload: Record<string, unknown> = {}): ActionContext {
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

    it('returns timedOut=true when the deadline passes with checks still pending', async () => {
        mockSequence([{
            checkRuns: [{ name: 'long', status: 'in_progress' }],
            statuses: { state: 'pending', statuses: [] },
        }]);
        const promise = githubWaitForChecksAction({ sha: 'abc', timeout: 0.1, interval: 0.05 }, makeContext());
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.timedOut).toBe(true);
        expect(result.success).toBe(false);
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
});
