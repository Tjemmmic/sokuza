import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import yaml from 'js-yaml';
import type { WorkflowDefinition, TriggerDefinition, WorkflowStepDefinition, OneOrMany } from './types.js';
import { toArray } from './types.js';

// ─── Template Loading ───────────────────────────────────────────────────────

interface TemplateDefinition {
    trigger?: Partial<TriggerDefinition>;
    steps: WorkflowStepDefinition[];
}

/** In-memory cache after loading */
let loadedTemplates: Record<string, TemplateDefinition> | null = null;

/**
 * Load all YAML templates from a directory.
 * Each `.yaml` file becomes a template named after the file
 * (e.g. `ai-pr-review.yaml` → template name `ai-pr-review`).
 */
export async function loadTemplates(
    templateDir?: string,
): Promise<Record<string, TemplateDefinition>> {
    if (loadedTemplates) return loadedTemplates;

    // Default: templates/ next to the project root
    const dir = templateDir ?? getDefaultTemplateDir();

    const templates: Record<string, TemplateDefinition> = {};

    // Load from main dir and library/ subdirectory
    const dirs = [dir, join(dir, 'library')];
    for (const d of dirs) {
        let files: string[];
        try {
            files = await readdir(d);
        } catch {
            continue;
        }

        for (const file of files) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

            const name = basename(file, extname(file));
            const content = await readFile(join(d, file), 'utf-8');
            const parsed = yaml.load(content) as Record<string, unknown>;

            templates[name] = {
                trigger: parsed.trigger as Partial<TriggerDefinition> | undefined,
                steps: (parsed.steps as WorkflowStepDefinition[]) ?? [],
            };
        }
    }

    loadedTemplates = templates;
    return templates;
}


/** Reset the cache (for testing) */
export function resetTemplateCache(): void {
    loadedTemplates = null;
}

/** Default templates directory: <project_root>/templates */
function getDefaultTemplateDir(): string {
    // Walk up from dist/ or src/ to find the project root
    const thisFile = new URL(import.meta.url).pathname;
    // src/core/templates.ts → go up 2 levels to project root
    const projectRoot = join(thisFile, '..', '..', '..');
    return join(projectRoot, 'templates');
}

// ─── Shorthand Filter Resolution ────────────────────────────────────────────

/**
 * Mapping of shorthand trigger keys → the deep dot-path filter they resolve to.
 */
const GITHUB_SHORTHAND_MAP: Record<string, string> = {
    repo: 'metadata.repo',
    branch: 'payload.pull_request.base.ref',
    author: 'payload.pull_request.user.login',
};

/**
 * Normalize a raw workflow definition from the config:
 *  1. Expand `template` into steps if set (loaded from YAML files)
 *  2. Resolve shorthand trigger fields (repo, branch, author, labels) into filters
 */
export async function normalizeWorkflow(
    raw: Record<string, unknown>,
): Promise<WorkflowDefinition> {
    // ─── Template expansion ──────────────────────────────────────────────
    const templateName = raw.template as string | undefined;
    let steps = raw.steps as WorkflowDefinition['steps'] | undefined;
    let trigger = raw.trigger as Record<string, unknown> | undefined;

    if (templateName) {
        const templates = await loadTemplates();
        const template = templates[templateName];
        if (!template) {
            const available = Object.keys(templates).join(', ') || '(none found)';
            throw new Error(
                `Unknown workflow template "${templateName}". Available: ${available}`,
            );
        }

        // Template provides steps; user can override with their own
        if (!steps || (Array.isArray(steps) && steps.length === 0)) {
            steps = template.steps;
        }

        // Template provides default trigger fields; user's trigger wins
        if (template.trigger) {
            trigger = {
                ...template.trigger,
                ...(trigger ?? {}),
            };
        }
    }

    if (!trigger) {
        throw new Error(`Workflow "${raw.name}" must have a trigger`);
    }
    if (!steps || steps.length === 0) {
        throw new Error(`Workflow "${raw.name}" must have steps (or use a template)`);
    }

    // ─── Shorthand resolution ────────────────────────────────────────────
    const resolvedTrigger = resolveShorthands(trigger);

    return {
        name: raw.name as string,
        description: raw.description as string | undefined,
        enabled: raw.enabled !== undefined ? raw.enabled as boolean : undefined,
        template: templateName,
        trigger: resolvedTrigger,
        steps,
        inputs: raw.inputs as WorkflowDefinition['inputs'],
        queue: raw.queue as WorkflowDefinition['queue'],
        ai: raw.ai as WorkflowDefinition['ai'],
    };
}

function resolveShorthands(
    raw: Record<string, unknown>,
): TriggerDefinition {
    const filters: Record<string, string> = {
        ...((raw.filters as Record<string, string>) ?? {}),
    };

    // Source and event: pass through as-is (OneOrMany<string>)
    const source = (raw.source as OneOrMany<string>) ?? 'github';
    const event = raw.event as OneOrMany<string>;

    // Resolve simple key→path shorthands (supports single or first value for filters)
    for (const [shorthand, filterPath] of Object.entries(GITHUB_SHORTHAND_MAP)) {
        const value = raw[shorthand] as OneOrMany<string> | undefined;
        if (value !== undefined) {
            const values = toArray(value);
            if (values.length === 1) {
                // Single value → exact match filter
                filters[filterPath] = values[0];
            }
            // For multiple values, we skip filter-based resolution
            // and keep the raw array on the trigger for multi-value matching via matchesTrigger
        }
    }

    const labels = raw.labels as string[] | undefined;
    if (labels && Array.isArray(labels) && labels.length > 0) {
        if (labels.length === 1) {
            filters[`payload.pull_request.labels[].name`] = labels[0];
        }
    }

    return {
        source,
        event,
        repo: raw.repo as OneOrMany<string> | undefined,
        branch: raw.branch as OneOrMany<string> | undefined,
        author: raw.author as OneOrMany<string> | undefined,
        labels: raw.labels as string[] | undefined,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
    };
}

