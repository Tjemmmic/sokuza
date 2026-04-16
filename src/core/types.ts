// ─── Core Types ─────────────────────────────────────────────────────────────

/** Top-level config loaded from sokuza.config.yaml */
export interface SokuzaConfig {
    server: ServerConfig;
    integrations: Record<string, IntegrationConfig>;
    workflows: WorkflowDefinition[];
    /** AI provider registry (see src/core/ai-providers.ts). */
    ai?: import('./ai-providers.js').AIProviderRegistry;
    /** Queue configuration for concurrency, dedup, priority, and timeouts. */
    queue?: QueueConfig;
}

export interface ServerConfig {
    port: number;
    host?: string;
}

/** Opaque per-integration config — each integration validates its own shape */
export interface IntegrationConfig {
    [key: string]: unknown;
}

// ─── Events ─────────────────────────────────────────────────────────────────

/** Canonical event emitted by an integration */
export interface EventPayload {
    /** Integration that produced the event, e.g. "github" */
    source: string;
    /** Dot-delimited event name, e.g. "issues.opened" */
    event: string;
    /** Sub-action if applicable (GitHub uses this) */
    action?: string;
    /** ISO-8601 timestamp */
    timestamp: string;
    /** Raw payload from the external service */
    payload: Record<string, unknown>;
    /** Additional metadata (repo, channel, etc.) */
    metadata: Record<string, unknown>;
}

// ─── Integrations ───────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface Integration {
    /** Unique name, e.g. "github" */
    readonly name: string;
    /** List of event names this integration can emit */
    readonly supportedEvents: string[];
    /** Actions provided by this integration (auto-registered by the engine) */
    readonly actions?: Record<string, ActionHandler>;
    /** One-time setup with user-provided config */
    initialize(config: IntegrationConfig): Promise<void>;
    /** Mount webhook / listener routes on the server */
    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void;
    /** Parse an inbound request into a canonical EventPayload */
    parseEvent(request: FastifyRequest): EventPayload;
}

export type EventHandler = (event: EventPayload) => Promise<void>;

// ─── Utility Types ──────────────────────────────────────────────────────────

/** Accept a single value or an array — normalised to array at runtime */
export type OneOrMany<T> = T | T[];

/** Normalise a OneOrMany to a flat array */
export function toArray<T>(value: OneOrMany<T> | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

// ─── Workflows ──────────────────────────────────────────────────────────────

export interface AIStepConfig {
    /** Registered provider name, e.g. "claude-code", "opencode", "anthropic". */
    provider?: string;
    /** Model override, e.g. "opus", "sonnet", "glm-4.6". */
    model?: string;
}

export interface WorkflowDefinition {
    name: string;
    /** Human-readable description of what this workflow does */
    description?: string;
    /** Whether this workflow is active (default: true) */
    enabled?: boolean;
    /** Use a built-in template instead of defining steps (e.g. "ai-pr-review") */
    template?: string;
    trigger: TriggerDefinition;
    steps: WorkflowStepDefinition[];
    /** Input definitions for manual triggers — the dashboard renders a form from these */
    inputs?: WorkflowInput[];
    /** Inline queue overrides for this workflow (highest priority). */
    queue?: Partial<QueueSettings>;
    /** Workflow-level AI config — default provider/model for all steps. */
    ai?: AIStepConfig;
}

/** Defines a user-facing input field for manual workflow triggers */
export interface WorkflowInput {
    /** Machine name used in template expressions: {{event.payload.inputs.name}} */
    name: string;
    /** Human-readable label shown in the dashboard */
    label: string;
    /** Field type — includes GitHub-aware pickers for smart selection */
    type: 'text' | 'textarea' | 'select' | 'number' | 'boolean'
        | 'github-pr' | 'github-issue' | 'github-branch' | 'github-repo';
    /** Whether the field is required */
    required?: boolean;
    /** Default value */
    default?: unknown;
    /** Options for 'select' type */
    options?: string[];
    /** Placeholder text */
    placeholder?: string;
    /** For github-* pickers: which repo to scope to (owner/repo). If omitted, uses the trigger's repo. */
    scope?: string;
}

export interface TriggerDefinition {
    /** Integration name(s), e.g. "github" or ["github", "github-poll"] */
    source: OneOrMany<string>;
    /** Event name(s), e.g. "pull_request.opened" or ["pull_request.opened", "pull_request.synchronize"] */
    event: OneOrMany<string>;

    // ─── Shorthand filters (resolved automatically) ─────────────────────
    /** Repository full name(s), e.g. "my-org/my-repo" or ["org/repo-a", "org/repo-b"] */
    repo?: OneOrMany<string>;
    /** Target branch name(s), e.g. "main" or ["main", "develop"] */
    branch?: OneOrMany<string>;
    /** PR/issue author login(s), e.g. "dependabot[bot]" or ["user-a", "user-b"] */
    author?: OneOrMany<string>;
    /** Labels that must be present (any match) */
    labels?: string[];

    // ─── Power-user: raw dot-path filters ───────────────────────────────
    /** Raw key/value filters applied against the full event payload */
    filters?: Record<string, string>;
}

export interface WorkflowStepDefinition {
    /** Optional step identifier for referencing results by name, e.g. "fetch_diff" */
    id?: string;
    /** Registered action name, e.g. "log", "webhook" */
    action: string;
    /** Params passed to the action, may contain {{template}} expressions */
    params: Record<string, unknown>;
    /** Optional condition — step only runs if this evaluates truthy after template interpolation */
    condition?: string;
    /** Error handling: 'stop' (default) halts the workflow, 'continue' skips to next step */
    on_error?: 'stop' | 'continue';
    /** Execution hint: 'parallel' groups consecutive steps to run concurrently. */
    run?: 'parallel';
    /** Step-level AI config override. */
    ai?: AIStepConfig;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Runtime context handed to each action during execution */
export interface ActionContext {
    event: EventPayload;
    /** Accumulated results from previous steps (keyed by step index) */
    results: Record<number, unknown>;
    /** Accumulated results from previous steps (keyed by step id, if set) */
    steps: Record<string, unknown>;
    /** Integration configs from sokuza.config.yaml */
    integrationConfigs: Record<string, IntegrationConfig>;
    /** AI provider registry (populated from the config's `ai:` block). */
    ai: import('./ai-providers.js').AIProviderRegistry;
    logger: import('pino').Logger;
    /** Name of the workflow being executed */
    workflowName?: string;
    /** Record an outbound webhook delivery for the delivery log */
    recordWebhookDelivery?: (delivery: Omit<WebhookDelivery, 'id' | 'timestamp'>) => void;
}

export type ActionHandler = (
    params: Record<string, unknown>,
    context: ActionContext,
) => Promise<unknown>;

// ─── Run History ────────────────────────────────────────────────────────────

/** A record of a manual workflow execution */
export interface WorkflowRunRecord {
    /** Unique run identifier */
    id: string;
    /** Name of the workflow that was executed */
    workflowName: string;
    /** Inputs provided for this run */
    inputs: Record<string, unknown>;
    /** ISO-8601 timestamp when the run started */
    timestamp: string;
    /** Execution status */
    status: 'running' | 'success' | 'error';
    /** Duration in milliseconds (set after completion) */
    durationMs?: number;
    /** Error message if status is 'error' */
    error?: string;
}

/** A record of an outbound webhook delivery */
export interface WebhookDelivery {
    /** Unique delivery identifier */
    id: string;
    /** Workflow name that triggered the webhook */
    workflowName: string;
    /** Target URL */
    url: string;
    /** HTTP method */
    method: string;
    /** Response status code */
    statusCode: number;
    /** Response status text */
    statusText: string;
    /** Whether the response was 2xx */
    ok: boolean;
    /** ISO-8601 timestamp */
    timestamp: string;
    /** Error message if the request failed entirely */
    error?: string;
}

// ─── Queue ───────────────────────────────────────────────────────────────────

export type DedupStrategy = 'latest-wins' | 'drop-duplicate' | 'none';
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'deduped';

export interface QueueSettings {
    /** Max concurrent jobs in this scope (default: 3). */
    concurrency: number;
    /** How to handle duplicate jobs (default: 'latest-wins'). */
    dedup: DedupStrategy;
    /** Template expression for dedup key. Supports {{workflow.name}}, {{event.metadata.*}}, etc. */
    dedup_key: string;
    /** Job priority (default: 'normal'). */
    priority: JobPriority;
    /** Max execution time in seconds (default: 300). */
    timeout: number;
    /** Max retry attempts on failure (default: 0). */
    retry: number;
    /** Seconds between retry attempts (default: 30). */
    retry_delay: number;
}

export interface QueueConfig {
    /** Default queue settings applied to all workflows. */
    defaults?: Partial<QueueSettings>;
    /** Per-provider overrides keyed by registered provider name. */
    per_provider?: Record<string, Partial<QueueSettings>>;
    /** Per-workflow overrides keyed by workflow name. */
    per_workflow?: Record<string, Partial<QueueSettings>>;
    /** Per-repo overrides keyed by "owner/repo". */
    per_repo?: Record<string, Partial<QueueSettings>>;
}

export interface ResolvedQueueConfig {
    concurrency: number;
    dedup: DedupStrategy;
    dedupKey: string;
    priority: JobPriority;
    timeout: number;
    retry: number;
    retryDelay: number;
}

export interface QueueJob {
    id: string;
    workflow: WorkflowDefinition;
    event: EventPayload;
    status: JobStatus;
    priority: JobPriority;
    resolvedConfig: ResolvedQueueConfig;
    enqueuedAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    dedupKey: string;
    attempts: number;
}

export const JOB_PRIORITY_ORDER: Record<JobPriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
};
