import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowQueue } from './queue.js';
import type { QueueJob, EventPayload, WorkflowDefinition, ResolvedQueueConfig } from './types.js';
import type { Logger } from 'pino';
import pino from 'pino';
import type { ActionContext, IntegrationConfig } from './types.js';
import type { AIProviderRegistry } from './ai-providers.js';

function makeLogger(): Logger {
    return pino({ level: 'silent' });
}

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'gh-cli',
        event: 'pull_request.opened',
        action: 'opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: { repo: 'org/repo', prNumber: 42 },
        ...overrides,
    };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-workflow',
        trigger: { source: 'gh-cli', event: 'pull_request.opened' },
        steps: [{ action: 'log', params: { message: 'hello' } }],
        ...overrides,
    };
}

function makeResolvedConfig(overrides: Partial<ResolvedQueueConfig> = {}): ResolvedQueueConfig {
    return {
        concurrency: 3,
        dedup: 'latest-wins',
        dedupKey: 'test-workflow:org/repo:42',
        priority: 'normal',
        timeout: 300,
        retry: 0,
        retryDelay: 30,
        ...overrides,
    };
}

describe('WorkflowQueue', () => {
    let queue: WorkflowQueue;

    beforeEach(() => {
        queue = new WorkflowQueue(makeLogger(), 5, 50);
    });

    describe('enqueue', () => {
        it('should enqueue a job with correct metadata', () => {
            const job = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig(),
            );

            expect(job.id).toMatch(/^job_/);
            expect(job.status).toBe('queued');
            expect(job.priority).toBe('normal');
            expect(job.workflow.name).toBe('test-workflow');
            expect(job.dedupKey).toBe('test-workflow:org/repo:42');
        });

        it('should maintain priority ordering', () => {
            const normal = queue.enqueue(makeWorkflow({ name: 'normal-wf' }), makeEvent(), makeResolvedConfig({ priority: 'normal', dedupKey: 'normal' }));
            const critical = queue.enqueue(makeWorkflow({ name: 'critical-wf' }), makeEvent(), makeResolvedConfig({ priority: 'critical', dedupKey: 'critical' }));
            const low = queue.enqueue(makeWorkflow({ name: 'low-wf' }), makeEvent(), makeResolvedConfig({ priority: 'low', dedupKey: 'low' }));

            const jobs = queue.getJobs('queued');
            expect(jobs[0].id).toBe(critical.id);
            expect(jobs[1].id).toBe(normal.id);
            expect(jobs[2].id).toBe(low.id);
        });
    });

    describe('deduplication', () => {
        it('should replace queued job on latest-wins', () => {
            const first = queue.enqueue(
                makeWorkflow(),
                makeEvent({ payload: { v: 1 } }),
                makeResolvedConfig({ dedup: 'latest-wins', dedupKey: 'same-key' }),
            );

            const second = queue.enqueue(
                makeWorkflow(),
                makeEvent({ payload: { v: 2 } }),
                makeResolvedConfig({ dedup: 'latest-wins', dedupKey: 'same-key' }),
            );

            expect(second.status).toBe('queued');
            expect(first.status).toBe('deduped');

            const jobs = queue.getJobs('queued');
            expect(jobs).toHaveLength(1);
            expect(jobs[0].id).toBe(second.id);
        });

        it('should drop duplicate on drop-duplicate', () => {
            queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'drop-duplicate', dedupKey: 'same-key' }),
            );

            const second = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'drop-duplicate', dedupKey: 'same-key' }),
            );

            expect(second.status).toBe('deduped');

            const jobs = queue.getJobs('queued');
            expect(jobs).toHaveLength(1);
        });

        it('should allow different dedup keys', () => {
            queue.enqueue(
                makeWorkflow(),
                makeEvent({ metadata: { repo: 'org/repo', prNumber: 1 } }),
                makeResolvedConfig({ dedupKey: 'wf:org/repo:1' }),
            );

            const second = queue.enqueue(
                makeWorkflow(),
                makeEvent({ metadata: { repo: 'org/repo', prNumber: 2 } }),
                makeResolvedConfig({ dedupKey: 'wf:org/repo:2' }),
            );

            expect(second.status).toBe('queued');
            expect(queue.getJobs('queued')).toHaveLength(2);
        });

        it('should not dedup when strategy is none', () => {
            queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'same-key' }),
            );
            queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'same-key' }),
            );

            expect(queue.getJobs('queued')).toHaveLength(2);
        });
    });

    describe('cancel', () => {
        it('should cancel a queued job', () => {
            const job = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'cancel-test' }),
            );

            const ok = queue.cancel(job.id);
            expect(ok).toBe(true);
            expect(job.status).toBe('cancelled');
            expect(queue.getJobs('queued')).toHaveLength(0);
        });

        it('should return false for unknown job', () => {
            expect(queue.cancel('nonexistent')).toBe(false);
        });
    });

    describe('retry', () => {
        it('should retry a failed job', () => {
            const job = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'retry-test' }),
            );

            job.status = 'failed';
            job.error = 'something broke';
            queue.cancel(job.id);

            const ok = queue.retry(job.id);
            expect(ok).toBe(true);
            expect(job.status).toBe('queued');
            expect(job.error).toBeUndefined();
        });

        it('should return false for non-failed job', () => {
            const job = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'no-retry' }),
            );

            expect(queue.retry(job.id)).toBe(false);
        });
    });

    describe('getStats', () => {
        it('should return correct stats', () => {
            queue.enqueue(
                makeWorkflow({ name: 'wf1' }),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'stats-1' }),
            );
            queue.enqueue(
                makeWorkflow({ name: 'wf2' }),
                makeEvent(),
                makeResolvedConfig({ dedup: 'none', dedupKey: 'stats-2' }),
            );

            const stats = queue.getStats();
            expect(stats.byStatus.queued).toBe(2);
            expect(stats.byStatus.running).toBe(0);
            expect(stats.availableSlots).toBe(5);
        });
    });

    describe('getJob', () => {
        it('should find a job by id', () => {
            const job = queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedupKey: 'find-test' }),
            );

            const found = queue.getJob(job.id);
            expect(found).toBeDefined();
            expect(found!.id).toBe(job.id);
        });

        it('should return undefined for unknown id', () => {
            expect(queue.getJob('nonexistent')).toBeUndefined();
        });
    });

    describe('onJobUpdate callback', () => {
        it('should fire callback on enqueue', () => {
            const updates: QueueJob[] = [];
            queue.setOnJobUpdate((job) => updates.push(job));

            queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedupKey: 'cb-test' }),
            );

            expect(updates).toHaveLength(1);
            expect(updates[0].status).toBe('queued');
        });
    });

    describe('shutdown', () => {
        it('should complete without error', async () => {
            queue.enqueue(
                makeWorkflow(),
                makeEvent(),
                makeResolvedConfig({ dedupKey: 'shutdown-test' }),
            );
            await expect(queue.shutdown()).resolves.toBeUndefined();
        });

        it('should respect timeout and force-clear remaining jobs', async () => {
            const q = new WorkflowQueue(makeLogger(), 1, 10);
            let resolveExec: () => void = () => {};
            q.setExecutor(
                async () => new Promise<void>((r) => { resolveExec = r; }),
                { integrationConfigs: {}, ai: undefined },
            );

            q.enqueue(makeWorkflow(), makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'hang' }));

            await new Promise((r) => setTimeout(r, 50));
            expect(q.getJobs('running')).toHaveLength(1);

            const shutdownPromise = q.shutdown(100);
            await expect(shutdownPromise).resolves.toBeUndefined();
        });
    });

    describe('concurrency', () => {
        it('should respect maxConcurrency via tick', async () => {
            const q = new WorkflowQueue(makeLogger(), 2, 10);
            const started: string[] = [];
            const resolvers: Array<() => void> = [];

            q.setExecutor(
                async (job) => {
                    started.push(job.id);
                    await new Promise<void>((r) => { resolvers.push(r); });
                },
                { integrationConfigs: {}, ai: undefined },
            );

            const j1 = q.enqueue(makeWorkflow({ name: 'wf1' }), makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'c1', concurrency: 10 }));
            const j2 = q.enqueue(makeWorkflow({ name: 'wf2' }), makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'c2', concurrency: 10 }));
            const j3 = q.enqueue(makeWorkflow({ name: 'wf3' }), makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'c3', concurrency: 10 }));

            await new Promise((r) => setTimeout(r, 50));

            expect(started).toHaveLength(2);
            expect(q.getJobs('running')).toHaveLength(2);
            expect(q.getJobs('queued')).toHaveLength(1);

            resolvers[0]();
            await new Promise((r) => setTimeout(r, 50));

            expect(started).toHaveLength(3);
            expect(q.getJobs('queued')).toHaveLength(0);

            resolvers[1]();
            resolvers[2]();
            await new Promise((r) => setTimeout(r, 50));
        });

        it('should respect per-workflow concurrency', async () => {
            const q = new WorkflowQueue(makeLogger(), 10, 10);
            const started: string[] = [];
            const resolvers: Array<() => void> = [];

            q.setExecutor(
                async (job) => {
                    started.push(job.id);
                    await new Promise<void>((r) => { resolvers.push(r); });
                },
                { integrationConfigs: {}, ai: undefined },
            );

            const wf = makeWorkflow({ name: 'limited-wf' });
            const j1 = q.enqueue(wf, makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'pw1', concurrency: 1 }));
            const j2 = q.enqueue(wf, makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'pw2', concurrency: 1 }));

            await new Promise((r) => setTimeout(r, 50));

            expect(started).toHaveLength(1);
            expect(q.getJobs('queued')).toHaveLength(1);

            resolvers[0]();
            await new Promise((r) => setTimeout(r, 50));

            expect(started).toHaveLength(2);

            resolvers[1]();
            await new Promise((r) => setTimeout(r, 50));
        });

        it('should drain retried jobs', async () => {
            const q = new WorkflowQueue(makeLogger(), 5, 10);
            let attempt = 0;

            q.setExecutor(
                async (job) => {
                    attempt++;
                    if (attempt === 1) throw new Error('first fail');
                },
                { integrationConfigs: {}, ai: undefined },
            );

            const job = q.enqueue(makeWorkflow(), makeEvent(), makeResolvedConfig({ dedup: 'none', dedupKey: 'retry-drain', retry: 1, retryDelay: 0 }));

            await new Promise((r) => setTimeout(r, 200));

            expect(job.status).toBe('completed');
        });
    });
});
