import type { TriggerDefinition, WorkflowDefinition } from '../types.js';
import type { GraphNode, NodeGraph } from './types.js';

// ─── Graph-form trigger extraction ──────────────────────────────────────────
//
// A graph workflow stores its trigger config inside a `trigger.<source>`
// node (the visual editor's first node). For event matching, the engine
// still goes through `matchesTrigger(workflow, event)` — which reads the
// legacy `TriggerDefinition`. We bridge the two by deriving the legacy
// shape from the trigger node's config at workflow-load time.

/** True when this workflow is authored as a node graph (not legacy steps). */
export function isGraphWorkflow(wf: WorkflowDefinition): boolean {
    return !!wf.graph && Array.isArray(wf.graph.nodes) && wf.graph.nodes.length > 0;
}

const TRIGGER_TYPE_TO_SOURCE: Record<string, string> = {
    'trigger.github': 'github',
    'trigger.github-poll': 'github-poll',
    'trigger.gh-cli': 'gh-cli',
    'trigger.slack': 'slack',
    'trigger.webhook': 'webhook',
    'trigger.cron': 'cron',
    'trigger.manual': 'manual',
};

/** Find the (first) trigger node in the graph, if any. */
export function findTriggerNode(graph: NodeGraph): GraphNode | undefined {
    return graph.nodes.find((n) => n.type.startsWith('trigger.'));
}

/**
 * Derive a legacy TriggerDefinition from the graph's trigger node so the
 * existing matchesTrigger() path keeps working with no changes.
 */
export function extractTriggerFromGraph(graph: NodeGraph): TriggerDefinition | undefined {
    const triggerNode = findTriggerNode(graph);
    if (!triggerNode) return undefined;
    const source = TRIGGER_TYPE_TO_SOURCE[triggerNode.type];
    if (!source) return undefined;

    const cfg = triggerNode.config ?? {};
    const events = parseList(cfg.events);
    const repos = parseList(cfg.repos);
    const branches = parseList(cfg.branches);
    const authors = parseList(cfg.authors);
    const labels = parseList(cfg.labels);

    const trigger: TriggerDefinition = {
        source,
        event: events,
    };
    if (repos.length > 0) trigger.repo = repos;
    if (branches.length > 0) trigger.branch = branches;
    if (authors.length > 0) trigger.author = authors;
    if (labels.length > 0) trigger.labels = labels;

    if (source === 'cron' && typeof cfg.schedule === 'string' && cfg.schedule) {
        // Legacy form models cron schedules as the event name itself.
        trigger.event = [cfg.schedule];
    }

    return trigger;
}

function parseList(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string' && v).map(String);
    if (typeof raw === 'string') {
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

/**
 * Normalize a graph workflow so the engine sees a populated `trigger:` block
 * even when the user only configured the graph's trigger node. Idempotent.
 */
export function normalizeGraphWorkflow(wf: WorkflowDefinition): WorkflowDefinition {
    if (!isGraphWorkflow(wf)) return wf;
    const derived = extractTriggerFromGraph(wf.graph!);
    if (!derived) return wf;
    // Preserve any explicit trigger fields the user set in YAML.
    const merged: TriggerDefinition = {
        ...derived,
        ...wf.trigger,
        // Source + event from the trigger node always win — they're the
        // primary input to event matching and the YAML form is a fallback.
        source: wf.trigger?.source ?? derived.source,
        event: derived.event && derived.event.length > 0 ? derived.event : (wf.trigger?.event ?? []),
    };
    return { ...wf, trigger: merged, steps: wf.steps ?? [] };
}
