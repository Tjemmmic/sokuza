import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { WorkflowDefinition, TriggerDefinition, WorkflowStepDefinition, OneOrMany } from './types.js';
import { toArray } from './types.js';
import { normalizeGraphWorkflow } from './nodes/graph-trigger.js';

// ─── Template Loading ───────────────────────────────────────────────────────

interface TemplateDefinition {
    trigger?: Partial<TriggerDefinition>;
    /** Linear-step form (legacy). Either steps or graph (or both) may be set. */
    steps: WorkflowStepDefinition[];
    /** Visual graph form. Workflows that reference the template inherit it. */
    graph?: WorkflowDefinition['graph'];
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
                graph: parsed.graph as WorkflowDefinition['graph'] | undefined,
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
    // Resolve whichever layout we're running in:
    //   source (tsx):   src/core/templates.ts → ../../templates
    //   built (tsup):   dist/index.js          → ../templates
    // Try each candidate; first existing dir wins. This avoids counting
    // directory levels, which desynced between layouts in the past.
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        join(dirname(here), '..', '..', 'templates'),
        join(dirname(here), '..', 'templates'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    // Fall back to the first candidate — loadTemplates will return {} and
    // surface a clear error when a workflow tries to reference a template.
    return candidates[0];
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
    let graph = raw.graph as WorkflowDefinition['graph'] | undefined;

    if (templateName) {
        const templates = await loadTemplates();
        const template = templates[templateName];
        if (!template) {
            const available = Object.keys(templates).join(', ') || '(none found)';
            throw new Error(
                `Unknown workflow template "${templateName}". Available: ${available}`,
            );
        }

        const userHasSteps = Array.isArray(steps) && steps.length > 0;
        const userHasGraph = !!graph && Array.isArray(graph.nodes) && graph.nodes.length > 0;

        // Inherit only when the user hasn't provided either form. Inheriting
        // graph alongside user steps would silently swap forms — the runtime
        // prefers graph, so user steps would become dead code.
        if (!userHasSteps && !userHasGraph) {
            if (template.steps?.length) steps = template.steps;
            if (template.graph?.nodes?.length) graph = template.graph;
        }

        // Template provides default trigger fields; user's trigger wins
        if (template.trigger) {
            trigger = {
                ...template.trigger,
                ...(trigger ?? {}),
            };
        }
    }

    // Graph-form workflows store their executable definition under
    // `graph:` instead of `steps:`. Accept either; treat them as
    // mutually-sufficient alternatives.
    const hasGraph = !!graph && Array.isArray(graph.nodes) && graph.nodes.length > 0;

    if (!trigger && !hasGraph) {
        throw new Error(`Workflow "${raw.name}" must have a trigger`);
    }
    if ((!steps || steps.length === 0) && !hasGraph) {
        throw new Error(`Workflow "${raw.name}" must have steps, a template, or a graph`);
    }

    // ─── Shorthand resolution ────────────────────────────────────────────
    // Graph workflows can omit a top-level trigger — the runtime derives
    // matching info from the graph's trigger node. For graph-only
    // workflows we leave `trigger` undefined here so the merge below
    // (`normalizeGraphWorkflow`) can pull `source` straight from the
    // graph's trigger node. Synthesizing a `{source:'manual'}` placeholder
    // would shadow the real graph-derived source, hiding e.g. `github`
    // triggers behind a fake `manual` source.
    // Legacy steps-only workflows still get the `manual` placeholder when
    // no YAML trigger is set so downstream code that accesses
    // `wf.trigger` keeps a defined value to read.
    const resolvedTrigger = trigger
        ? resolveShorthands(trigger)
        : (hasGraph ? undefined : { source: 'manual', event: [] });

    const wf: WorkflowDefinition = {
        name: raw.name as string,
        description: raw.description as string | undefined,
        enabled: raw.enabled !== undefined ? raw.enabled as boolean : undefined,
        template: templateName,
        trigger: resolvedTrigger as TriggerDefinition,
        steps,
        graph,
        inputs: raw.inputs as WorkflowDefinition['inputs'],
        queue: raw.queue as WorkflowDefinition['queue'],
        ai: raw.ai as WorkflowDefinition['ai'],
    };
    // For graph workflows, merge the graph-derived trigger with any YAML
    // trigger fields so user-authored `trigger.source` / `trigger.event` /
    // `trigger.filters` overrides actually surface to matchesTrigger. The
    // helper is a no-op for legacy steps-only workflows.
    return normalizeGraphWorkflow(wf);
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
        exclude: raw.exclude as TriggerDefinition['exclude'] | undefined,
    };
}

