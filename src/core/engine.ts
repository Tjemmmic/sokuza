import pino from 'pino';
import type { Logger } from 'pino';
import type {
    ActionHandler,
    EventHandler,
    EventPayload,
    Integration,
    SokuzaConfig,
    WorkflowDefinition,
    WorkflowRunRecord,
} from './types.js';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { executeWorkflow, matchesTrigger } from './workflow.js';
import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'node:path';

const MAX_RECENT_EVENTS = 100;
const MAX_RUN_HISTORY = 200;

export class SokuzaEngine {
    private integrations = new Map<string, Integration>();
    private actions = new Map<string, ActionHandler>();
    private server: FastifyInstance | null = null;
    readonly logger: Logger;
    private config: SokuzaConfig;

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
    }

    /** Register an integration plugin and its actions */
    registerIntegration(integration: Integration): void {
        this.integrations.set(integration.name, integration);

        // Auto-register integration-owned actions
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

    /** Handle an incoming event — match against workflows and execute */
    private handleEvent: EventHandler = async (event: EventPayload) => {
        this.logger.info(
            { source: event.source, event: event.event, action: event.action },
            'Received event',
        );

        const matchedWorkflows = this.config.workflows.filter((wf) =>
            matchesTrigger(wf, event),
        );

        // Track for dashboard
        const entry = {
            event,
            timestamp: new Date().toISOString(),
            matchedWorkflows: matchedWorkflows.map((wf) => wf.name),
        };
        this.recentEvents.unshift(entry);
        if (this.recentEvents.length > MAX_RECENT_EVENTS) {
            this.recentEvents.pop();
        }
        // Notify SSE subscribers
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
            'Matched workflows, executing',
        );

        // Run matched workflows concurrently
        await Promise.allSettled(
            matchedWorkflows.map((wf) =>
                executeWorkflow(wf, event, this.actions, this.logger, this.config.integrations),
            ),
        );
    };

    /** Run a specific workflow by name with manual inputs */
    async runWorkflowByName(
        workflowName: string,
        inputs: Record<string, unknown> = {},
    ): Promise<{ ok: boolean; error?: string; runId?: string }> {
        // Re-read config to get latest workflows
        await this.reloadConfig();

        const workflow = this.config.workflows.find((wf) => wf.name === workflowName);
        if (!workflow) {
            return { ok: false, error: `Workflow "${workflowName}" not found` };
        }

        // ─── Create run record ───────────────────────────────────────────
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

        // Construct a manual EventPayload
        const triggerEvents = Array.isArray(workflow.trigger.event) ? workflow.trigger.event : [workflow.trigger.event];
        const triggerRepos = workflow.trigger.repo
            ? (Array.isArray(workflow.trigger.repo) ? workflow.trigger.repo : [workflow.trigger.repo])
            : [];

        // ─── Enrich payload from smart picker inputs ─────────────────────
        // When users select a PR/issue via picker, the value is a rich object.
        // We synthesize webhook-shaped payload fields so actions work unchanged.
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
                // Synthesize pull_request shape for actions
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
                payload.action = 'opened'; // Actions expect this
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

        // Execute the target workflow directly (not via handleEvent broadcast)
        // This ensures only the specific workflow runs, not all workflows
        const entry = {
            event,
            timestamp: new Date().toISOString(),
            matchedWorkflows: [workflowName],
        };
        this.recentEvents.unshift(entry);
        if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.pop();
        for (const cb of this.eventSubscribers) cb(entry);

        this.logger.info({ source: event.source, action: event.action }, 'Received event');

        try {
            await executeWorkflow(workflow, event, this.actions, this.logger, this.config.integrations);
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

            // Interpolate env vars, same as loadConfig does
            const interpolated = raw.replace(
                /\$\{([A-Z_][A-Z0-9_]*)\}/g,
                (_match, varName: string) => process.env[varName] ?? '',
            );
            const parsed = yaml.load(interpolated) as SokuzaConfig;

            if (parsed?.workflows && Array.isArray(parsed.workflows)) {
                // Normalize: expand templates + resolve shorthands (same as loadConfig)
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

    /** Boot the engine: initialize integrations, start the HTTP server */
    async start(): Promise<void> {
        this.logger.info('Starting Sokuza engine...');

        // Initialize each configured integration
        for (const [name, integration] of this.integrations) {
            const config = this.config.integrations[name];
            if (config) {
                await integration.initialize(config);
                this.logger.info({ integration: name }, 'Integration initialized');
            }
        }

        // Create and configure the server
        this.server = createServer(this.logger);

        // Mount dashboard API routes
        const templateDir = join(resolve(this.configPath, '..'), 'templates');
        registerApiRoutes(this.server, {
            logger: this.logger,
            getConfigPath: () => this.configPath,
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
        });

        // Mount integration webhook routes
        for (const integration of this.integrations.values()) {
            integration.registerRoutes(this.server, this.handleEvent);
        }

        // Start listening
        const { port, host } = this.config.server;
        await this.server.listen({ port, host: host ?? '0.0.0.0' });
        this.logger.info({ port, host }, '🚀 Sokuza is listening');
    }

    /** Graceful shutdown */
    async stop(): Promise<void> {
        this.logger.info('Shutting down Sokuza engine...');
        if (this.server) {
            await this.server.close();
        }
    }
}
