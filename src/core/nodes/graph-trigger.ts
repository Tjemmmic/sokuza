import type { TriggerDefinition, WorkflowDefinition } from '../types.js';
import { toArray } from '../types.js';
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
    const events = parseList(cfg.events, 'events', triggerNode.id);
    const repos = parseList(cfg.repos, 'repos', triggerNode.id);
    const branches = parseList(cfg.branches, 'branches', triggerNode.id);
    const authors = parseList(cfg.authors, 'authors', triggerNode.id);
    const labels = parseList(cfg.labels, 'labels', triggerNode.id);

    // Negation: separate config keys keep the form UI flat (one field per
    // exclude axis) while the resulting TriggerDefinition groups them
    // under `exclude:` to match the YAML-author surface.
    const excludeRepos = parseList(cfg.exclude_repos, 'exclude_repos', triggerNode.id);
    const excludeBranches = parseList(cfg.exclude_branches, 'exclude_branches', triggerNode.id);
    const excludeAuthors = parseList(cfg.exclude_authors, 'exclude_authors', triggerNode.id);
    const excludeLabels = parseList(cfg.exclude_labels, 'exclude_labels', triggerNode.id);

    const trigger: TriggerDefinition = {
        source,
        event: events,
    };
    if (repos.length > 0) trigger.repo = repos;
    if (branches.length > 0) trigger.branch = branches;
    if (authors.length > 0) trigger.author = authors;
    if (labels.length > 0) trigger.labels = labels;

    const exclude: NonNullable<TriggerDefinition['exclude']> = {};
    if (excludeRepos.length > 0) exclude.repo = excludeRepos;
    if (excludeBranches.length > 0) exclude.branch = excludeBranches;
    if (excludeAuthors.length > 0) exclude.author = excludeAuthors;
    if (excludeLabels.length > 0) exclude.labels = excludeLabels;
    if (Object.keys(exclude).length > 0) trigger.exclude = exclude;

    if (source === 'cron' && typeof cfg.schedule === 'string' && cfg.schedule) {
        // Legacy form models cron schedules as the event name itself.
        trigger.event = [cfg.schedule];
    }

    return trigger;
}

/** Coerce a trigger-node list config into a string[].
 *  Accepts: array of strings, comma-separated string, undefined/null
 *  (legitimate "no filter" — returns []).
 *  Rejects: number, boolean, object, anything else — those are almost
 *  always a YAML mistype (e.g. `events: 42`) and would otherwise silently
 *  produce a workflow that registers cleanly but never fires. */
function parseList(raw: unknown, key: string, nodeId: string): string[] {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string' && v).map(String);
    if (typeof raw === 'string') {
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    throw new Error(
        `trigger node "${nodeId}" config.${key} must be a string or array of strings (got ${typeof raw}: ${JSON.stringify(raw)})`,
    );
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
    //
    // Source AND event are both YAML-wins-when-present: the user's outer
    // `trigger:` block is the authoritative override and the graph node's
    // values are defaults to fall back on. A YAML `event: [opened,
    // synchronize]` against a graph node declaring `events: [opened]`
    // used to silently drop synchronize because the graph won the merge
    // — exactly the asymmetry that broke auto-PR-review on synchronize
    // events. Same shape for source.
    // Empty strings filter out: an `event: ''` YAML field is a deliberate
    // "no event filter" (existing tests use it to defer to the graph),
    // not a YAML-wins override. Same conceptually as `event:` being absent.
    const yamlEventList = toArray(wf.trigger?.event).filter((e) => e.length > 0);
    const merged: TriggerDefinition = {
        ...derived,
        ...wf.trigger,
        source: wf.trigger?.source ?? derived.source,
        event: yamlEventList.length > 0 ? yamlEventList : derived.event,
    };
    return { ...wf, trigger: merged, steps: wf.steps ?? [] };
}
