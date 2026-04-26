import pino from 'pino';
import type { Logger } from 'pino';
import type {
    ActionHandler,
    EventHandler,
    EventPayload,
    Integration,
    QueueJob,
    WebhookDelivery,
    SokuzaConfig,
    WorkflowDefinition,
    WorkflowRunRecord,
} from './types.js';
import { matchesTrigger } from './workflow.js';
import { toArray } from './types.js';
import { createHash } from 'node:crypto';
import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import {
    clearRuntimeState,
    listenWithFallback,
    persistRuntimeState,
    pruneStaleRuntimeStates,
} from '../server/discovery.js';
import {
    loadOrCreateDashboardToken,
    registerAuthGate,
    registerHostGuard,
    DEFAULT_ALLOWED_HOSTS,
} from '../server/auth.js';
import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'node:path';
import { WorkflowQueue } from './queue.js';
import type { JobExecutor } from './queue.js';
import { resolveQueueConfig } from './queue-config.js';
import { ConfigStore } from './config-store.js';
import { executeWorkflow } from './workflow.js';
import { resetTemplateCache } from './templates.js';
import { LogStore } from './log-store.js';
import { ChatStore } from './chat-store.js';
import { WorkdirManager } from './workdir-store.js';
import pretty from 'pino-pretty';

const MAX_RECENT_EVENTS = 100;
const MAX_RUN_HISTORY = 200;
const MAX_WEBHOOK_DELIVERIES = 200;
const MAX_SEEN_DELIVERY_IDS = 1000;

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

    /** Path of this process's runtime state file, cleared on graceful stop. */
    private stateFile: string | null = null;

    // ─── Dashboard state ────────────────────────────────────────────────
    private recentEvents: Array<{ event: EventPayload; timestamp: string; matchedWorkflows: string[] }> = [];
    private eventSubscribers = new Set<(event: unknown) => void>();
    private configPath: string;
    private runHistory: WorkflowRunRecord[] = [];
    private webhookDeliveries: WebhookDelivery[] = [];
    private webhookDeliveryIdCounter = 0;
    private seenDeliveryIds = new Set<string>();
    private lastConfigHash: string = '';
    private runIdCounter = 0;
    private logStore: LogStore;
    private chatStore: ChatStore;
    private workdirManager: WorkdirManager;

    constructor(config: SokuzaConfig, configPath?: string) {
        this.config = config;
        this.configPath = resolve(configPath ?? 'sokuza.config.yaml');

        this.logStore = new LogStore();
        this.logger = pino(
            { level: 'info' },
            pino.multistream([
                { stream: pretty({ colorize: true }) },
                { stream: this.logStore },
            ]),
        );

        this.queue = new WorkflowQueue(this.logger);
        this.queue.setOnJobUpdate((job) => this.broadcastJobUpdate(job));
        this.configStore = new ConfigStore(this.configPath, this.logger);
        // One chat store instance per process — sessions live under
        // ~/.sokuza/chat-sessions/. Shared by every /api/chat/* handler
        // and by the chat agent itself (passed into runChatTurn).
        this.chatStore = new ChatStore(this.logger);
        // Persistent per-PR git workdirs for the auto address-review
        // action. Default root ~/.sokuza/auto-fix-workdirs/, configurable
        // via SOKUZA_WORKDIR_ROOT. Constructed before setExecutor so the
        // address-review action receives a live manager via ActionContext.
        this.workdirManager = new WorkdirManager(this.logger);
        this.queue.setExecutor(this.createJobExecutor(), {
            integrationConfigs: config.integrations,
            ai: config.ai,
            recordWebhookDelivery: (d) => this.recordWebhookDelivery(d),
            workdirManager: this.workdirManager,
        });
    }

    /** Accessor for the shared chat store (API handlers, chat-agent). */
    getChatStore(): ChatStore {
        return this.chatStore;
    }

    /** Accessor for the workdir manager (API handlers, address-review action). */
    getWorkdirManager(): WorkdirManager {
        return this.workdirManager;
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

    private async evictWorkdirOnPrClose(event: EventPayload): Promise<void> {
        const meta = event.metadata ?? {};
        const repoStr = meta.repo as string | undefined;
        const prNumber = (meta.prNumber ?? (event.payload?.pull_request as Record<string, unknown> | undefined)?.number) as number | undefined;
        if (!repoStr || typeof prNumber !== 'number') return;
        const [owner, repo] = repoStr.split('/');
        if (!owner || !repo) return;
        try {
            const evicted = await this.workdirManager.evict(owner, repo, prNumber);
            if (evicted) {
                this.logger.info({ owner, repo, prNumber }, 'Evicted workdir on PR close');
            }
        } catch (err) {
            // Live-locked: an address-review run is in flight. Let it finish;
            // future eviction can come from the idle sweep.
            this.logger.debug({ err, owner, repo, prNumber }, 'Skipping workdir eviction (locked)');
        }
    }

    /** Register a workflow action handler */
    registerAction(name: string, handler: ActionHandler): void {
        this.actions.set(name, handler);
        this.logger.info({ action: name }, 'Registered action');
    }

    /** Handle an incoming event — match against workflows and enqueue */
    private handleEvent: EventHandler = async (event: EventPayload) => {
        const deliveryId = event.metadata?.deliveryId as string | undefined;
        if (deliveryId) {
            if (this.seenDeliveryIds.has(deliveryId)) {
                this.logger.info(
                    { deliveryId, source: event.source, event: event.event },
                    'Deduplicating event — delivery ID already seen',
                );
                return;
            }
            this.seenDeliveryIds.add(deliveryId);
            if (this.seenDeliveryIds.size > MAX_SEEN_DELIVERY_IDS) {
                const iter = this.seenDeliveryIds.values();
                for (let i = 0; i < MAX_SEEN_DELIVERY_IDS / 2; i++) {
                    const val = iter.next().value;
                    if (val !== undefined) this.seenDeliveryIds.delete(val);
                }
            }
        }

        this.logger.info(
            { source: event.source, event: event.event, action: event.action },
            'Received event',
        );

        // Engine-level housekeeping: a closed/merged PR has no future
        // address-review iterations, so the cached workdir is dead weight.
        // Done before workflow matching so the cleanup happens regardless
        // of whether any user workflow listens for this event.
        if (event.event === 'pull_request' && (event.action === 'closed' || event.action === 'merged')) {
            this.evictWorkdirOnPrClose(event).catch((err) =>
                this.logger.warn({ err }, 'Workdir eviction on PR close failed'),
            );
        }

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
            job.configHash = this.getConfigHash();
        }
    };

    /** Run a specific workflow by name with manual inputs */
    async runWorkflowByName(
        workflowName: string,
        inputs: Record<string, unknown> = {},
    ): Promise<{ ok: boolean; error?: string; runId?: string; output?: QueueJob['output'] }> {
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
        job.configHash = this.getConfigHash();

        if (job.status === 'deduped') {
            runRecord.status = 'success';
            runRecord.durationMs = 0;
            return { ok: true, runId };
        }

        try {
            await this.waitForJob(job);
            runRecord.status = 'success';
            runRecord.durationMs = Date.now() - startTime;
        } catch (err: any) {
            runRecord.status = 'error';
            runRecord.durationMs = Date.now() - startTime;
            runRecord.error = err.message ?? 'Workflow execution failed';
            return { ok: false, error: runRecord.error, runId };
        }
        return { ok: true, runId, output: job.output };
    }

    /** Reload config from disk — workflows, AI, queue, integrations.
     *  Public so API handlers can trigger a refresh after writing the config. */
    async reloadConfig(): Promise<void> {
        try {
            resetTemplateCache();
            const reloaded = await this.configStore.reloadAndNormalize();
            if (reloaded.workflows) {
                this.config.workflows = reloaded.workflows;
                this.lastConfigHash = '';
            }
            if (reloaded.ai) this.config.ai = reloaded.ai;
            if (reloaded.queue) this.config.queue = reloaded.queue;
            if (reloaded.integrations) this.config.integrations = reloaded.integrations;
            this.queue.setExecutor(this.createJobExecutor(), {
                integrationConfigs: this.config.integrations,
                ai: this.config.ai,
                recordWebhookDelivery: (d) => this.recordWebhookDelivery(d),
                workdirManager: this.workdirManager,
                getConfig: () => this.config,
            });
        } catch {
            // Keep existing config on read failure
        }
    }

    /** Get current config */
    getConfig(): SokuzaConfig {
        return this.config;
    }

    private getConfigHash(): string {
        if (!this.lastConfigHash) {
            const yaml = JSON.stringify(this.config.workflows.map(w => w.name));
            this.lastConfigHash = createHash('sha256').update(yaml).digest('hex').slice(0, 12);
        }
        return this.lastConfigHash;
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

    /** Replay a stored event by index (bypasses delivery ID dedup) */
    replayEvent(eventIndex: number): { ok: boolean; error?: string } {
        if (eventIndex < 0 || eventIndex >= this.recentEvents.length) {
            return { ok: false, error: `Event index ${eventIndex} out of range` };
        }

        const { event } = this.recentEvents[eventIndex];
        const replayEvent: EventPayload = {
            ...event,
            metadata: { ...event.metadata, deliveryId: `replay_${Date.now()}` },
        };

        this.handleEvent(replayEvent).catch(() => {});
        return { ok: true };
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

    /** Get recent webhook deliveries */
    getWebhookDeliveries(workflowName?: string): WebhookDelivery[] {
        if (workflowName) {
            return this.webhookDeliveries.filter((d) => d.workflowName === workflowName);
        }
        return [...this.webhookDeliveries];
    }

    private recordWebhookDelivery(delivery: Omit<WebhookDelivery, 'id' | 'timestamp'>): void {
        const record: WebhookDelivery = {
            ...delivery,
            id: `wh_${Date.now()}_${++this.webhookDeliveryIdCounter}`,
            timestamp: new Date().toISOString(),
        };
        this.webhookDeliveries.unshift(record);
        if (this.webhookDeliveries.length > MAX_WEBHOOK_DELIVERIES) {
            this.webhookDeliveries.pop();
        }
    }

    /** Preview which workflows match an event without running them */
    previewEvent(event: EventPayload): { matched: string[]; unmatched: Array<{ name: string; reason: string }> } {
        const matched: string[] = [];
        const unmatched: Array<{ name: string; reason: string }> = [];

        for (const wf of this.config.workflows) {
            if (wf.enabled === false) {
                unmatched.push({ name: wf.name, reason: 'workflow is disabled' });
                continue;
            }

            const triggerSources = toArray(wf.trigger.source);
            if (!triggerSources.includes(event.source)) {
                unmatched.push({ name: wf.name, reason: `source mismatch: workflow expects [${triggerSources.join(', ')}], got "${event.source}"` });
                continue;
            }

            const triggerEvents = toArray(wf.trigger.event);
            if (event.source !== 'manual' && !triggerEvents.includes(event.event)) {
                unmatched.push({ name: wf.name, reason: `event mismatch: workflow expects [${triggerEvents.join(', ')}], got "${event.event}"` });
                continue;
            }

            if (matchesTrigger(wf, event)) {
                matched.push(wf.name);
            } else {
                unmatched.push({ name: wf.name, reason: 'filter or shorthand conditions not met' });
            }
        }

        return { matched, unmatched };
    }

    /** Boot the engine: initialize integrations, start the HTTP server */
    async start(): Promise<void> {
        this.logger.info('Starting Sokuza engine...');

        for (const [name, integration] of this.integrations) {
            const config = this.config.integrations[name];
            if (config) {
                const childLogger = this.logger.child({ integration: name });
                await integration.initialize(config, childLogger);
                this.logger.info({ integration: name }, 'Integration initialized');
            }
        }

        this.server = createServer(this.logger);

        // DNS-rebinding guard. Reject requests whose Host header isn't a
        // loopback name we explicitly accept. Defense-in-depth alongside the
        // bearer token: even if a remote site convinces a browser to issue
        // requests to 127.0.0.1, the browser sends the attacker's hostname
        // in Host — which won't match. Registered BEFORE the auth gate so
        // the host check fires first; /health and /webhooks/* are exempt
        // (the same paths the auth gate exempts) so discovery still works.
        const configuredHost = this.config.server.host;
        const allowedHosts = [
            ...DEFAULT_ALLOWED_HOSTS,
            ...(configuredHost && configuredHost !== '0.0.0.0' && configuredHost !== '::'
                ? [configuredHost]
                : []),
            ...(process.env.SOKUZA_ALLOWED_HOSTS ?? '')
                .split(',')
                .map((h) => h.trim())
                .filter(Boolean),
        ];
        registerHostGuard(this.server, allowedHosts, this.logger);

        // Gate /api/* behind a bearer token. The dashboard HTML itself still
        // loads without auth so its JS can prompt the user for the token.
        const dashboardToken = await loadOrCreateDashboardToken();
        registerAuthGate(this.server, dashboardToken, this.logger);

        const templateDir = join(resolve(this.configPath, '..'), 'templates');
        registerApiRoutes(this.server, {
            logger: this.logger,
            logStore: this.logStore,
            configStore: this.configStore,
            getTemplateDir: () => templateDir,
            getIntegrationStatus: () => this.getIntegrationStatus(),
            getRecentEvents: () => [...this.recentEvents],
            addEventSubscriber: (cb) => {
                this.eventSubscribers.add(cb);
                return () => this.eventSubscribers.delete(cb);
            },
            broadcastEvent: (payload) => {
                for (const cb of this.eventSubscribers) cb(payload);
            },
            getRegisteredActions: () => [...this.actions.keys()],
            runWorkflow: (name, inputs) => this.runWorkflowByName(name, inputs),
            rerunWorkflow: (runId) => this.rerunWorkflow(runId),
            replayEvent: (idx) => this.replayEvent(idx),
            getRunHistory: (name?) => this.getRunHistory(name),
            getConfig: () => this.getConfig(),
            getQueue: () => this.queue,
            previewEvent: (event) => this.previewEvent(event),
            getWebhookDeliveries: (name?) => this.getWebhookDeliveries(name),
            reloadConfig: () => this.reloadConfig(),
            getEngine: () => this,
            getChatStore: () => this.chatStore,
            getWorkdirManager: () => this.workdirManager,
        });

        for (const integration of this.integrations.values()) {
            integration.registerRoutes(this.server, this.handleEvent);
        }

        this.startCronSchedules();

        const { port: preferredPort } = this.config.server;
        const host = this.config.server.host ?? '127.0.0.1';
        const actualPort = await listenWithFallback(
            this.server, host, preferredPort, this.logger,
        );
        this.config.server.port = actualPort;

        // Clean up state files left by previous processes that crashed.
        // Never load-bearing — it's housekeeping, failures are non-fatal.
        await pruneStaleRuntimeStates(this.logger).catch(() => 0);

        // Reclaim any auto-fix workdir locks left by crashed prior runs.
        // Inline rather than background: the cost is bounded by the number
        // of cached workdirs (typically <100); a wedged workdir would
        // otherwise block the next address-review run for that PR.
        try {
            const reclaimed = await this.workdirManager.recoverStaleLocks();
            if (reclaimed > 0) {
                this.logger.info({ reclaimed }, 'Recovered stale workdir locks');
            }
        } catch (err) {
            this.logger.warn({ err }, 'Workdir lock recovery failed; continuing');
        }

        // State persistence is best-effort: a read-only home dir should not
        // prevent the server from running, only from being auto-discoverable.
        try {
            this.stateFile = await persistRuntimeState(actualPort, host);
        } catch (err) {
            this.logger.warn(
                { err: (err as Error).message },
                'Could not write runtime state file — `sokuza status` and diagnostics won\'t see this process',
            );
        }

        const localUrl = `http://localhost:${actualPort}`;
        const dashboardUrl = `${localUrl}/?t=${dashboardToken}`;
        this.logger.info(
            { port: actualPort, host, url: localUrl, state: this.stateFile },
            `🚀 Sokuza is listening at ${localUrl}`,
        );
        this.logger.info(
            `🔐 Dashboard (one-time link): ${dashboardUrl}`,
        );
        this.logger.info(
            `   Reveal again any time with \`sokuza token\`.`,
        );
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

        // Best-effort cleanup of our own state file so `listRuntimeStates`
        // doesn't report this pid after it exits.
        if (this.stateFile) {
            try { await clearRuntimeState(this.stateFile); } catch { /* ignored */ }
            this.stateFile = null;
        }
    }

    // ─── Queue processing ────────────────────────────────────────────────

    private createJobExecutor(): JobExecutor {
        const actions = this.actions;
        const logger = this.logger;
        return async (job, integrationConfigs, ai, recordWebhookDelivery, workdirManager, getConfig) => {
            try {
                const output = await executeWorkflow(
                    job.workflow, job.event, actions, logger,
                    integrationConfigs, ai, undefined, recordWebhookDelivery,
                    { workdirManager, getConfig },
                );
                // Attach step results so chat tools and run-history UI can
                // surface the workflow's actual output — not just success/fail.
                job.output = output;
                if (job.status === 'running') {
                    job.status = 'completed';
                }
            } catch (err: any) {
                if (job.status !== 'cancelled') {
                    job.status = 'failed';
                    job.error = err.message ?? 'Workflow execution failed';
                }
            }
        };
    }

    private waitForJob(job: QueueJob): Promise<void> {
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
