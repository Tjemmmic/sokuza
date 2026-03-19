import type { Logger } from 'pino';
import type {
    ActionContext,
    ActionHandler,
    EventPayload,
    IntegrationConfig,
    WorkflowDefinition,
} from './types.js';
import { toArray } from './types.js';

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

    const { trigger } = workflow;

    // ─── Source matching (any of the trigger sources) ────────────────────
    const triggerSources = toArray(trigger.source);
    const sourceMatches = triggerSources.some(src =>
        src === event.source ||
        (event.source === 'github-poll' && src === 'github'),
    );

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
            if (!values.some(v => v === actual)) return false;
        }
    }

    return true;
}

/**
 * Match a single filter key against the event.
 * Supports dot-path resolution and array-contains with `[]` syntax.
 */
function matchesFilter(
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
    return String(actual) === expected;
}

/**
 * Run all steps of a workflow sequentially, passing context between them.
 */
export async function executeWorkflow(
    workflow: WorkflowDefinition,
    event: EventPayload,
    actionRegistry: Map<string, ActionHandler>,
    logger: Logger,
    integrationConfigs: Record<string, IntegrationConfig> = {},
): Promise<void> {
    const results: Record<number, unknown> = {};
    const steps: Record<string, unknown> = {};

    logger.info({ workflow: workflow.name }, 'Executing workflow');

    for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        const handler = actionRegistry.get(step.action);

        if (!handler) {
            logger.warn(
                { action: step.action, step: i },
                'Unknown action, skipping step',
            );
            continue;
        }

        const context: ActionContext = {
            event,
            results,
            steps,
            integrationConfigs,
            logger,
        };

        // ─── Conditional execution ──────────────────────────────────────
        if (step.condition) {
            const condValue = interpolateString(step.condition, context);
            const isTruthy = condValue !== '' && condValue !== 'false' && condValue !== '0' && condValue !== 'undefined' && condValue !== 'null';
            if (!isTruthy) {
                logger.info(
                    { workflow: workflow.name, step: i, action: step.action, condition: step.condition, resolved: condValue },
                    'Step condition is falsy, skipping',
                );
                continue;
            }
        }

        // Interpolate template expressions in step params
        const resolvedParams = interpolateParams(step.params, context);

        try {
            const result = await handler(resolvedParams, context);
            results[i] = result;

            // Store by step ID if provided
            if (step.id) {
                steps[step.id] = result;
            }

            logger.info(
                { workflow: workflow.name, step: i, id: step.id, action: step.action },
                'Step completed',
            );
        } catch (err) {
            if (step.on_error === 'continue') {
                logger.warn(
                    { workflow: workflow.name, step: i, action: step.action, err },
                    'Step failed (on_error=continue), proceeding to next step',
                );
                continue;
            }
            logger.error(
                { workflow: workflow.name, step: i, action: step.action, err },
                'Step failed',
            );
            throw err;
        }
    }

    logger.info({ workflow: workflow.name }, 'Workflow completed');
}

// ─── Template Interpolation ─────────────────────────────────────────────────

/**
 * Recursively resolve `{{event.payload.foo}}` and `{{steps.id.field}}`
 * expressions in params.
 */
export function interpolateParams(
    params: Record<string, unknown>,
    context: ActionContext,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') {
            result[key] = interpolateString(value, context);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = interpolateParams(
                value as Record<string, unknown>,
                context,
            );
        } else {
            result[key] = value;
        }
    }

    return result;
}

function interpolateString(template: string, context: ActionContext): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
        const value = resolvePath(context, path.trim());
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

