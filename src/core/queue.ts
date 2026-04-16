import type { Logger } from 'pino';
import type {
    ActionContext,
    EventPayload,
    IntegrationConfig,
    JobPriority,
    JobStatus,
    QueueJob,
    ResolvedQueueConfig,
    WorkflowDefinition,
} from './types.js';
import { JOB_PRIORITY_ORDER } from './types.js';
import type { AIProviderRegistry } from './ai-providers.js';
import { executeWorkflow } from './workflow.js';

type JobCallback = (job: QueueJob) => void;
export type JobExecutor = (
    job: QueueJob,
    integrationConfigs: Record<string, IntegrationConfig>,
    ai: AIProviderRegistry | undefined,
    recordWebhookDelivery?: ActionContext['recordWebhookDelivery'],
) => Promise<void>;

export class WorkflowQueue {
    private queue: QueueJob[] = [];
    private running = new Map<string, QueueJob>();
    private completed: QueueJob[] = [];
    private readonly maxHistory: number;

    private concurrencyCount = 0;
    private readonly maxConcurrency: number;

    private dedupMap = new Map<string, string>();
    private abortControllers = new Map<string, AbortController>();

    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private readonly logger: Logger;

    private jobUpdateCallbacks = new Set<JobCallback>();

    private jobIdCounter = 0;

    private executor: JobExecutor | null = null;
    private executorContext: {
        integrationConfigs: Record<string, IntegrationConfig>;
        ai: AIProviderRegistry | undefined;
        recordWebhookDelivery?: ActionContext['recordWebhookDelivery'];
    } | null = null;

    private tickScheduled = false;
    private shuttingDown = false;

    constructor(logger: Logger, maxConcurrency = 10, maxHistory = 200) {
        this.logger = logger;
        this.maxConcurrency = maxConcurrency;
        this.maxHistory = maxHistory;
    }

    setOnJobUpdate(cb: JobCallback): void {
        this.jobUpdateCallbacks.add(cb);
    }

    onJobUpdate(cb: JobCallback): () => void {
        this.jobUpdateCallbacks.add(cb);
        return () => { this.jobUpdateCallbacks.delete(cb); };
    }

    setExecutor(executor: JobExecutor, context: {
        integrationConfigs: Record<string, IntegrationConfig>;
        ai: AIProviderRegistry | undefined;
        recordWebhookDelivery?: ActionContext['recordWebhookDelivery'];
    }): void {
        this.executor = executor;
        this.executorContext = context;
    }

    enqueue(
        workflow: WorkflowDefinition,
        event: EventPayload,
        resolvedConfig: ResolvedQueueConfig,
    ): QueueJob {
        const job: QueueJob = {
            id: `job_${Date.now()}_${++this.jobIdCounter}`,
            workflow: structuredClone(workflow),
            event: structuredClone(event),
            status: 'queued',
            priority: resolvedConfig.priority,
            resolvedConfig,
            enqueuedAt: new Date().toISOString(),
            dedupKey: resolvedConfig.dedupKey,
            attempts: 0,
        };

        if (resolvedConfig.dedup !== 'none') {
            const existing = this.applyDedup(job);
            if (existing && existing.status === 'deduped') {
                this.notify(existing);
                return existing;
            }
        }

        this.insertByPriority(job);
        this.logger.info(
            { jobId: job.id, workflow: workflow.name, priority: job.priority, dedupKey: job.dedupKey, queueDepth: this.queue.length },
            'Job enqueued',
        );
        this.notify(job);
        this.scheduleTick();

        return job;
    }

    cancel(jobId: string): boolean {
        const queuedIdx = this.queue.findIndex((j) => j.id === jobId);
        if (queuedIdx !== -1) {
            const [job] = this.queue.splice(queuedIdx, 1);
            job.status = 'cancelled';
            job.completedAt = new Date().toISOString();
            this.removeFromDedup(job);
            this.addToHistory(job);
            this.notify(job);
            this.logger.info({ jobId }, 'Queued job cancelled');
            return true;
        }

        const running = this.running.get(jobId);
        if (running) {
            const ac = this.abortControllers.get(jobId);
            if (ac) ac.abort();
            running.status = 'cancelled';
            running.completedAt = new Date().toISOString();
            this.removeFromDedup(running);
            this.releaseConcurrency(running);
            this.running.delete(jobId);
            this.clearTimer(jobId);
            this.addToHistory(running);
            this.notify(running);
            this.logger.info({ jobId }, 'Running job cancelled');
            return true;
        }

        return false;
    }

    retry(jobId: string): boolean {
        const job = this.completed.find((j) => j.id === jobId);
        if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) {
            return false;
        }

        this.completed = this.completed.filter((j) => j.id !== jobId);
        job.status = 'queued';
        job.error = undefined;
        job.completedAt = undefined;
        job.startedAt = undefined;

        this.insertByPriority(job);
        this.notify(job);
        this.logger.info({ jobId: job.id, workflow: job.workflow.name }, 'Job retried');
        this.scheduleTick();
        return true;
    }

    getJob(jobId: string): QueueJob | undefined {
        return (
            this.queue.find((j) => j.id === jobId) ??
            this.running.get(jobId) ??
            this.completed.find((j) => j.id === jobId)
        );
    }

    getJobs(status?: JobStatus): QueueJob[] {
        if (status === 'queued') return [...this.queue];
        if (status === 'running') return [...this.running.values()];
        if (status) return this.completed.filter((j) => j.status === status);
        return [...this.queue, ...this.running.values(), ...this.completed];
    }

    getStats(): QueueStats {
        const byStatus: Record<string, number> = {
            queued: this.queue.length,
            running: this.running.size,
            completed: 0,
            failed: 0,
            cancelled: 0,
            deduped: 0,
        };
        for (const j of this.completed) {
            byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
        }

        const avgDurationMs = this.computeAvgDurationMs();

        return {
            totalEnqueued: this.queue.length + this.running.size + this.completed.length,
            availableSlots: this.maxConcurrency - this.concurrencyCount,
            byStatus,
            avgDurationMs,
        };
    }

    async shutdown(timeoutMs = 30_000): Promise<void> {
        this.shuttingDown = true;

        for (const [id] of this.retryTimers) {
            clearTimeout(this.retryTimers.get(id));
        }
        this.retryTimers.clear();

        for (const [id] of this.running) {
            const ac = this.abortControllers.get(id);
            if (ac) ac.abort();
        }

        const deadline = Date.now() + timeoutMs;
        while (this.running.size > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }

        if (this.running.size > 0) {
            this.logger.warn(
                { remaining: this.running.size },
                'Shutdown timeout reached, force-clearing remaining jobs',
            );
            for (const [id, job] of this.running) {
                job.status = 'failed';
                job.error = 'Shut down before completion';
                job.completedAt = new Date().toISOString();
                this.clearTimer(id);
                this.abortControllers.delete(id);
                this.releaseConcurrency(job);
            }
            this.running.clear();
        }

        for (const [id] of this.timers) {
            clearTimeout(this.timers.get(id));
        }
        this.timers.clear();
    }

    executeNow(
        workflow: WorkflowDefinition,
        event: EventPayload,
        integrationConfigs: Record<string, IntegrationConfig>,
        ai: AIProviderRegistry | undefined,
        _signal?: AbortSignal,
    ): Promise<void> {
        return executeWorkflow(workflow, event, new Map(), this.logger, integrationConfigs, ai, _signal, undefined);
    }

    // ─── Internal: tick-based drain ──────────────────────────────────────

    private scheduleTick(): void {
        if (this.tickScheduled || this.shuttingDown) return;
        this.tickScheduled = true;
        setTimeout(() => {
            this.tickScheduled = false;
            this.tick();
        }, 0);
    }

    private tick(): void {
        if (this.shuttingDown || !this.executor || !this.executorContext) return;

        while (this.queue.length > 0) {
            if (this.concurrencyCount >= this.maxConcurrency) break;

            const job = this.queue[0];
            const sameWorkflowRunning = this.countRunningByWorkflow(job.workflow.name);
            if (sameWorkflowRunning >= job.resolvedConfig.concurrency) break;

            this.queue.shift();
            this.startJob(job);

            const { integrationConfigs, ai, recordWebhookDelivery } = this.executorContext;
            this.executor(job, integrationConfigs, ai, recordWebhookDelivery)
                .catch(() => {})
                .finally(() => this.onJobCompleted(job));
        }
    }

    private async startJob(job: QueueJob): Promise<void> {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        job.attempts++;

        this.running.set(job.id, job);
        this.concurrencyCount++;

        const ac = new AbortController();
        this.abortControllers.set(job.id, ac);

        if (job.resolvedConfig.timeout > 0) {
            const timer = setTimeout(() => {
                this.logger.warn({ jobId: job.id, timeout: job.resolvedConfig.timeout }, 'Job timed out');
                ac.abort();
            }, job.resolvedConfig.timeout * 1000);
            this.timers.set(job.id, timer);
        }

        this.notify(job);
        this.logger.info(
            { jobId: job.id, workflow: job.workflow.name, attempt: job.attempts },
            'Job started',
        );
    }

    private onJobCompleted(job: QueueJob): void {
        if (job.status === 'running') {
            job.status = 'completed';
        }

        job.completedAt = new Date().toISOString();
        this.clearTimer(job.id);
        this.abortControllers.delete(job.id);
        this.releaseConcurrency(job);
        this.running.delete(job.id);
        this.removeFromDedup(job);

        if (job.status === 'failed' && job.attempts < job.resolvedConfig.retry + 1) {
            this.scheduleRetry(job);
        } else {
            this.addToHistory(job);
            this.notify(job);
            this.logger.info(
                { jobId: job.id, workflow: job.workflow.name, status: job.status, durationMs: job.completedAt && job.startedAt ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime() : undefined },
                'Job finished',
            );
        }

        this.scheduleTick();
    }

    private scheduleRetry(job: QueueJob): void {
        const delay = job.resolvedConfig.retryDelay * 1000;
        this.logger.info(
            { jobId: job.id, attempt: job.attempts, maxRetries: job.resolvedConfig.retry, delayMs: delay },
            'Scheduling retry',
        );
        const timer = setTimeout(() => {
            this.retryTimers.delete(job.id);
            job.status = 'queued';
            job.error = undefined;
            job.completedAt = undefined;
            job.startedAt = undefined;
            this.insertByPriority(job);
            this.notify(job);
            this.scheduleTick();
        }, delay);
        this.retryTimers.set(job.id, timer);
    }

    // ─── Dedup ───────────────────────────────────────────────────────────

    private applyDedup(newJob: QueueJob): QueueJob | null {
        const key = newJob.dedupKey;
        if (!key) return null;

        const existingId = this.dedupMap.get(key);
        if (!existingId) return null;

        const existingQueued = this.queue.find((j) => j.id === existingId);
        if (existingQueued) {
            if (newJob.resolvedConfig.dedup === 'drop-duplicate') {
                const deduped: QueueJob = {
                    ...newJob,
                    id: newJob.id,
                    status: 'deduped',
                    completedAt: new Date().toISOString(),
                };
                this.addToHistory(deduped);
                this.logger.info(
                    { jobId: newJob.id, duplicateOf: existingId, dedupKey: key },
                    'Job dropped (duplicate)',
                );
                return deduped;
            }
            const idx = this.queue.indexOf(existingQueued);
            if (idx !== -1) this.queue.splice(idx, 1);
            existingQueued.status = 'deduped';
            existingQueued.completedAt = new Date().toISOString();
            this.addToHistory(existingQueued);
            this.logger.info(
                { oldJobId: existingId, newJobId: newJob.id, dedupKey: key },
                'Queued job replaced (latest-wins)',
            );
            return null;
        }

        const existingRunning = this.running.get(existingId);
        if (existingRunning) {
            if (newJob.resolvedConfig.dedup === 'drop-duplicate') {
                const deduped: QueueJob = {
                    ...newJob,
                    id: newJob.id,
                    status: 'deduped',
                    completedAt: new Date().toISOString(),
                };
                this.addToHistory(deduped);
                this.logger.info(
                    { jobId: newJob.id, duplicateOf: existingId, dedupKey: key },
                    'Job dropped (running duplicate)',
                );
                return deduped;
            }
            this.logger.info(
                { oldJobId: existingId, newJobId: newJob.id, dedupKey: key },
                'Running job will be superseded (latest-wins)',
            );
            return null;
        }

        this.dedupMap.delete(key);
        return null;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    private insertByPriority(job: QueueJob): void {
        const p = JOB_PRIORITY_ORDER[job.priority] ?? 2;
        let inserted = false;
        for (let i = 0; i < this.queue.length; i++) {
            const ep = JOB_PRIORITY_ORDER[this.queue[i].priority] ?? 2;
            if (p < ep) {
                this.queue.splice(i, 0, job);
                inserted = true;
                break;
            }
        }
        if (!inserted) this.queue.push(job);
        this.dedupMap.set(job.dedupKey, job.id);
    }

    private removeFromDedup(job: QueueJob): void {
        const current = this.dedupMap.get(job.dedupKey);
        if (current === job.id) {
            this.dedupMap.delete(job.dedupKey);
        }
    }

    private releaseConcurrency(_job: QueueJob): void {
        this.concurrencyCount = Math.max(0, this.concurrencyCount - 1);
    }

    private countRunningByWorkflow(workflowName: string): number {
        let count = 0;
        for (const job of this.running.values()) {
            if (job.workflow.name === workflowName) count++;
        }
        return count;
    }

    private clearTimer(jobId: string): void {
        const timer = this.timers.get(jobId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(jobId);
        }
    }

    private addToHistory(job: QueueJob): void {
        this.completed.unshift(job);
        if (this.completed.length > this.maxHistory) {
            this.completed.pop();
        }
    }

    private computeAvgDurationMs(): number | undefined {
        const finished = this.completed.filter(
            (j) => (j.status === 'completed' || j.status === 'failed') && j.startedAt && j.completedAt,
        );
        if (finished.length === 0) return undefined;
        const total = finished.reduce((sum, j) => {
            return sum + (new Date(j.completedAt!).getTime() - new Date(j.startedAt!).getTime());
        }, 0);
        return Math.round(total / finished.length);
    }

    private notify(job: QueueJob): void {
        for (const cb of this.jobUpdateCallbacks) {
            cb(job);
        }
    }
}

export interface QueueStats {
    totalEnqueued: number;
    availableSlots: number;
    byStatus: Record<string, number>;
    avgDurationMs?: number;
}
