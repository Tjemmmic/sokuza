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
                    nodeOutputs[node.id] = { __error: String(outcome.reason) };
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
            : defaultTriggerOutputs(deps.event);
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
    const result = await withTimeout(exec, node.timeout, `Node ${node.id} (${node.type}) timed out`);
    return result ?? {};
}

function defaultTriggerOutputs(event: EventPayload): NodeRuntimeOutputs {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return {
        event,
        payload,
        metadata: event.metadata ?? {},
        inputs: (payload.inputs as Record<string, unknown>) ?? {},
        pr: payload.pull_request,
        issue: payload.issue,
        comment: payload.comment,
        review: payload.review,
    };
}

function withTimeout<T>(promise: Promise<T>, seconds: number | undefined, message: string): Promise<T> {
    if (!seconds || seconds <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), seconds * 1000);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
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

function interpolateValue(value: unknown, ctx: InterpolationContext): unknown {
    if (typeof value === 'string') {
        return interpolateString(value, ctx);
    }
    if (Array.isArray(value)) {
        return value.map((v) => interpolateValue(v, ctx));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = interpolateValue(v, ctx);
        }
        return out;
    }
    return value;
}

function interpolateString(template: string, ctx: InterpolationContext): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
        const trimmed = path.trim();
        if (!ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p))) return '';
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
    return interpolated !== '' && interpolated !== 'false' && interpolated !== '0' && interpolated !== 'undefined' && interpolated !== 'null';
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
        if (!nodeById.has(e.from.node) || !nodeById.has(e.to.node)) continue;
        // Self-loops are silently ignored — they'd deadlock the toposort.
        if (e.from.node === e.to.node) continue;
        inDegree.set(e.to.node, (inDegree.get(e.to.node) ?? 0) + 1);
        childrenOf.get(e.from.node)!.push(e.to.node);
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
