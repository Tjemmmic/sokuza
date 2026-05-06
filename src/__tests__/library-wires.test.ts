import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { getNodeRegistry, resetNodeRegistry } from '../core/nodes/registry.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';
import { resolveOutputPorts } from '../core/nodes/types.js';
import type { NodeGraph, NodePort, NodeDefinition } from '../core/nodes/types.js';

// Static wire validator: every edge in every library template must
// connect (a) a real source output port to (b) a real destination input
// port, and the declared port types must be compatible.
//
// The runtime tolerates wiring to a port that doesn't exist (the input
// just resolves to undefined) — useful flexibility but a silent
// footgun. This test catches those plus type mismatches the editor's
// connection-suggestion logic would also reject.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TEMPLATE_DIRS = [
    join(REPO_ROOT, 'templates'),
    join(REPO_ROOT, 'templates', 'library'),
];

interface LoadedTemplate {
    name: string;
    graph: NodeGraph;
}

function loadGraphTemplates(): LoadedTemplate[] {
    const out: LoadedTemplate[] = [];
    const seen = new Set<string>();
    for (const dir of TEMPLATE_DIRS) {
        let files: string[];
        try { files = readdirSync(dir); }
        catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
            const name = f.replace(/\.ya?ml$/, '');
            if (seen.has(name)) continue;
            seen.add(name);
            const content = readFileSync(join(dir, f), 'utf-8');
            const parsed = (yaml.load(content) ?? {}) as Record<string, unknown>;
            const graph = parsed.graph as NodeGraph | undefined;
            if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) continue;
            out.push({ name, graph });
        }
    }
    return out;
}

const STRUCTURAL_TYPES = new Set(['pr', 'issue', 'review', 'commits', 'event', 'json']);

/** Compatibility rules — generous enough to allow legit wires, strict
 *  enough to catch the mistakes I just had to fix manually. */
function typesCompatible(src: NodePort['type'], dst: NodePort['type']): boolean {
    if (!src || !dst) return true;          // unannotated — pass
    if (src === dst) return true;
    if (src === 'any' || dst === 'any') return true;
    // json sinks accept any structural object
    if (dst === 'json' && STRUCTURAL_TYPES.has(src)) return true;
    if (src === 'json' && STRUCTURAL_TYPES.has(dst)) return true;
    // string coercion is automatic at interpolation time — allow scalars
    // either direction.
    const SCALAR = new Set(['string', 'number', 'boolean']);
    if (SCALAR.has(src) && SCALAR.has(dst)) return true;
    // diff is a kind of string for downstream consumers
    if (src === 'diff' && dst === 'string') return true;
    return false;
}

interface ResolvedNodePorts {
    inputs: Map<string, NodePort>;
    outputs: Map<string, NodePort>;
    type: string;
}

function resolvePortsForNode(
    nodeType: string,
    nodeConfig: Record<string, unknown> | undefined,
    def: NodeDefinition | undefined,
): ResolvedNodePorts {
    const inputs = new Map<string, NodePort>();
    const outputs = new Map<string, NodePort>();
    if (!def) return { inputs, outputs, type: nodeType };
    for (const p of def.ports) {
        if (p.role === 'input') inputs.set(p.name, p);
    }
    for (const p of resolveOutputPorts(def, nodeConfig)) {
        outputs.set(p.name, p);
    }
    return { inputs, outputs, type: nodeType };
}

beforeAll(() => {
    resetNodeRegistry();
    registerBuiltinNodes(getNodeRegistry());
});

describe('library template wire validation', () => {
    const templates = loadGraphTemplates();

    it.each(templates)('$name has well-typed wires', ({ name, graph }) => {
        // Resolve the registry inside the test — resetNodeRegistry() in
        // beforeAll replaces the singleton, so we'd get an empty registry
        // if we captured the reference at describe time.
        const registry = getNodeRegistry();
        const portsByNode = new Map<string, ResolvedNodePorts>();
        for (const n of graph.nodes) {
            const def = registry.get(n.type);
            portsByNode.set(n.id, resolvePortsForNode(n.type, n.config, def));
        }

        const errors: string[] = [];
        for (const edge of graph.edges) {
            const srcPorts = portsByNode.get(edge.from.node);
            const dstPorts = portsByNode.get(edge.to.node);
            if (!srcPorts) {
                errors.push(`edge from missing node ${edge.from.node}`);
                continue;
            }
            if (!dstPorts) {
                errors.push(`edge to missing node ${edge.to.node}`);
                continue;
            }
            const srcPort = srcPorts.outputs.get(edge.from.port);
            // __seq is a synthetic sequencing port — runtime accepts it
            // on any destination to express "run after" without data flow.
            const isSeq = edge.to.port === '__seq';
            const dstPort = isSeq ? undefined : dstPorts.inputs.get(edge.to.port);

            if (!srcPort) {
                errors.push(
                    `edge ${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}: source port "${edge.from.port}" not found on ${srcPorts.type}`,
                );
                continue;
            }
            if (!dstPort && !isSeq) {
                errors.push(
                    `edge ${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}: destination port "${edge.to.port}" not found on ${dstPorts.type}`,
                );
                continue;
            }
            if (dstPort && !typesCompatible(srcPort.type, dstPort.type)) {
                errors.push(
                    `edge ${edge.from.node}.${edge.from.port}(${srcPort.type}) → ${edge.to.node}.${edge.to.port}(${dstPort.type}): incompatible types`,
                );
            }
        }

        expect(errors, `${name}:\n  ${errors.join('\n  ')}`).toEqual([]);
    });
});
