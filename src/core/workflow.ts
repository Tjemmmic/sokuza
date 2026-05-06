import { rm } from 'node:fs/promises';
import type { Logger } from 'pino';
import type {
    ActionContext,
    ActionHandler,
    AIStepConfig,
    EventPayload,
    IntegrationConfig,
    WorkflowDefinition,
    WorkflowStepDefinition,
} from './types.js';
import type { AIProviderRegistry } from './ai-providers.js';
import { loadAIProviders } from './ai-providers.js';
import { toArray } from './types.js';
import { executeGraph } from './nodes/runtime.js';
import { getNodeRegistry } from './nodes/registry.js';
import { extractTriggerFromGraph, isGraphWorkflow } from './nodes/graph-trigger.js';
import { isWorkflowTempPath } from './temp-paths.js';

/**
 * Determines whether a workflow's trigger matches an incoming event.
 *
 * Source and event each support OneOrMany<string> — any match qualifies.
 *
 * Filters support deep dot-path resolution against the full EventPayload.
 * For example:
 *   "payload.pull_request.user.login": "dependabot[bot]"
 *   "payload.pull_request.base.ref": "main"
 *
 * Array-contains syntax (trailing []):
 *   "payload.pull_request.labels[].name": "needs-review"
 *   → true if ANY element in the labels array has name === "needs-review"
 */
export function matchesTrigger(
    workflow: WorkflowDefinition,
    event: EventPayload,
): boolean {
    // Disabled workflows never match
    if (workflow.enabled === false) return false;

    // Graph workflows store trigger config inside a trigger.<source> node;
    // bridge that to the legacy TriggerDefinition shape so the matching
    // logic below stays unchanged.
    const trigger = isGraphWorkflow(workflow) && workflow.graph
        ? (extractTriggerFromGraph(workflow.graph) ?? workflow.trigger)
        : workflow.trigger;
    if (!trigger) return false;

    // ─── Source matching (any of the trigger sources) ────────────────────
    // Each source is distinct: github (webhooks), github-poll (token polling),
    // gh-cli (CLI polling). Workflows must explicitly target their source.
    const triggerSources = toArray(trigger.source);
    const sourceMatches = triggerSources.some(src => src === event.source);

    if (!sourceMatches) return false;

    // ─── Event matching (any of the trigger events) ─────────────────────
    // Manual triggers bypass event matching — the user explicitly chose this workflow
    const triggerEvents = toArray(trigger.event);
    if (event.source !== 'manual' && !triggerEvents.some(evt => evt === event.event)) return false;

    // Apply optional deep-path filters (skip for manual triggers)
    if (trigger.filters && event.source !== 'manual') {
        for (const [filterKey, expected] of Object.entries(trigger.filters)) {
            if (!matchesFilter(event, filterKey, expected)) return false;
        }
    }

    // ─── Multi-value shorthand matching (repo/branch/author arrays) ─────
    // When these have >1 value, they weren't converted to single-value filters
    if (event.source !== 'manual') {
        const shorthandChecks: Array<{ values: string[]; path: string }> = [
            { values: toArray(trigger.repo), path: 'metadata.repo' },
            { values: toArray(trigger.branch), path: 'payload.pull_request.base.ref' },
            { values: toArray(trigger.author), path: 'payload.pull_request.user.login' },
        ];
        for (const { values, path } of shorthandChecks) {
            if (values.length <= 1) continue; // Single values handled by filters above
            const actual = String(resolvePath(event, path) ?? '');
            const caseInsensitive = path === 'payload.pull_request.user.login';
            if (!values.some(v => caseInsensitive ? v.toLowerCase() === actual.toLowerCase() : v === actual)) return false;
        }
    }

    return true;
}

/** Paths where comparison should be case-insensitive (GitHub usernames) */
const CASE_INSENSITIVE_PATHS = new Set([
    'payload.pull_request.user.login',
]);

/**
 * Match a single filter key against the event.
 * Supports dot-path resolution, array-contains with `[]` syntax,
 * and OR-across-paths with `|` syntax (e.g.
 * "payload.review.body|payload.comment.body" matches if EITHER
 * path satisfies the expected value).
 */
function matchesFilter(
    event: EventPayload,
    filterKey: string,
    expected: string,
): boolean {
    // OR-across-paths: "path.a|path.b" — true if any alternative matches.
    if (filterKey.includes('|')) {
        return filterKey.split('|').some((altKey) =>
            matchesSingleFilter(event, altKey.trim(), expected),
        );
    }

    return matchesSingleFilter(event, filterKey, expected);
}

function matchesSingleFilter(
    event: EventPayload,
    filterKey: string,
    expected: string,
): boolean {
    // Check for array-contains pattern: "path.to.array[].field"
    const arrayMatch = filterKey.match(/^(.+)\[\]\.(.+)$/);

    if (arrayMatch) {
        const [, arrayPath, fieldName] = arrayMatch;
        const arr = resolvePath(event, arrayPath);
        if (!Array.isArray(arr)) return false;
        return arr.some(
            (item) =>
                String(
                    (item as Record<string, unknown>)[fieldName],
                ) === expected,
        );
    }

    // Standard dot-path resolution
    const actual = resolvePath(event, filterKey);
    if (actual === undefined || actual === null) return false;
    const actualStr = CASE_INSENSITIVE_PATHS.has(filterKey)
        ? String(actual).toLowerCase()
        : String(actual);
    const expectedStr = CASE_INSENSITIVE_PATHS.has(filterKey)
        ? expected.toLowerCase()
        : expected;

    // Glob support: `*` matches any run of characters. Anchored at both
    // ends unless the pattern itself uses `*` there. Required for body
    // filters like "*<!-- sokuza:run-id=*" or "*/sokuza fix*".
    if (expectedStr.includes('*')) {
        return globMatch(expectedStr, actualStr);
    }
    return actualStr === expectedStr;
}

function globMatch(pattern: string, value: string): boolean {
    // Escape regex specials except `*`, then convert `*` to `.*`. Dotall
    // flag because comment bodies routinely span multiple lines.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 's').test(value);
}

type StepGroup = {
    kind: 'sequential';
    steps: Array<{ index: number; step: WorkflowStepDefinition }>;
} | {
    kind: 'parallel';
    steps: Array<{ index: number; step: WorkflowStepDefinition }>;
};

function groupSteps(steps: WorkflowStepDefinition[]): StepGroup[] {
    const groups: StepGroup[] = [];
    let i = 0;
    while (i < steps.length) {
        if (steps[i].run === 'parallel') {
            const parallelSteps: Array<{ index: number; step: WorkflowStepDefinition }> = [];
            while (i < steps.length && steps[i].run === 'parallel') {
                parallelSteps.push({ index: i, step: steps[i] });
                i++;
            }
            groups.push({ kind: 'parallel', steps: parallelSteps });
        } else {
            groups.push({ kind: 'sequential', steps: [{ index: i, step: steps[i] }] });
            i++;
        }
    }
    return groups;
}

function mergeAIConfig(
    stepConfig: AIStepConfig | undefined,
    workflowConfig: AIStepConfig | undefined,
): AIStepConfig | undefined {
    if (!stepConfig && !workflowConfig) return undefined;
    return { ...workflowConfig, ...stepConfig };
}

function withTimeout<T>(promise: Promise<T>, seconds: number | undefined, message: string): Promise<T> {
    if (!seconds || seconds <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), seconds * 1000);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); },
        );
    });
}

function applyAIConfigToParams(
    params: Record<string, unknown>,
    aiConfig: AIStepConfig | undefined,
): Record<string, unknown> {
    if (!aiConfig) return params;
    const merged = { ...params };
    if (aiConfig.provider && merged.provider === undefined) {
        merged.provider = aiConfig.provider;
    }
    if (aiConfig.model && merged.model === undefined) {
        merged.model = aiConfig.model;
    }
    return merged;
}

interface MakeContextExtras {
    workdirManager?: import('./types.js').ActionContext['workdirManager'];
    getConfig?: import('./types.js').ActionContext['getConfig'];
}

function makeContext(
    event: EventPayload,
    results: Record<number, unknown>,
    steps: Record<string, unknown>,
    integrationConfigs: Record<string, IntegrationConfig>,
    ai: AIProviderRegistry,
    logger: Logger,
    workflowName?: string,
    recordWebhookDelivery?: import('./types.js').ActionContext['recordWebhookDelivery'],
    extras?: MakeContextExtras,
): ActionContext {
    return {
        event, results, steps, integrationConfigs, ai, logger, workflowName,
        recordWebhookDelivery,
        workdirManager: extras?.workdirManager,
        getConfig: extras?.getConfig,
    };
}

function shouldSkip(step: WorkflowStepDefinition, ctx: ActionContext): boolean {
    if (!step.condition) return false;
    const condValue = interpolateString(step.condition, ctx);
    const isTruthy = condValue !== '' && condValue !== 'false' && condValue !== '0' && condValue !== 'undefined' && condValue !== 'null';
    return !isTruthy;
}

/**
 * Run all steps of a workflow. Consecutive steps with `run: parallel` are
 * executed concurrently with fail-fast semantics. All other steps run
 * sequentially. Step-level and workflow-level AI config is resolved and
 * injected into action params.
 */
/**
 * Execute a workflow. Returns the accumulated step results keyed by index
 * and by step id, which chat tools and the dashboard run-history use to
 * surface the actual workflow output (not just success/failure). Existing
 * callers that ignore the return value are unaffected.
 */
export interface WorkflowExecutionResult {
    results: Record<number, unknown>;
    steps: Record<string, unknown>;
}

export async function executeWorkflow(
    workflow: WorkflowDefinition,
    event: EventPayload,
    actionRegistry: Map<string, ActionHandler>,
    logger: Logger,
    integrationConfigs: Record<string, IntegrationConfig> = {},
    ai?: AIProviderRegistry,
    _signal?: AbortSignal,
    recordWebhookDelivery?: import('./types.js').ActionContext['recordWebhookDelivery'],
    extras?: MakeContextExtras,
): Promise<WorkflowExecutionResult> {
    const aiRegistry: AIProviderRegistry = ai ?? loadAIProviders(undefined);

    // ── Graph-form workflows go through the node runtime ───────────────
    if (isGraphWorkflow(workflow)) {
        const graphTempPaths: string[] = [];
        try {
            const graphResult = await executeGraph(
                workflow.graph!, event, actionRegistry, getNodeRegistry(), logger,
                {
                    workflowName: workflow.name,
                    integrationConfigs,
                    ai: aiRegistry,
                    recordWebhookDelivery,
                    workdirManager: extras?.workdirManager,
                    getConfig: extras?.getConfig,
                    signal: _signal,
                },
            );
            for (const out of Object.values(graphResult.nodeOutputs)) {
                collectTempPath(out, graphTempPaths);
            }
            return { results: graphResult.results, steps: graphResult.steps };
        } finally {
            await cleanupTempDirs(graphTempPaths, logger);
        }
    }

    // ── Legacy steps form ──────────────────────────────────────────────
    const results: Record<number, unknown> = {};
    const steps: Record<string, unknown> = {};
    const tempPaths: string[] = [];

    logger.info({ workflow: workflow.name }, 'Executing workflow');

    try {
        const groups = groupSteps(workflow.steps ?? []);

        for (const group of groups) {
            if (_signal?.aborted) {
                throw new Error('Workflow aborted');
            }

            if (group.kind === 'sequential') {
                const { index, step } = group.steps[0];
                const ctx = makeContext(event, results, steps, integrationConfigs, aiRegistry, logger, workflow.name, recordWebhookDelivery, extras);

                if (shouldSkip(step, ctx)) {
                    logger.info(
                        { workflow: workflow.name, step: index, action: step.action, condition: step.condition },
                        'Step condition is falsy, skipping',
                    );
                    continue;
                }

                const handler = actionRegistry.get(step.action);
                if (!handler) {
                    logger.warn({ action: step.action, step: index }, 'Unknown action, skipping step');
                    continue;
                }

                const aiConfig = mergeAIConfig(step.ai, workflow.ai);
                const baseParams = interpolateParams(step.params, ctx);
                const resolvedParams = applyAIConfigToParams(baseParams, aiConfig);

                try {
                    const result = await withTimeout(
                        handler(resolvedParams, ctx),
                        step.timeout,
                        `Step ${index} (${step.action}) timed out after ${step.timeout}s`,
                    );
                    collectTempPath(result, tempPaths);
                    results[index] = result;
                    if (step.id) steps[step.id] = result;
                    logger.info({ workflow: workflow.name, step: index, id: step.id, action: step.action }, 'Step completed');
                } catch (err) {
                    if (step.on_error === 'continue') {
                        logger.warn({ workflow: workflow.name, step: index, action: step.action, err }, 'Step failed (on_error=continue), proceeding');
                        continue;
                    }
                    logger.error({ workflow: workflow.name, step: index, action: step.action, err }, 'Step failed');
                    throw err;
                }
            } else {
                const parallelResults = await runParallelGroup(
                    workflow, group.steps, event, results, steps,
                    actionRegistry, integrationConfigs, aiRegistry, logger,
                    recordWebhookDelivery, extras,
                );
                for (const pr of parallelResults) {
                    if (pr) collectTempPath(pr.result, tempPaths);
                }
            }
        }

        logger.info({ workflow: workflow.name }, 'Workflow completed');
        return { results, steps };
    } finally {
        await cleanupTempDirs(tempPaths, logger);
    }
}

interface ParallelStepResult {
    index: number;
    stepId?: string;
    result: unknown;
}

async function runParallelGroup(
    workflow: WorkflowDefinition,
    groupSteps: Array<{ index: number; step: WorkflowStepDefinition }>,
    event: EventPayload,
    results: Record<number, unknown>,
    steps: Record<string, unknown>,
    actionRegistry: Map<string, ActionHandler>,
    integrationConfigs: Record<string, IntegrationConfig>,
    aiRegistry: AIProviderRegistry,
    logger: Logger,
    recordWebhookDelivery?: import('./types.js').ActionContext['recordWebhookDelivery'],
    extras?: MakeContextExtras,
): Promise<ParallelStepResult[]> {
    const settled = await Promise.allSettled(
        groupSteps.map(async ({ index, step }): Promise<ParallelStepResult | undefined> => {
            const ctx = makeContext(event, results, steps, integrationConfigs, aiRegistry, logger, workflow.name, recordWebhookDelivery, extras);

            if (shouldSkip(step, ctx)) {
                logger.info(
                    { workflow: workflow.name, step: index, action: step.action, condition: step.condition },
                    'Parallel step condition is falsy, skipping',
                );
                return undefined;
            }

            const handler = actionRegistry.get(step.action);
            if (!handler) {
                logger.warn({ action: step.action, step: index }, 'Unknown action, skipping');
                return undefined;
            }

            const aiConfig = mergeAIConfig(step.ai, workflow.ai);
            const baseParams = interpolateParams(step.params, ctx);
            const resolvedParams = applyAIConfigToParams(baseParams, aiConfig);

            const result = await withTimeout(
                handler(resolvedParams, ctx),
                step.timeout,
                `Parallel step ${index} (${step.action}) timed out after ${step.timeout}s`,
            );
            logger.info({ workflow: workflow.name, step: index, id: step.id, action: step.action }, 'Parallel step completed');
            return { index, stepId: step.id, result };
        }),
    );

    const collected: ParallelStepResult[] = [];
    let firstError: { reason: unknown; step: WorkflowStepDefinition } | null = null;

    for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'rejected') {
            const { step } = groupSteps[i];
            if (step.on_error === 'continue') {
                logger.warn(
                    { workflow: workflow.name, action: step.action, err: outcome.reason },
                    'Parallel step failed (on_error=continue)',
                );
            } else if (!firstError) {
                firstError = { reason: outcome.reason, step };
            }
        } else if (outcome.value) {
            const { index, stepId, result } = outcome.value;
            results[index] = result;
            if (stepId) steps[stepId] = result;
            collected.push(outcome.value);
        }
    }

    if (firstError) {
        throw firstError.reason;
    }

    return collected;
}

// ─── Temp directory cleanup ──────────────────────────────────────────────────

function collectTempPath(result: unknown, paths: string[]): void {
    if (!result || typeof result !== 'object') return;
    const obj = result as Record<string, unknown>;
    if (typeof obj.path === 'string' && isWorkflowTempPath(obj.path)) {
        paths.push(obj.path);
    }
}

async function cleanupTempDirs(paths: string[], logger: Logger): Promise<void> {
    for (const dir of paths) {
        try {
            await rm(dir, { recursive: true, force: true });
            logger.debug({ path: dir }, 'Cleaned up temp directory');
        } catch (err: any) {
            logger.warn({ path: dir, err: err.message }, 'Failed to clean up temp directory');
        }
    }
}

// ─── Template Interpolation ─────────────────────────────────────────────────

/**
 * Recursively resolve `{{event.payload.foo}}` and `{{steps.id.field}}`
 * expressions in params. Walks strings, arrays, and plain objects so a
 * config like `params: { items: ['{{steps.a.val}}'] }` resolves the
 * template inside the array — matches the graph runtime's
 * interpolateValue (runtime.ts), keeping legacy and graph executors
 * consistent.
 */
export function interpolateParams(
    params: Record<string, unknown>,
    context: ActionContext,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        result[key] = interpolateValue(value, context);
    }
    return result;
}

function interpolateValue(value: unknown, context: ActionContext): unknown {
    if (typeof value === 'string') return interpolateString(value, context);
    if (Array.isArray(value)) return value.map((v) => interpolateValue(v, context));
    if (value && typeof value === 'object') {
        return interpolateParams(value as Record<string, unknown>, context);
    }
    return value;
}

const ALLOWED_INTERPOLATION_PREFIXES = ['event.', 'results.', 'steps.', 'metadata.', 'inputs.'];

const INPUTS_ALIAS_RE = /^inputs\.(.+)$/;

function interpolateString(template: string, context: ActionContext): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
        const trimmed = path.trim();
        if (!ALLOWED_INTERPOLATION_PREFIXES.some(p => trimmed.startsWith(p))) {
            return '';
        }
        const resolved = INPUTS_ALIAS_RE.test(trimmed)
            ? `event.payload.${trimmed}`
            : trimmed;
        const value = resolvePath(context, resolved);
        return value !== undefined ? String(value) : '';
    });
}

function resolvePath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

