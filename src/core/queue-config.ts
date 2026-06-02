import type {
    DedupStrategy,
    EventPayload,
    JobPriority,
    QueueConfig,
    QueueSettings,
    ResolvedQueueConfig,
    WorkflowDefinition,
} from './types.js';
import type { AIProviderRegistry } from './ai-providers.js';

const VALID_DEDUP_STRATEGIES: Set<string> = new Set<string>(['latest-wins', 'drop-duplicate', 'none']);
const VALID_PRIORITIES: Set<string> = new Set<string>(['critical', 'high', 'normal', 'low']);

const DEFAULTS: QueueSettings = {
    concurrency: 3,
    dedup: 'latest-wins',
    dedup_key: '{{workflow.name}}:{{event.metadata.repo}}:{{event.metadata.prNumber}}',
    priority: 'normal',
    // 10 minutes. AI-driven workflows commonly chain a clone, a diff
    // fetch, an ai.review call (1–3 min on its own with a CLI provider
    // like opencode/claude-code), an optional repair retry, and a
    // comment post. The previous 5-minute default tripped users running
    // template: ai-pr-review against medium PRs even when nothing was
    // wrong. The companion abort plumbing (signal → CLI subprocess
    // SIGTERM, signal → HTTP fetch abort) ensures hitting the cap
    // actually kills the underlying work, so a longer default doesn't
    // mean a longer wall-clock leak when something legitimately hangs.
    timeout: 600,
    retry: 0,
    retry_delay: 30,
};

export function resolveQueueConfig(
    workflow: WorkflowDefinition,
    event: EventPayload,
    globalConfig: QueueConfig | undefined,
    aiRegistry: AIProviderRegistry | undefined,
): ResolvedQueueConfig {
    const merged = { ...DEFAULTS };

    applyLayer(merged, globalConfig?.defaults);

    const providerName = resolveProviderName(workflow, aiRegistry);
    if (providerName && globalConfig?.per_provider?.[providerName]) {
        applyLayer(merged, globalConfig.per_provider[providerName]);
    }

    const repo = event.metadata?.repo as string | undefined;
    if (repo && globalConfig?.per_repo?.[repo]) {
        applyLayer(merged, globalConfig.per_repo[repo]);
    }

    if (globalConfig?.per_workflow?.[workflow.name]) {
        applyLayer(merged, globalConfig.per_workflow[workflow.name]);
    }

    if (workflow.queue) {
        applyLayer(merged, workflow.queue);
    }

    const dedupKey = interpolateDedupKey(merged.dedup_key, workflow, event);

    return {
        concurrency: merged.concurrency,
        dedup: merged.dedup,
        dedupKey,
        priority: merged.priority,
        timeout: merged.timeout,
        retry: merged.retry,
        retryDelay: merged.retry_delay,
    };
}

function applyLayer(base: QueueSettings, layer: Partial<QueueSettings> | undefined): void {
    if (!layer) return;
    if (layer.concurrency !== undefined) base.concurrency = layer.concurrency;
    if (layer.dedup !== undefined) base.dedup = layer.dedup;
    if (layer.dedup_key !== undefined) base.dedup_key = layer.dedup_key;
    if (layer.priority !== undefined) base.priority = layer.priority;
    if (layer.timeout !== undefined) base.timeout = layer.timeout;
    if (layer.retry !== undefined) base.retry = layer.retry;
    if (layer.retry_delay !== undefined) base.retry_delay = layer.retry_delay;
}

function resolveProviderName(
    workflow: WorkflowDefinition,
    aiRegistry: AIProviderRegistry | undefined,
): string | undefined {
    if (workflow.ai?.provider) return workflow.ai.provider;
    return aiRegistry?.defaultProvider;
}

function interpolateDedupKey(
    template: string,
    workflow: WorkflowDefinition,
    event: EventPayload,
): string {
    const ctx: Record<string, unknown> = {
        'workflow.name': workflow.name,
        'event.source': event.source,
        'event.event': event.event,
    };

    for (const [k, v] of Object.entries(event.metadata)) {
        ctx[`event.metadata.${k}`] = v;
    }

    for (const [k, v] of Object.entries(event.payload)) {
        ctx[`event.payload.${k}`] = v;
    }

    return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
        const trimmed = path.trim();
        const value = ctx[trimmed];
        if (value !== undefined && value !== null) return String(value);
        return resolveDotPath(ctx, trimmed) ?? '';
    });
}

function resolveDotPath(obj: Record<string, unknown>, path: string): string | undefined {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined || current === null) return undefined;
    return String(current);
}

export function validateQueueConfig(config: unknown): QueueConfig | undefined {
    if (config === undefined || config === null) return undefined;
    if (typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('queue config must be an object');
    }

    const raw = config as Record<string, unknown>;

    if (raw.defaults !== undefined) {
        validateQueueSettings('queue.defaults', raw.defaults);
    }

    if (raw.per_provider !== undefined) {
        validatePerEntries('queue.per_provider', raw.per_provider);
    }

    if (raw.per_workflow !== undefined) {
        validatePerEntries('queue.per_workflow', raw.per_workflow);
    }

    if (raw.per_repo !== undefined) {
        validatePerEntries('queue.per_repo', raw.per_repo);
    }

    return raw as unknown as QueueConfig;
}

function validatePerEntries(prefix: string, value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${prefix} must be an object`);
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        validateQueueSettings(`${prefix}.${key}`, entry);
    }
}

export function validateQueueSettings(prefix: string, value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${prefix} must be an object`);
    }

    const settings = value as Record<string, unknown>;

    if (settings.concurrency !== undefined) {
        if (typeof settings.concurrency !== 'number' || settings.concurrency < 1) {
            throw new Error(`${prefix}.concurrency must be a positive number`);
        }
    }

    if (settings.dedup !== undefined) {
        if (!VALID_DEDUP_STRATEGIES.has(settings.dedup as string)) {
            throw new Error(`${prefix}.dedup must be one of: ${[...VALID_DEDUP_STRATEGIES].join(', ')}`);
        }
    }

    if (settings.priority !== undefined) {
        if (!VALID_PRIORITIES.has(settings.priority as string)) {
            throw new Error(`${prefix}.priority must be one of: ${[...VALID_PRIORITIES].join(', ')}`);
        }
    }

    if (settings.timeout !== undefined) {
        if (typeof settings.timeout !== 'number' || settings.timeout < 0) {
            throw new Error(`${prefix}.timeout must be a non-negative number`);
        }
    }

    if (settings.retry !== undefined) {
        if (typeof settings.retry !== 'number' || settings.retry < 0) {
            throw new Error(`${prefix}.retry must be a non-negative number`);
        }
    }

    if (settings.retry_delay !== undefined) {
        if (typeof settings.retry_delay !== 'number' || settings.retry_delay < 0) {
            throw new Error(`${prefix}.retry_delay must be a non-negative number`);
        }
    }

    if (settings.dedup_key !== undefined) {
        if (typeof settings.dedup_key !== 'string') {
            throw new Error(`${prefix}.dedup_key must be a string`);
        }
    }
}

export { DEFAULTS as DEFAULT_QUEUE_SETTINGS };
