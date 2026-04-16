import pino from 'pino';
import type { Logger } from 'pino';
import type {
    ActionHandler,
    EventHandler,
    EventPayload,
    Integration,
    QueueJob,
    SokuzaConfig,
    WorkflowDefinition,
    WorkflowRunRecord,
} from './types.js';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { matchesTrigger } from './workflow.js';
import { toArray } from './types.js';
import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'node:path';
import { WorkflowQueue } from './queue.js';
import { resolveQueueConfig } from './queue-config.js';
import { ConfigStore } from './config-store.js';

const MAX_RECENT_EVENTS = 100;
const MAX_RUN_HISTORY = 200;

export class SokuzaEngine {
    private integrations = new Map<string, Integration>();
    private actions = new Map<string, ActionHandler>();
    private server: FastifyInstance | null = null;
    readonly logger: Logger;
    private config: SokuzaConfig;

    // ─── Queue ────────────────────────────────────────────────────────────
    private queue: WorkflowQueue;

    // ─── Config store ────────────────────────────────────────────────────
    private configStore: ConfigStore;

    // ─── Dashboard state ────────────────────────────────────────────────
    private recentEvents: Array<{ event: EventPayload; timestamp: string; matchedWorkflows: string[] }> = [];
    private eventSubscribers = new Set<(event: unknown) => void>();
    private configPath: string;
    private runHistory: WorkflowRunRecord[] = [];
    private runIdCounter = 0;

    constructor(config: SokuzaConfig, configPath?: string) {
        this.config = config;
        this.configPath = resolve(configPath ?? 'sokuza.config.yaml');
        this.logger = pino({
            level: 'info',
            transport: {
                target: 'pino-pretty',
                options: { colorize: true },
            },
        });

        this.queue = new WorkflowQueue(this.logger);
        this.queue.setOnJobUpdate((job) => this.broadcastJobUpdate(job));
        this.configStore = new ConfigStore(this.configPath, this.logger);
    }

    /** Register an integration plugin and its actions */
    registerIntegration(integration: Integration): void {
        this.integrations.set(integration.name, integration);

        if (integration.actions) {
            for (const [name, handler] of Object.entries(integration.actions)) {
                this.actions.set(name, handler);
            }
        }

        this.logger.info(
            { integration: integration.name, events: integration.supportedEvents },
            'Registered integration',
        );
    }

    /** Register a workflow action handler */
    registerAction(name: string, handler: ActionHandler): void {
        this.actions.set(name, handler);
        this.logger.info({ action: name }, 'Registered action');
    }

    /** Handle an incoming event — match against workflows and enqueue */
    private handleEvent: EventHandler = async (event: EventPayload) => {
        this.logger.info(
            { source: event.source, event: event.event, action: event.action },
            'Received event',
        );

        const matchedWorkflows = this.config.workflows.filter((wf) =>
            matchesTrigger(wf, event),
        );

        const entry = {
            event,
            timestamp: new Date().toISOString(),
            matchedWorkflows: matchedWorkflows.map((wf) => wf.name),
        };
        this.recentEvents.unshift(entry);
        if (this.recentEvents.length > MAX_RECENT_EVENTS) {
            this.recentEvents.pop();
        }
        for (const cb of this.eventSubscribers) {
            cb(entry);
        }

        if (matchedWorkflows.length === 0) {
            this.logger.debug(
                { source: event.source, event: event.event },
                'No workflows matched',
            );
            return;
        }

        this.logger.info(
            { count: matchedWorkflows.length },
            'Matched workflows, enqueuing',
        );

        for (const wf of matchedWorkflows) {
            const resolvedConfig = resolveQueueConfig(wf, event, this.config.queue, this.config.ai);
            const job = this.queue.enqueue(wf, event, resolvedConfig);
            this.processQueueJob(job);
        }
    };

    /** Run a specific workflow by name with manual inputs */
    async runWorkflowByName(
        workflowName: string,
        inputs: Record<string, unknown> = {},
    ): Promise<{ ok: boolean; error?: string; runId?: string }> {
        await this.reloadConfig();

        const workflow = this.config.workflows.find((wf) => wf.name === workflowName);
        if (!workflow) {
            return { ok: false, error: `Workflow "${workflowName}" not found` };
        }

        const runId = `run_${Date.now()}_${++this.runIdCounter}`;
        const runRecord: WorkflowRunRecord = {
            id: runId,
            workflowName,
            inputs: structuredClone(inputs),
            timestamp: new Date().toISOString(),
            status: 'running',
        };
        this.runHistory.unshift(runRecord);
        if (this.runHistory.length > MAX_RUN_HISTORY) this.runHistory.pop();

        const startTime = Date.now();

        const triggerEvents = Array.isArray(workflow.trigger.event) ? workflow.trigger.event : [workflow.trigger.event];
        const triggerRepos = workflow.trigger.repo
            ? (Array.isArray(workflow.trigger.repo) ? workflow.trigger.repo : [workflow.trigger.repo])
            : [];

        const payload: Record<string, unknown> = { inputs };
        const metadata: Record<string, unknown> = {
            triggeredBy: 'dashboard',
            workflowName,
            ...(triggerRepos.length > 0 ? { repo: triggerRepos[0] } : {}),
        };

        const inputDefs = workflow.inputs ?? [];
        for (const def of inputDefs) {
            const val = inputs[def.name];
            if (!val || typeof val !== 'object') continue;
            const obj = val as Record<string, unknown>;

            if (def.type === 'github-pr' && obj.number) {
                const repoStr = (obj.repo as string) ?? triggerRepos[0] ?? '';
                const [owner, repoName] = repoStr.split('/');
                payload.pull_request = {
                    number: obj.number,
                    title: obj.title,
                    state: obj.state,
                    user: { login: obj.author },
                    head: obj.head ?? {},
                    base: obj.base ?? {},
                    labels: ((obj.labels as string[]) ?? []).map((n: string) => ({ name: n })),
                    draft: obj.draft,
                };
                payload.action = 'opened';
                metadata.repo = repoStr;
                metadata.owner = owner;
                metadata.repoName = repoName;
                metadata.prNumber = obj.number;
            } else if (def.type === 'github-issue' && obj.number) {
                const repoStr = (obj.repo as string) ?? triggerRepos[0] ?? '';
                const [owner, repoName] = repoStr.split('/');
                payload.issue = {
                    number: obj.number,
                    title: obj.title,
                    state: obj.state,
                    user: { login: obj.author },
                    labels: ((obj.labels as string[]) ?? []).map((n: string) => ({ name: n })),
                };
                payload.action = 'opened';
                metadata.repo = repoStr;
                metadata.owner = owner;
                metadata.repoName = repoName;
                metadata.issueNumber = obj.number;
            }
        }

        const event: EventPayload = {
            source: 'manual',
            event: triggerEvents[0],
            action: payload.action as string | undefined,
            timestamp: new Date().toISOString(),
            payload,
            metadata,
        };

        const entry = {
            event,
            timestamp: new Date().toISOString(),
            matchedWorkflows: [workflowName],
        };
        this.recentEvents.unshift(entry);
        if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.pop();
        for (const cb of this.eventSubscribers) cb(entry);

        this.logger.info({ source: event.source, action: event.action }, 'Received event');

        const resolvedConfig = resolveQueueConfig(workflow, event, this.config.queue, this.config.ai);
        resolvedConfig.priority = 'high';

        const job = this.queue.enqueue(workflow, event, resolvedConfig);

        try {
            await this.processQueueJobAndWait(job);
            runRecord.status = 'success';
            runRecord.durationMs = Date.now() - startTime;
        } catch (err: any) {
            runRecord.status = 'error';
            runRecord.durationMs = Date.now() - startTime;
            runRecord.error = err.message ?? 'Workflow execution failed';
            return { ok: false, error: runRecord.error, runId };
        }
        return { ok: true, runId };
    }

    /** Reload config from disk */
    private async reloadConfig(): Promise<void> {
        try {
            const raw = await readFile(this.configPath, 'utf-8');

            const interpolated = raw.replace(
                /\$\{([A-Z_][A-Z0-9_]*)\}/g,
                (_match, varName: string) => process.env[varName] ?? '',
            );
            const parsed = yaml.load(interpolated) as SokuzaConfig;

            if (parsed?.workflows && Array.isArray(parsed.workflows)) {
                const { normalizeWorkflow } = await import('./templates.js');
                const normalized = await Promise.all(
                    parsed.workflows.map((wf: unknown) =>
                        normalizeWorkflow(wf as Record<string, unknown>),
                    ),
                );
                this.config.workflows = normalized;
            }
        } catch {
            // Keep existing config on read failure
        }
    }

    /** Get current config */
    getConfig(): SokuzaConfig {
        return this.config;
    }

    /** Get run history, optionally filtered by workflow name */
    getRunHistory(workflowName?: string): WorkflowRunRecord[] {
        if (workflowName) {
            return this.runHistory.filter((r) => r.workflowName === workflowName);
        }
        return [...this.runHistory];
    }

    /** Rerun a previous workflow execution by run ID */
    async rerunWorkflow(runId: string): Promise<{ ok: boolean; error?: string; runId?: string }> {
        const originalRun = this.runHistory.find((r) => r.id === runId);
        if (!originalRun) {
            return { ok: false, error: `Run "${runId}" not found` };
        }
        return this.runWorkflowByName(originalRun.workflowName, originalRun.inputs);
    }

    /** Get integration status for the dashboard */
    getIntegrationStatus(): Record<string, { enabled: boolean; events: string[] }> {
        const status: Record<string, { enabled: boolean; events: string[] }> = {};
        for (const [name, integration] of this.integrations) {
            status[name] = {
                enabled: !!this.config.integrations[name],
                events: [...integration.supportedEvents],
            };
        }
        return status;
    }

    /** Get the queue instance (for API access) */
    getQueue(): WorkflowQueue {
        return this.queue;
    }

    /** Boot the engine: initialize integrations, start the HTTP server */
    async start(): Promise<void> {
        this.logger.info('Starting Sokuza engine...');

        for (const [name, integration] of this.integrations) {
            const config = this.config.integrations[name];
            if (config) {
                await integration.initialize(config);
                this.logger.info({ integration: name }, 'Integration initialized');
            }
        }

        this.server = createServer(this.logger);

        const templateDir = join(resolve(this.configPath, '..'), 'templates');
        registerApiRoutes(this.server, {
            logger: this.logger,
            configStore: this.configStore,
            getTemplateDir: () => templateDir,
            getIntegrationStatus: () => this.getIntegrationStatus(),
            getRecentEvents: () => [...this.recentEvents],
            addEventSubscriber: (cb) => {
                this.eventSubscribers.add(cb);
                return () => this.eventSubscribers.delete(cb);
            },
            getRegisteredActions: () => [...this.actions.keys()],
            runWorkflow: (name, inputs) => this.runWorkflowByName(name, inputs),
            rerunWorkflow: (runId) => this.rerunWorkflow(runId),
            getRunHistory: (name?) => this.getRunHistory(name),
            getConfig: () => this.getConfig(),
            getQueue: () => this.queue,
        });

        for (const integration of this.integrations.values()) {
            integration.registerRoutes(this.server, this.handleEvent);
        }

        this.startCronSchedules();

        const { port, host } = this.config.server;
        await this.server.listen({ port, host: host ?? '0.0.0.0' });
        this.logger.info({ port, host }, '🚀 Sokuza is listening');
    }

    /** Graceful shutdown */
    async stop(): Promise<void> {
        this.logger.info('Shutting down Sokuza engine...');

        this.stopCronSchedules();
        this.stopPollingIntegrations();

        await this.queue.shutdown();
        if (this.server) {
            await this.server.close();
        }
    }

    // ─── Queue processing ────────────────────────────────────────────────

    private async processQueueJob(job: QueueJob): Promise<void> {
        if (job.status === 'deduped') return;

        try {
            await this.queue.runJob(
                job,
                this.actions,
                this.config.integrations,
                this.config.ai,
            );
        } catch {
            // runJob handles errors internally via job status
        }
    }

    private processQueueJobAndWait(job: QueueJob): Promise<void> {
        if (job.status === 'deduped') {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const unsubscribe = this.queue.onJobUpdate((updatedJob: QueueJob) => {
                if (updatedJob.id !== job.id) return;
                if (updatedJob.status === 'completed') {
                    if (settled) return;
                    settled = true;
                    unsubscribe();
                    resolve();
                } else if (updatedJob.status === 'failed' || updatedJob.status === 'cancelled') {
                    if (settled) return;
                    settled = true;
                    unsubscribe();
                    reject(new Error(updatedJob.error ?? 'Job failed'));
                }
            });

            this.processQueueJob(job).catch((err) => {
                if (settled) return;
                settled = true;
                unsubscribe();
                reject(err);
            });
        });
    }

    private broadcastJobUpdate(job: QueueJob): void {
        for (const cb of this.eventSubscribers) {
            cb({
                type: 'queue-update',
                job: {
                    id: job.id,
                    workflowName: job.workflow.name,
                    status: job.status,
                    priority: job.priority,
                    dedupKey: job.dedupKey,
                    error: job.error,
                    enqueuedAt: job.enqueuedAt,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                },
                timestamp: new Date().toISOString(),
            });
        }
    }

    // ─── Cron scheduling ─────────────────────────────────────────────────

    private startCronSchedules(): void {
        const cronIntegration = this.integrations.get('cron');
        if (!cronIntegration) return;

        const cronEvents = new Set<string>();
        for (const wf of this.config.workflows) {
            const sources = toArray(wf.trigger.source);
            if (!sources.includes('cron')) continue;

            const events = toArray(wf.trigger.event);
            for (const evt of events) {
                cronEvents.add(evt);
            }
        }

        if (!('startSchedule' in cronIntegration)) return;

        for (const eventName of cronEvents) {
            (cronIntegration as any).startSchedule(eventName);
            this.logger.info({ schedule: eventName }, 'Cron schedule started');
        }
    }

    private stopCronSchedules(): void {
        const cronIntegration = this.integrations.get('cron');
        if (!cronIntegration) return;
        if ('stopAll' in cronIntegration && typeof (cronIntegration as any).stopAll === 'function') {
            (cronIntegration as any).stopAll();
        }
    }

    // ─── Polling integration shutdown ────────────────────────────────────

    private stopPollingIntegrations(): void {
        for (const integration of this.integrations.values()) {
            if ('stopPolling' in integration && typeof (integration as any).stopPolling === 'function') {
                (integration as any).stopPolling();
            }
            if ('stop' in integration && typeof (integration as any).stop === 'function' && integration.name !== 'cron') {
                (integration as any).stop();
            }
        }
    }
}
