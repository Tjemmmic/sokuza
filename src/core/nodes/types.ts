import type { ActionContext, ActionHandler } from '../types.js';

// ─── Node graph storage ──────────────────────────────────────────────────────
//
// A NodeGraph is what the dashboard's visual editor produces and what the
// workflow runtime executes. It coexists with the legacy `steps:` form on
// `WorkflowDefinition`: if `graph` is set, it wins; otherwise the engine
// falls back to step-by-step execution. This lets every existing workflow
// keep working unchanged while new workflows are authored visually.

export interface GraphNode {
    /** Stable id within the graph — references in edges + templates. */
    id: string;
    /** Node type, e.g. "ai.review", "github.comment", "trigger.github". */
    type: string;
    /** Editor canvas position. Persisted so layouts survive reload. */
    position?: { x: number; y: number };
    /** User-supplied config values, keyed by config-port name. */
    config?: Record<string, unknown>;
    /** Optional condition string — node skips when this evaluates falsy. */
    condition?: string;
    /** Error policy for this node. Default: 'stop'. */
    on_error?: 'stop' | 'continue';
    /** Per-node timeout in seconds. */
    timeout?: number;
}

export interface GraphEdgeEnd {
    node: string;
    /** Port name on that node. */
    port: string;
}

export interface GraphEdge {
    /** Auto-generated id; primarily for the editor to address edges. */
    id?: string;
    from: GraphEdgeEnd;
    to: GraphEdgeEnd;
}

export interface NodeGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

// ─── Node definitions (the developer surface) ────────────────────────────────
//
// To add a feature: define a NodeDefinition. The dashboard palette, the
// inspector form, and the runtime executor are all driven from this single
// object. Adding a new GitHub action, a new control-flow primitive, or a
// new AI step is one file change — no coordinated edits across UI, schema,
// and runtime.

/** Coarse semantic class. Determines palette grouping and runtime treatment. */
export type NodeCategory = 'trigger' | 'action' | 'control';

/**
 * A port is either a `data` connection (wired from another node's output)
 * or a `config` field (user fills in the form). A port can be both: bind
 * to an upstream output if connected, else fall back to the config value.
 *
 * Ports are typed so the editor can suggest sensible connections (e.g. an
 * `ai-review` "result" output won't autoconnect to a "diff" input).
 */
export interface NodePort {
    name: string;
    label: string;
    /** Where this port's value comes from. */
    role: 'input' | 'output';
    /** Whether this input shows in the inspector form. */
    config?: boolean;
    /** Whether this input/output appears as a wire-able port on the canvas. */
    wire?: boolean;
    /** Semantic type — used for connection compatibility hints. */
    type?: 'string' | 'number' | 'boolean' | 'json' | 'pr' | 'issue'
         | 'review' | 'diff' | 'commits' | 'event' | 'any';
    required?: boolean;
    default?: unknown;
    placeholder?: string;
    helpText?: string;
    /** Form control (only relevant when `config: true`).
     *  - `ai-provider`: select sourced from `GET /api/ai/providers` at
     *    editor open. The empty option labels itself "Use default
     *    (currently: <X>)" so the override semantics are explicit
     *    instead of "blank text box that may or may not matter".
     *  - `ai-model`: text input whose placeholder shows the chosen
     *    provider's `default_model`, so the user has a starting point
     *    without us hardcoding a stale list of per-provider models. */
    control?: 'text' | 'textarea' | 'select' | 'switch' | 'number'
            | 'github-pr' | 'github-issue' | 'github-repo' | 'code-md'
            | 'code-yaml' | 'multiselect' | 'kv'
            | 'ai-provider' | 'ai-model';
    /** For `ai-model`: the name of the sibling port whose value selects
     *  which provider's default_model fills this field's placeholder.
     *  Defaults to `'provider'`. */
    providerPortName?: string;
    options?: Array<{ value: string; label: string }>;
    /** Named default the editor can load into a textarea port. Resolved
     *  via `GET /api/ai/defaults/:source` — see `actions/default-prompts.ts`.
     *  Only meaningful for `textarea`/`code-md` ports whose action consults
     *  a hardcoded TS default when the field is left blank (e.g. ai.review's
     *  system prompt). Without this hint the user has no way to see the
     *  text their workflow actually runs. */
    defaultSource?: string;
}

/** Runtime inputs handed to a node's execute(): map port → resolved value. */
export type NodeRuntimeInputs = Record<string, unknown>;
/** Runtime outputs returned by a node: map port → produced value. */
export type NodeRuntimeOutputs = Record<string, unknown>;

export interface NodeRuntimeContext extends ActionContext {
    /** Outputs of all nodes that have already executed (keyed by node id). */
    nodeOutputs: Record<string, NodeRuntimeOutputs>;
    /** The node currently being executed. */
    node: GraphNode;
    /** Action registry (so node executors can dispatch built-in actions). */
    actions: Map<string, ActionHandler>;
}

export type NodeExecutor = (
    inputs: NodeRuntimeInputs,
    ctx: NodeRuntimeContext,
) => Promise<NodeRuntimeOutputs>;

/**
 * Declarative recipe for adding extra output ports based on node config.
 * Lives in the serialized definition so the dashboard can render the
 * right ports without re-implementing trigger-specific logic. Two kinds:
 *
 *   - 'per-input': for the manual trigger. Reads `node.config.inputs` (a
 *     list of {name,label,type}) and adds one output port per entry.
 *
 *   - 'event-conditional': for source triggers. Adds the listed ports
 *     when *any* event in `node.config.events` matches one of `whenEvents`.
 */
export type DynamicOutputSpec =
    | { kind: 'per-input'; inputsConfigKey: string }
    | { kind: 'event-conditional'; eventsConfigKey: string; rules: Array<{ whenEvents: string[]; ports: NodePort[] }> };

export interface NodeDefinition {
    /** Unique node type, e.g. "github.fetch-diff" or "ai.review". */
    type: string;
    category: NodeCategory;
    /** Palette group label ("GitHub", "AI", "Notify", "Flow", "Triggers"). */
    group: string;
    /** Display title in palette + node card. */
    title: string;
    /** Short one-liner — shown in palette tooltip + node footer. */
    description: string;
    /** Emoji used as the node icon. */
    icon: string;
    /** Optional accent color for the node header (hex). */
    color?: string;
    /** All ports — both wired (data) and form (config). */
    ports: NodePort[];
    /** Optional config-driven additional output ports (see above). */
    dynamicOutputs?: DynamicOutputSpec[];
    /**
     * Runtime execution. May be omitted for trigger nodes — those have
     * their outputs synthesized from the inbound event by the runtime.
     */
    execute?: NodeExecutor;
    /**
     * For trigger nodes: derive the synthetic outputs from the incoming
     * event payload at the start of a run. The runtime calls this in
     * place of `execute`.
     */
    synthesizeFromEvent?: (
        node: GraphNode,
        ctx: ActionContext,
    ) => NodeRuntimeOutputs;
}

/** Serialized node-definition shape sent to the dashboard via /api/nodes. */
export interface SerializedNodeDefinition {
    type: string;
    category: NodeCategory;
    group: string;
    title: string;
    description: string;
    icon: string;
    color?: string;
    ports: NodePort[];
    dynamicOutputs?: DynamicOutputSpec[];
}

export function serializeNodeDefinition(def: NodeDefinition): SerializedNodeDefinition {
    return {
        type: def.type,
        category: def.category,
        group: def.group,
        title: def.title,
        description: def.description,
        icon: def.icon,
        color: def.color,
        ports: def.ports,
        dynamicOutputs: def.dynamicOutputs,
    };
}

/**
 * Runtime helper: resolve all output ports for a node — the static ones
 * declared in its definition plus any dynamic ports its config has unlocked.
 *
 * KEEP IN SYNC WITH dashboard/graph-logic.js resolveWireableOutputPorts /
 * eventGlobMatch / portTypeForInputType — the editor mirrors this logic for
 * rendering. src/__tests__/graph-editor-logic.test.ts fails if they diverge.
 */
export function resolveOutputPorts(def: NodeDefinition, nodeConfig: Record<string, unknown> | undefined): NodePort[] {
    const ports: NodePort[] = [];
    for (const p of def.ports) {
        if (p.role === 'output') ports.push(p);
    }
    if (!def.dynamicOutputs || !nodeConfig) return ports;

    for (const spec of def.dynamicOutputs) {
        if (spec.kind === 'per-input') {
            const list = nodeConfig[spec.inputsConfigKey];
            if (Array.isArray(list)) {
                for (const item of list) {
                    if (!item || typeof item !== 'object') continue;
                    const entry = item as Record<string, unknown>;
                    const name = typeof entry.name === 'string' ? entry.name : '';
                    if (!name) continue;
                    if (ports.some((p) => p.name === name)) continue;
                    ports.push({
                        name,
                        label: typeof entry.label === 'string' && entry.label ? entry.label : name,
                        role: 'output',
                        wire: true,
                        type: portTypeForInputType(entry.type as string | undefined),
                        helpText: `User-defined input: ${name}`,
                    });
                }
            }
        } else if (spec.kind === 'event-conditional') {
            const events = nodeConfig[spec.eventsConfigKey];
            const eventList = Array.isArray(events) ? events.filter((e) => typeof e === 'string') as string[] : [];
            for (const rule of spec.rules) {
                if (!rule.whenEvents.some((we) => eventList.some((e) => matchEventGlob(we, e)))) continue;
                for (const p of rule.ports) {
                    if (ports.some((existing) => existing.name === p.name)) continue;
                    ports.push(p);
                }
            }
        }
    }
    return ports;
}

function portTypeForInputType(t: string | undefined): NodePort['type'] {
    switch (t) {
        case 'github-pr': return 'pr';
        case 'github-issue': return 'issue';
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        case 'github-branch':
        case 'github-repo':
        case 'text':
        case 'textarea':
        case 'select':
        default:
            return 'string';
    }
}

/** "pull_request.*" matches "pull_request.opened" / "pull_request.closed" etc. */
function matchEventGlob(pattern: string, value: string): boolean {
    if (pattern === value) return true;
    if (!pattern.includes('*')) return false;
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(value);
}
