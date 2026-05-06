import type { Logger } from 'pino';
import type {
    ActionContext,
    ActionHandler,
    EventPayload,
    IntegrationConfig,
} from '../types.js';
import type { AIProviderRegistry } from '../ai-providers.js';
import { loadAIProviders } from '../ai-providers.js';
import type {
    GraphNode,
    NodeGraph,
    NodeRuntimeContext,
    NodeRuntimeOutputs,
} from './types.js';
import type { NodeRegistry } from './registry.js';
import { isStringTruthy } from './truthy.js';

// ─── Graph execution ─────────────────────────────────────────────────────────
//
// Topo-sort the graph, then run each layer (nodes whose deps are satisfied)
// in parallel. Per-node inputs are resolved by walking incoming edges and
// substituting upstream output values; missing connections fall back to the
// node's `config[port]` (with templating). Outputs go into nodeOutputs and
// are also exposed under `steps[node.id]` so existing template syntax keeps
// working in workflows that mix-and-match.

export interface GraphExecutionResult {
    /** Per-node output maps, keyed by node id. */
    nodeOutputs: Record<string, NodeRuntimeOutputs>;
    /** Flattened "steps" view — one entry per node id, value = primary output
     *  (the whole NodeRuntimeOutputs object). Mirrors the legacy `steps:`
     *  shape the dashboard already understands. */
    steps: Record<string, unknown>;
    /** Index-keyed mirror, ordered by topological execution order. */
    results: Record<number, unknown>;
}

interface ExecuteGraphOptions {
    workflowName?: string;
    integrationConfigs?: Record<string, IntegrationConfig>;
    ai?: AIProviderRegistry;
    recordWebhookDelivery?: ActionContext['recordWebhookDelivery'];
    workdirManager?: ActionContext['workdirManager'];
    getConfig?: ActionContext['getConfig'];
    signal?: AbortSignal;
}

export async function executeGraph(
    graph: NodeGraph,
    event: EventPayload,
    actionRegistry: Map<string, ActionHandler>,
    nodeRegistry: NodeRegistry,
    logger: Logger,
    opts: ExecuteGraphOptions = {},
): Promise<GraphExecutionResult> {
    const ai = opts.ai ?? loadAIProviders(undefined);
    const integrationConfigs = opts.integrationConfigs ?? {};

    // Validate every node has a registered definition before we start.
    for (const node of graph.nodes) {
        if (!nodeRegistry.has(node.type)) {
            throw new Error(
                `Node "${node.id}" references unknown type "${node.type}". ` +
                `Register the type or remove the node.`,
            );
        }
    }

    const layers = toposortLayers(graph);

    const nodeOutputs: Record<string, NodeRuntimeOutputs> = {};
    const stepsView: Record<string, unknown> = {};
    const indexResults: Record<number, unknown> = {};
    let executionIndex = 0;

    logger.info(
        { workflow: opts.workflowName, nodes: graph.nodes.length, layers: layers.length },
        'Executing graph workflow',
    );

    for (const layer of layers) {
        if (opts.signal?.aborted) {
            throw new Error('Workflow aborted');
        }

        // Run all nodes in this layer concurrently. fail-fast on first
        // rejection unless a node opts into on_error: continue.
        const settled = await Promise.allSettled(
            layer.map((node) =>
                runNode(node, {
                    graph,
                    event,
                    actionRegistry,
                    nodeRegistry,
                    nodeOutputs,
                    stepsView,
                    integrationConfigs,
                    ai,
                    logger,
                    signal: opts.signal,
                    workflowName: opts.workflowName,
                    recordWebhookDelivery: opts.recordWebhookDelivery,
                    workdirManager: opts.workdirManager,
                    getConfig: opts.getConfig,
                }),
            ),
        );

        let firstError: { reason: unknown; node: GraphNode } | null = null;

        for (let i = 0; i < settled.length; i++) {
            const node = layer[i];
            const outcome = settled[i];
            if (outcome.status === 'rejected') {
                if (node.on_error === 'continue') {
                    logger.warn(
                        { workflow: opts.workflowName, node: node.id, err: outcome.reason },
                        'Node failed (on_error=continue)',
                    );
                    // Preserve the structured Error info so downstream
                    // nodes that wire from {{nodes.<id>.__error}} get the
                    // clean message (not "Error: msg"), and a wired
                    // {{nodes.<id>.__errorStack}} surfaces the stack for
                    // diagnostics. Falls back to String() for thrown
                    // non-Error values (strings, plain objects).
                    nodeOutputs[node.id] = serializeContinueError(outcome.reason);
                    continue;
                }
                if (!firstError) firstError = { reason: outcome.reason, node };
            } else {
                nodeOutputs[node.id] = outcome.value;
                stepsView[node.id] = outcome.value;
                indexResults[executionIndex++] = outcome.value;
            }
        }

        if (firstError) {
            const msg = firstError.reason instanceof Error
                ? firstError.reason.message
                : String(firstError.reason);
            throw new Error(`Node "${firstError.node.id}" (${firstError.node.type}) failed: ${msg}`);
        }

        // A node with on_error=continue swallows its own rejection — even
        // when that rejection was an abort. Catch the swallow here so an
        // aborted run can't appear "successful" just because every aborted
        // node opted into continue-on-failure semantics.
        if (opts.signal?.aborted) {
            throw new Error('Workflow aborted');
        }
    }

    logger.info({ workflow: opts.workflowName }, 'Graph workflow completed');
    return { nodeOutputs, steps: stepsView, results: indexResults };
}

interface RunNodeDeps {
    graph: NodeGraph;
    event: EventPayload;
    actionRegistry: Map<string, ActionHandler>;
    nodeRegistry: NodeRegistry;
    nodeOutputs: Record<string, NodeRuntimeOutputs>;
    stepsView: Record<string, unknown>;
    integrationConfigs: Record<string, IntegrationConfig>;
    ai: AIProviderRegistry;
    logger: Logger;
    workflowName?: string;
    recordWebhookDelivery?: ActionContext['recordWebhookDelivery'];
    workdirManager?: ActionContext['workdirManager'];
    getConfig?: ActionContext['getConfig'];
    signal?: AbortSignal;
}

async function runNode(node: GraphNode, deps: RunNodeDeps): Promise<NodeRuntimeOutputs> {
    const def = deps.nodeRegistry.get(node.type)!;
    const baseCtx: ActionContext = {
        event: deps.event,
        results: {},
        steps: deps.stepsView,
        integrationConfigs: deps.integrationConfigs,
        ai: deps.ai,
        logger: deps.logger,
        signal: deps.signal,
        workflowName: deps.workflowName,
        recordWebhookDelivery: deps.recordWebhookDelivery,
        workdirManager: deps.workdirManager,
        getConfig: deps.getConfig,
    };

    // Resolve every input port — wired ports take priority over config
    // fallbacks. Templating runs against the same context as legacy steps,
    // plus a {{nodes.<id>.<port>}} alias.
    const inputs = resolveNodeInputs(node, deps);

    // Conditions evaluate against the resolved input bag + ambient context.
    if (node.condition && !evalCondition(node.condition, baseCtx, deps.nodeOutputs)) {
        deps.logger.info(
            { workflow: deps.workflowName, node: node.id, condition: node.condition },
            'Node condition is falsy, skipping',
        );
        return {};
    }

    if (def.category === 'trigger') {
        // Trigger nodes don't execute — their outputs come from the event.
        const synth = def.synthesizeFromEvent
            ? def.synthesizeFromEvent(node, baseCtx)
            : defaultTriggerOutputs(node, deps.event);
        return synth;
    }

    if (!def.execute) {
        throw new Error(`Node type "${def.type}" has no execute() and is not a trigger`);
    }

    const ctx: NodeRuntimeContext = {
        ...baseCtx,
        nodeOutputs: deps.nodeOutputs,
        node,
        actions: deps.actionRegistry,
    };

    const exec = def.execute(inputs, ctx);
    // Race the node against (a) its own timeout and (b) the workflow-level
    // abort signal. Both produce a rejection that unblocks the workflow
    // even if the underlying handler keeps doing async work in the
    // background — we lose the ability to observe its eventual completion
    // but the workflow no longer hangs.
    const result = await withTimeoutAndSignal(
        exec,
        node.timeout,
        deps.signal,
        `Node ${node.id} (${node.type}) timed out`,
    );
    return result ?? {};
}

/** Build the output bag for a node that failed under on_error=continue.
 *  Error objects contribute a clean .message and .stack (and .name when
 *  it isn't the bare 'Error') so callers can distinguish error classes
 *  without re-parsing string prefixes. Anything else falls back to
 *  String() for backward compatibility with handlers that throw plain
 *  values. */
function serializeContinueError(reason: unknown): NodeRuntimeOutputs {
    if (reason instanceof Error) {
        const out: NodeRuntimeOutputs = { __error: reason.message };
        if (reason.stack) out.__errorStack = reason.stack;
        if (reason.name && reason.name !== 'Error') out.__errorName = reason.name;
        return out;
    }
    return { __error: String(reason) };
}

/**
 * Synthesize the output bag a trigger node exposes to downstream wires.
 * Returns the always-present base outputs plus values matching the node's
 * dynamic output ports (per-input fan-out for the manual trigger,
 * event-derived fields for github triggers, etc.) so a wire that targets
 * a derived port resolves to a real value at execution time.
 */
function defaultTriggerOutputs(node: import('./types.js').GraphNode, event: EventPayload): NodeRuntimeOutputs {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    const out: NodeRuntimeOutputs = { event, payload, metadata: meta };

    // Manual triggers: spread user inputs onto top-level output ports.
    const inputs = (payload.inputs as Record<string, unknown>) ?? {};
    out.inputs = inputs;
    for (const [k, v] of Object.entries(inputs)) {
        if (out[k] === undefined) out[k] = v;
    }

    // GitHub-flavored derivations.
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (pr) {
        out.pr = pr;
        if (pr.number !== undefined) out.prNumber = pr.number;
        const head = pr.head as Record<string, unknown> | undefined;
        if (head?.ref) out.branch = head.ref;
        const user = pr.user as Record<string, unknown> | undefined;
        if (user?.login) out.author = user.login;
    }
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (issue) {
        out.issue = issue;
        if (issue.number !== undefined) out.issueNumber = issue.number;
        const user = issue.user as Record<string, unknown> | undefined;
        if (user?.login && out.author === undefined) out.author = user.login;
    }
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (comment) {
        out.comment = comment;
        if (typeof comment.body === 'string') out.commentBody = comment.body;
    }
    const review = payload.review as Record<string, unknown> | undefined;
    if (review) out.review = review;

    if (typeof meta.repo === 'string') out.repo = meta.repo;

    // Manual-trigger output names should win when a user has picked a name
    // that collides with a synthesized field — keep the explicit input value.
    return out;
}

function withTimeoutAndSignal<T>(
    promise: Promise<T>,
    seconds: number | undefined,
    signal: AbortSignal | undefined,
    timeoutMessage: string,
): Promise<T> {
    const hasTimeout = !!(seconds && seconds > 0);
    if (!hasTimeout && !signal) return promise;
    return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        // Single cleanup point for both timer + listener — every settle
        // path (timeout fire, abort fire, underlying promise settle) goes
        // through finish() exactly once, so there's no listener leak even
        // when a long-lived workflow signal outlives many nodes.
        let settled = false;
        const finish = (cb: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            cb();
        };

        if (hasTimeout) {
            timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), seconds! * 1000);
        }

        const onAbort = signal
            ? () => finish(() => reject(new Error('Workflow aborted')))
            : null;
        if (signal) {
            if (signal.aborted) { onAbort!(); return; }
            signal.addEventListener('abort', onAbort!, { once: true });
        }

        promise.then(
            (v) => finish(() => resolve(v)),
            (e) => finish(() => reject(e)),
        );
    });
}

// ─── Input resolution ────────────────────────────────────────────────────────

function resolveNodeInputs(node: GraphNode, deps: RunNodeDeps): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    const def = deps.nodeRegistry.get(node.type)!;

    // Index incoming edges by target port name.
    const incomingByPort = new Map<string, { from: string; port: string }>();
    for (const edge of deps.graph.edges) {
        if (edge.to.node === node.id) {
            incomingByPort.set(edge.to.port, { from: edge.from.node, port: edge.from.port });
        }
    }

    const interpolationCtx: InterpolationContext = {
        event: deps.event,
        steps: deps.stepsView,
        nodes: deps.nodeOutputs,
        // `inputs` is the convenience alias for {{event.payload.inputs.x}}.
        inputs: ((deps.event.payload as Record<string, unknown>)?.inputs as Record<string, unknown>) ?? {},
    };

    for (const port of def.ports) {
        if (port.role !== 'input') continue;

        // Wire wins over config.
        const incoming = incomingByPort.get(port.name);
        if (incoming) {
            const upstream = deps.nodeOutputs[incoming.from];
            if (upstream && incoming.port in upstream) {
                inputs[port.name] = upstream[incoming.port];
                continue;
            }
        }

        const raw = node.config?.[port.name] ?? port.default;
        inputs[port.name] = interpolateValue(raw, interpolationCtx);
    }

    return inputs;
}

interface InterpolationContext {
    event: EventPayload;
    steps: Record<string, unknown>;
    nodes: Record<string, unknown>;
    inputs: Record<string, unknown>;
}

const ALLOWED_PREFIXES = ['event.', 'results.', 'steps.', 'nodes.', 'metadata.', 'inputs.'];

// Hard cap on interpolation recursion. Real configs are 1–3 levels deep
// (a KV map, a list of {name,label,type} objects). 16 is well above any
// legitimate use and protects against pathological / cyclic inputs that
// could blow the call stack — defense in depth, since node configs are
// user-authored YAML and we want a defined termination either way.
const MAX_INTERPOLATION_DEPTH = 16;

function interpolateValue(value: unknown, ctx: InterpolationContext, depth = 0): unknown {
    // Bail without recursing further. Returning the value as-is leaves
    // the deeply-nested subtree intact; the workflow keeps running. The
    // alternative — throwing — would surface the issue more loudly but
    // also kill the run mid-step, which is worse for legitimate-but-
    // unusual configs (e.g. a serialized JSON tree mistakenly inlined).
    if (depth > MAX_INTERPOLATION_DEPTH) return value;
    if (typeof value === 'string') {
        return interpolateString(value, ctx);
    }
    if (Array.isArray(value)) {
        return value.map((v) => interpolateValue(v, ctx, depth + 1));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = interpolateValue(v, ctx, depth + 1);
        }
        return out;
    }
    return value;
}

function interpolateString(template: string, ctx: InterpolationContext): string {
    return template.replace(/\{\{(.+?)\}\}/g, (match, path: string) => {
        const trimmed = path.trim();
        // Anything outside the known prefixes is left intact — a typo
        // like `{{ndoes.review.sha}}` stays visible in logs and downstream
        // string compares instead of silently becoming "", and literal
        // `{{...}}` in user-authored content (Markdown handlebars
        // examples, JSX snippets, doc bodies that legitimately mention
        // template syntax) round-trips unchanged. Recognised-but-empty
        // refs still resolve to "" so a missing optional value doesn't
        // pollute output with placeholder text.
        if (!ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p))) return match;
        // `inputs.x` is sugar for `event.payload.inputs.x` — same as the
        // legacy executor, so authors can mix node + step references.
        const resolvedPath = trimmed.startsWith('inputs.')
            ? `event.payload.${trimmed}`
            : trimmed;
        const v = resolvePath(ctx, resolvedPath);
        return v !== undefined && v !== null ? String(v) : '';
    });
}

function resolvePath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const part of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

function evalCondition(
    expr: string,
    ctx: ActionContext,
    nodeOutputs: Record<string, unknown>,
): boolean {
    const interpolated = interpolateString(expr, {
        event: ctx.event,
        steps: ctx.steps,
        nodes: nodeOutputs,
        inputs: ((ctx.event.payload as Record<string, unknown>)?.inputs as Record<string, unknown>) ?? {},
    });
    return isStringTruthy(interpolated);
}

// ─── Topological sort into parallel layers ───────────────────────────────────
//
// Kahn-style: each layer is the set of nodes whose remaining in-degree is
// zero. Yields fail-fast parallel execution per layer — the same semantics
// as the legacy `run: parallel` step grouping but inferred from the graph.

export function toposortLayers(graph: NodeGraph): GraphNode[][] {
    const inDegree = new Map<string, number>();
    const childrenOf = new Map<string, string[]>();
    const nodeById = new Map<string, GraphNode>();

    for (const n of graph.nodes) {
        inDegree.set(n.id, 0);
        childrenOf.set(n.id, []);
        nodeById.set(n.id, n);
    }
    for (const e of graph.edges) {
        // Edges pointing at a node id that doesn't exist are almost
        // always a YAML typo (e.g. {from: {node: "triger", ...}}). The
        // editor's delete-node path scrubs them, so they only appear in
        // hand-authored configs — fail loud rather than silently produce
        // a graph that's missing the wire the author intended.
        if (!nodeById.has(e.from.node)) {
            throw new Error(
                `Edge references unknown source node "${e.from.node}" (port "${e.from.port}" → "${e.to.node}.${e.to.port}"). Check for a typo or a stale edge.`,
            );
        }
        if (!nodeById.has(e.to.node)) {
            throw new Error(
                `Edge references unknown destination node "${e.to.node}" (from "${e.from.node}.${e.from.port}" → port "${e.to.port}"). Check for a typo or a stale edge.`,
            );
        }
        // Self-loops are silently ignored — they'd deadlock the toposort.
        if (e.from.node === e.to.node) continue;
        inDegree.set(e.to.node, (inDegree.get(e.to.node) ?? 0) + 1);
        childrenOf.get(e.from.node)!.push(e.to.node);
    }

    // ── Implicit dependencies from {{nodes.X.Y}} / {{steps.X.Y}} refs ──
    //
    // The toposort needs to know that a node which interpolates
    // `{{nodes.review.markdown}}` in its config can only run after
    // `review` produces output. Without this, hand-authored YAML where
    // the referenced node lacks an explicit edge to the consumer would
    // run in the wrong layer — interpolation resolves to "" because the
    // upstream output isn't there yet, and the consumer silently uses
    // empty values. Explicit edges remain the source of truth for
    // wiring data into ports; implicit ones only constrain ORDER.
    const seenEdge = new Set<string>();
    for (const e of graph.edges) seenEdge.add(`${e.from.node}|${e.to.node}`);
    for (const node of graph.nodes) {
        const refs = collectNodeRefs(node);
        for (const ref of refs) {
            if (ref === node.id) continue;          // self-ref → ignore
            if (!nodeById.has(ref)) continue;        // dangling → leave alone
            const key = `${ref}|${node.id}`;
            if (seenEdge.has(key)) continue;         // already an explicit edge
            seenEdge.add(key);
            inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
            childrenOf.get(ref)!.push(node.id);
        }
    }

    const layers: GraphNode[][] = [];
    let frontier = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);

    while (frontier.length > 0) {
        layers.push(frontier);
        const nextFrontier: GraphNode[] = [];
        for (const n of frontier) {
            for (const childId of childrenOf.get(n.id) ?? []) {
                const remaining = (inDegree.get(childId) ?? 0) - 1;
                inDegree.set(childId, remaining);
                if (remaining === 0) {
                    const child = nodeById.get(childId);
                    if (child) nextFrontier.push(child);
                }
            }
        }
        frontier = nextFrontier;
    }

    // Anything left in inDegree > 0 is part of a cycle.
    const stuck = [...inDegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    if (stuck.length > 0) {
        throw new Error(`Graph contains a cycle through nodes: ${stuck.join(', ')}`);
    }

    return layers;
}

/** Find every node id this node references via `{{nodes.<id>.…}}` or
 *  `{{steps.<id>.…}}` in its config, condition, or any nested string.
 *  These references are resolved at runtime against the upstream node's
 *  output bag, so the producing node must run first. Used by the
 *  toposort to add implicit ordering constraints that the explicit edge
 *  list might omit. */
function collectNodeRefs(node: GraphNode): Set<string> {
    const refs = new Set<string>();
    collectNodeRefsFromString(node.condition, refs);
    if (node.config) {
        for (const v of Object.values(node.config)) collectNodeRefsFromValue(v, refs);
    }
    return refs;
}

function collectNodeRefsFromValue(value: unknown, out: Set<string>): void {
    if (typeof value === 'string') {
        collectNodeRefsFromString(value, out);
    } else if (Array.isArray(value)) {
        for (const v of value) collectNodeRefsFromValue(v, out);
    } else if (value && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
            collectNodeRefsFromValue(v, out);
        }
    }
}

const NODE_REF_RE = /\{\{\s*(?:nodes|steps)\.([A-Za-z0-9_-]+)\b/g;

function collectNodeRefsFromString(value: string | undefined, out: Set<string>): void {
    if (!value) return;
    for (const m of value.matchAll(NODE_REF_RE)) {
        out.add(m[1]);
    }
}
