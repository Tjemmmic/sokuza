import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { executeGraph, toposortLayers } from './runtime.js';
import { NodeRegistry } from './registry.js';
import type { ActionHandler, EventPayload } from '../types.js';
import type { NodeDefinition, NodeGraph } from './types.js';

const noopLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function evt(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: {},
        ...overrides,
    };
}

const triggerDef: NodeDefinition = {
    type: 'trigger.github',
    category: 'trigger',
    group: 'Triggers',
    title: 'GitHub',
    description: 'Trigger',
    icon: '🐙',
    ports: [
        { name: 'pr', label: 'PR', role: 'output', wire: true },
        { name: 'event', label: 'Event', role: 'output', wire: true },
    ],
};

function actionDef(type: string, action: string, ports: NodeDefinition['ports']): NodeDefinition {
    return {
        type, category: 'action', group: 'Test', title: type, description: '', icon: '⚙️',
        ports,
        execute: async (inputs, ctx) => {
            const handler = ctx.actions.get(action);
            if (!handler) throw new Error(`missing action ${action}`);
            const result = await handler(inputs, ctx);
            return result && typeof result === 'object'
                ? { ...(result as Record<string, unknown>), result }
                : { result };
        },
    };
}

let registry: NodeRegistry;
let actions: Map<string, ActionHandler>;

beforeEach(() => {
    registry = new NodeRegistry();
    registry.register(triggerDef);
    actions = new Map();
});

describe('toposortLayers', () => {
    it('emits nodes in dependency order', () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'a', type: 'trigger.github' },
                { id: 'b', type: 'trigger.github' },
                { id: 'c', type: 'trigger.github' },
            ],
            edges: [
                { from: { node: 'a', port: 'event' }, to: { node: 'b', port: 'pr' } },
                { from: { node: 'b', port: 'event' }, to: { node: 'c', port: 'pr' } },
            ],
        };
        const layers = toposortLayers(graph);
        expect(layers.length).toBe(3);
        expect(layers[0].map((n) => n.id)).toEqual(['a']);
        expect(layers[1].map((n) => n.id)).toEqual(['b']);
        expect(layers[2].map((n) => n.id)).toEqual(['c']);
    });

    it('groups independent nodes into the same layer', () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'a', type: 'trigger.github' },
                { id: 'b', type: 'trigger.github' },
                { id: 'c', type: 'trigger.github' },
            ],
            edges: [
                { from: { node: 'a', port: 'event' }, to: { node: 'c', port: 'pr' } },
            ],
        };
        const layers = toposortLayers(graph);
        expect(layers[0].map((n) => n.id).sort()).toEqual(['a', 'b']);
        expect(layers[1].map((n) => n.id)).toEqual(['c']);
    });

    it('throws on cycles', () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'a', type: 'trigger.github' },
                { id: 'b', type: 'trigger.github' },
            ],
            edges: [
                { from: { node: 'a', port: 'x' }, to: { node: 'b', port: 'y' } },
                { from: { node: 'b', port: 'x' }, to: { node: 'a', port: 'y' } },
            ],
        };
        expect(() => toposortLayers(graph)).toThrow(/cycle/);
    });
});

describe('executeGraph', () => {
    it('runs a single trigger workflow with synthesized outputs', async () => {
        const graph: NodeGraph = {
            nodes: [{ id: 'trig', type: 'trigger.github' }],
            edges: [],
        };
        const event = evt({ payload: { pull_request: { number: 42 } } });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.trig.pr).toEqual({ number: 42 });
        expect(result.nodeOutputs.trig.event).toBe(event);
    });

    it('threads upstream outputs through wired ports', async () => {
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));

        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'echo1', type: 'test.echo', config: { value: 'hello' } },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.echo1).toMatchObject({ echoed: 'hello' });
    });

    it('substitutes {{nodes.<id>.<port>}} in config', async () => {
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'test.echo', config: { value: 'first' } },
                { id: 'b', type: 'test.echo', config: { value: '{{nodes.a.echoed}} → second' } },
            ],
            edges: [
                { from: { node: 'trig', port: 'event' }, to: { node: 'a', port: '__seq' } },
                { from: { node: 'a', port: 'echoed' }, to: { node: 'b', port: '__seq' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.b.echoed).toBe('first → second');
    });

    it('honors on_error: continue', async () => {
        actions.set('boom', async () => { throw new Error('kaboom'); });
        registry.register(actionDef('test.boom', 'boom', [
            { name: 'result', role: 'output', label: 'Result', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'b', type: 'test.boom', on_error: 'continue' },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.b).toMatchObject({ __error: expect.stringContaining('kaboom') });
    });

    it('on_error=continue mirrors the error into steps/results, not just nodeOutputs', async () => {
        // A continue-failed node still executed: {{steps.<id>}} and
        // {{results.N}} must agree with {{nodes.<id>}} for that node, and a
        // downstream node reading the legacy steps.<id> syntax must see it.
        actions.set('boom', async () => { throw new Error('kaboom'); });
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.boom', 'boom', [
            { name: 'result', role: 'output', label: 'Result', wire: true },
        ]));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'b', type: 'test.boom', on_error: 'continue' },
                { id: 'c', type: 'test.echo', config: { value: 'saw: {{steps.b.__error}}' } },
            ],
            edges: [
                { from: { node: 'b', port: 'result' }, to: { node: 'c', port: '__seq' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.steps.b).toEqual(result.nodeOutputs.b);
        expect(result.steps.b).toMatchObject({ __error: 'kaboom' });
        expect(Object.values(result.results)).toContainEqual(result.nodeOutputs.b);
        expect(result.nodeOutputs.c.echoed).toBe('saw: kaboom');
    });

    it('template path traversal stops at __proto__/constructor (renders empty)', async () => {
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'test.echo', config: { value: 'real' } },
                {
                    id: 'b', type: 'test.echo',
                    config: { value: 'x[{{nodes.a.__proto__}}][{{nodes.a.constructor}}][{{nodes.a.echoed}}]' },
                },
            ],
            edges: [
                { from: { node: 'a', port: 'echoed' }, to: { node: 'b', port: '__seq' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        // Prototype keys resolve like any missing ref (""), the real port still works.
        expect(result.nodeOutputs.b.echoed).toBe('x[][][real]');
    });

    it('on_error=continue preserves the message, stack, and class name of Error objects', async () => {
        // String(new TypeError("x")) -> "TypeError: x" — usable but
        // throws away .stack and .name. Downstream wires that pluck
        // {{nodes.<id>.__errorStack}} for diagnostics need the structured
        // form.
        class MyError extends Error {
            constructor(msg: string) { super(msg); this.name = 'MyError'; }
        }
        actions.set('boom', async () => { throw new MyError('boom-msg'); });
        registry.register(actionDef('test.boom', 'boom', [
            { name: 'result', role: 'output', label: 'Result', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'b', type: 'test.boom', on_error: 'continue' },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.b.__error).toBe('boom-msg');
        expect(result.nodeOutputs.b.__errorName).toBe('MyError');
        expect(result.nodeOutputs.b.__errorStack).toContain('boom-msg');
    });

    it('on_error=continue still handles non-Error throws (plain string, plain object)', async () => {
        actions.set('throwString', async () => { throw 'literal-string'; });
        actions.set('throwObj', async () => { throw { code: 42 }; });
        registry.register(actionDef('test.t1', 'throwString', [
            { name: 'r', role: 'output', label: 'r', wire: true },
        ]));
        registry.register(actionDef('test.t2', 'throwObj', [
            { name: 'r', role: 'output', label: 'r', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'test.t1', on_error: 'continue' },
                { id: 'b', type: 'test.t2', on_error: 'continue' },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.a).toEqual({ __error: 'literal-string' });
        // Plain objects round-trip through String() to "[object Object]" —
        // not pretty, but stable, and the contract for non-Error throws.
        expect(result.nodeOutputs.b.__error).toBe('[object Object]');
        expect(result.nodeOutputs.b.__errorStack).toBeUndefined();
    });

    it('fails fast when on_error is the default', async () => {
        actions.set('boom', async () => { throw new Error('kaboom'); });
        registry.register(actionDef('test.boom', 'boom', [
            { name: 'result', role: 'output', label: 'Result', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'b', type: 'test.boom' },
            ],
            edges: [],
        };
        await expect(executeGraph(graph, evt(), actions, registry, noopLogger))
            .rejects.toThrow(/kaboom/);
    });

    it('skips a node when its condition is falsy', async () => {
        const ran = vi.fn();
        actions.set('mark', async () => { ran(); return { done: true }; });
        registry.register(actionDef('test.mark', 'mark', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'm', type: 'test.mark', condition: 'false' },
            ],
            edges: [],
        };
        await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(ran).not.toHaveBeenCalled();
    });

    it('rejects unknown node types with a helpful message', async () => {
        const graph: NodeGraph = {
            nodes: [{ id: 'oops', type: 'no.such.type' }],
            edges: [],
        };
        await expect(executeGraph(graph, evt(), actions, registry, noopLogger))
            .rejects.toThrow(/unknown type "no.such.type"/);
    });

    it('manual-trigger inputs surface as top-level output values', async () => {
        const graph: NodeGraph = {
            nodes: [{ id: 'trig', type: 'trigger.github' }],
            edges: [],
        };
        const event = evt({
            source: 'manual',
            payload: { inputs: { pr: { number: 42, title: 'WIP' }, note: 'urgent' } },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.trig.pr).toEqual({ number: 42, title: 'WIP' });
        expect(result.nodeOutputs.trig.note).toBe('urgent');
        // The fallback `inputs` bag is also still present.
        expect(result.nodeOutputs.trig.inputs).toMatchObject({ pr: { number: 42 } });
    });

    it('github PR events synthesize prNumber/branch/author/repo/pr', async () => {
        const graph: NodeGraph = {
            nodes: [{ id: 'trig', type: 'trigger.github' }],
            edges: [],
        };
        const event = evt({
            payload: {
                pull_request: {
                    number: 7,
                    head: { ref: 'feature-x' },
                    user: { login: 'octocat' },
                },
            },
            metadata: { repo: 'org/r' },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.trig.prNumber).toBe(7);
        expect(result.nodeOutputs.trig.branch).toBe('feature-x');
        expect(result.nodeOutputs.trig.author).toBe('octocat');
        expect(result.nodeOutputs.trig.repo).toBe('org/r');
    });

    it('aborts a node that exceeds its per-node timeout', async () => {
        actions.set('slow', async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { done: true };
        });
        registry.register(actionDef('test.slow', 'slow', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                // 0.05s timeout, action sleeps 0.2s — must reject.
                { id: 'slow', type: 'test.slow', timeout: 0.05 },
            ],
            edges: [],
        };
        await expect(executeGraph(graph, evt(), actions, registry, noopLogger))
            .rejects.toThrow(/timed out/);
    });

    it('evaluates a condition with a {{nodes.x.y}} template expression', async () => {
        // The condition string is interpolated before truthiness is
        // checked — a node should fire when an upstream output makes its
        // expression resolve to a truthy string.
        actions.set('producer', async () => ({ flag: 'go' }));
        actions.set('consumer', async () => ({ ran: true }));
        registry.register(actionDef('test.producer', 'producer', [
            { name: 'flag', role: 'output', label: 'Flag', wire: true },
        ]));
        registry.register(actionDef('test.consumer', 'consumer', [
            { name: 'ran', role: 'output', label: 'Ran', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'p', type: 'test.producer' },
                // condition references the upstream output by template
                { id: 'c', type: 'test.consumer', condition: '{{nodes.p.flag}}' },
            ],
            edges: [
                { from: { node: 'p', port: 'flag' }, to: { node: 'c', port: '__seq' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.c?.ran).toBe(true);
    });

    it('skips a node when its template-expression condition resolves to empty', async () => {
        // Producer returns no flag → interpolated condition is "" →
        // evalCondition returns false → consumer must skip.
        actions.set('producer', async () => ({}));
        actions.set('consumer', async () => ({ ran: true }));
        registry.register(actionDef('test.producer', 'producer', [
            { name: 'flag', role: 'output', label: 'Flag', wire: true },
        ]));
        registry.register(actionDef('test.consumer', 'consumer', [
            { name: 'ran', role: 'output', label: 'Ran', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'p', type: 'test.producer' },
                { id: 'c', type: 'test.consumer', condition: '{{nodes.p.flag}}' },
            ],
            edges: [
                { from: { node: 'p', port: 'flag' }, to: { node: 'c', port: '__seq' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.c?.ran).toBeUndefined();
    });

    it('resolves a wire to undefined when the upstream output is absent', async () => {
        // Wiring to an output port that the upstream action never
        // produces shouldn't crash — the input just receives undefined
        // and falls through to the consumer's config or default.
        actions.set('producer', async () => ({ /* deliberately empty */ }));
        actions.set('consumer', async (params) => ({ saw: params.value ?? 'fallback' }));
        registry.register(actionDef('test.producer', 'producer', [
            { name: 'value', role: 'output', label: 'Value', wire: true },
        ]));
        registry.register(actionDef('test.consumer', 'consumer', [
            { name: 'value', role: 'input', label: 'Value', wire: true },
            { name: 'saw', role: 'output', label: 'Saw', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'p', type: 'test.producer' },
                { id: 'c', type: 'test.consumer' },
            ],
            edges: [
                { from: { node: 'p', port: 'value' }, to: { node: 'c', port: 'value' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.c?.saw).toBe('fallback');
    });

    it('runs nodes in the same layer concurrently', async () => {
        // Two independent nodes in one layer should overlap in wall time.
        // We measure: each sleeps 80ms; serial would take >=160ms, parallel
        // ~80ms. Allow generous slack to keep CI noise from flaking.
        actions.set('sleeper', async () => {
            await new Promise((r) => setTimeout(r, 80));
            return { done: true };
        });
        registry.register(actionDef('test.sleeper', 'sleeper', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'test.sleeper' },
                { id: 'b', type: 'test.sleeper' },
            ],
            edges: [],
        };
        const start = Date.now();
        await executeGraph(graph, evt(), actions, registry, noopLogger);
        const elapsed = Date.now() - start;
        // 140ms is well under the serial floor (160ms) but allows for
        // setTimeout coarseness on CI.
        expect(elapsed).toBeLessThan(140);
    });

    it('toposort throws on a self-loop edge rather than silently dropping it', () => {
        // A node cannot consume its own output; the editor refuses to draw
        // a self-loop, so one only appears in hand-authored YAML and is a
        // mistake. Fail loud like the unknown-node checks rather than
        // silently ignoring the edge the author wrote.
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'trigger.github' },
            ],
            edges: [
                { from: { node: 'a', port: 'event' }, to: { node: 'a', port: 'event' } },
            ],
        };
        expect(() => toposortLayers(graph)).toThrow(/Self-loop edge on node "a"/);
    });

    it('toposort throws on an edge referencing a nonexistent source node', () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'trigger.github' },
            ],
            edges: [
                // Typo: "triger" instead of "trig"
                { from: { node: 'triger', port: 'event' }, to: { node: 'a', port: 'event' } },
            ],
        };
        expect(() => toposortLayers(graph)).toThrow(/unknown source node "triger"/);
    });

    it('toposort throws on an edge referencing a nonexistent destination node', () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'a', type: 'trigger.github' },
            ],
            edges: [
                { from: { node: 'a', port: 'event' }, to: { node: 'gone', port: 'event' } },
            ],
        };
        expect(() => toposortLayers(graph)).toThrow(/unknown destination node "gone"/);
    });

    it('aborts a running node when the workflow signal fires', async () => {
        // Action sleeps 200ms; abort fires at 30ms; executeGraph must
        // reject promptly with the abort message rather than waiting
        // for the sleep to complete.
        actions.set('slowloris', async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { done: true };
        });
        registry.register(actionDef('test.slowloris', 'slowloris', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'slow', type: 'test.slowloris' },
            ],
            edges: [],
        };
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30);
        const start = Date.now();
        await expect(
            executeGraph(graph, evt(), actions, registry, noopLogger, { signal: ac.signal }),
        ).rejects.toThrow(/aborted/i);
        expect(Date.now() - start).toBeLessThan(150);
    });

    it('still aborts when the only failing node has on_error=continue', async () => {
        // Without the post-layer signal check, a node that opts into
        // on_error=continue would swallow the abort rejection and the
        // workflow would appear to complete successfully.
        actions.set('slowloris', async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { done: true };
        });
        registry.register(actionDef('test.slowloris', 'slowloris', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'slow', type: 'test.slowloris', on_error: 'continue' },
            ],
            edges: [],
        };
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30);
        await expect(
            executeGraph(graph, evt(), actions, registry, noopLogger, { signal: ac.signal }),
        ).rejects.toThrow(/aborted/i);
    });

    it('rejects immediately when the signal is already aborted at start', async () => {
        actions.set('slowloris', async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { done: true };
        });
        registry.register(actionDef('test.slowloris', 'slowloris', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'slow', type: 'test.slowloris' },
            ],
            edges: [],
        };
        const ac = new AbortController();
        ac.abort();
        await expect(
            executeGraph(graph, evt(), actions, registry, noopLogger, { signal: ac.signal }),
        ).rejects.toThrow(/aborted/i);
    });

    it('preserves {{...}} placeholders whose prefix is not a recognised template root', async () => {
        // A typo (`ndoes` instead of `nodes`) used to silently become an
        // empty string, which masked the misconfiguration. Now it round-
        // trips so the bad reference is visible in logs and downstream
        // diffs. Literal `{{handlebars}}` text in user content (e.g. doc
        // bodies) gets the same treatment.
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'typo', type: 'test.echo', config: { value: 'before {{ndoes.x.y}} after' } },
                { id: 'literal', type: 'test.echo', config: { value: 'see {{handlebars}} for syntax' } },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.typo.echoed).toBe('before {{ndoes.x.y}} after');
        expect(result.nodeOutputs.literal.echoed).toBe('see {{handlebars}} for syntax');
    });

    it('still resolves recognised-but-empty refs to "" so missing optionals stay clean', async () => {
        // Regression guard: the unknown-prefix preserve change must NOT
        // also start preserving `{{nodes.x.y}}` when the path is just
        // missing — that would surface placeholder text in real outputs.
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'e', type: 'test.echo', config: { value: 'pre[{{nodes.missing.gone}}]post' } },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.e.echoed).toBe('pre[]post');
    });

    it('does NOT honour the bare `{{metadata.…}}` prefix — the canonical path is `event.metadata.…`', async () => {
        // `metadata.` was listed in ALLOWED_PREFIXES but never wired
        // into the resolution context, so it always silently collapsed
        // to "". Removing it from the allow-list pushes such typos into
        // the unknown-prefix branch so they round-trip as literals and
        // surface to the author.
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'Value', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'Echoed', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'bare', type: 'test.echo', config: { value: 'r={{metadata.repo}}' } },
                { id: 'full', type: 'test.echo', config: { value: 'r={{event.metadata.repo}}' } },
            ],
            edges: [],
        };
        const result = await executeGraph(
            graph,
            evt({ metadata: { repo: 'octo/r' } }),
            actions, registry, noopLogger,
        );
        expect(result.nodeOutputs.bare.echoed).toBe('r={{metadata.repo}}');
        expect(result.nodeOutputs.full.echoed).toBe('r=octo/r');
    });

    it('caps interpolation recursion to avoid stack overflow on deep configs', async () => {
        // Build a config nested 100 levels deep. Without the depth
        // guard this would either blow the stack (small node) or just
        // be needlessly slow. The guard returns the subtree as-is past
        // the cap so the workflow keeps running.
        let nested: unknown = 'leaf';
        for (let i = 0; i < 100; i++) nested = { wrap: nested };

        actions.set('eat', async (params) => ({ saw: params.payload }));
        registry.register(actionDef('test.eat', 'eat', [
            { name: 'payload', role: 'input', label: 'Payload', wire: true, config: true, control: 'textarea' },
            { name: 'saw', role: 'output', label: 'Saw', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'e', type: 'test.eat', config: { payload: nested } },
            ],
            edges: [],
        };
        // Should not throw, should not hang.
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.e?.saw).toBeDefined();
    });

    // ── Implicit dependencies from {{nodes.X.Y}} / {{steps.X.Y}} ─────────
    //
    // The toposort augments graph.edges with edges inferred from config
    // (and condition) template references. Without this, hand-authored
    // YAML where the consumer references a node it isn't explicitly
    // wired to ran in the wrong layer — interpolation read undefined
    // and silently substituted ''. Each test below asserts the order
    // is now correct AND the consumer sees the producer's actual value
    // rather than ''.
    it('orders consumers after producers when only the config references them ({{nodes.x.y}})', async () => {
        actions.set('produce', async () => ({ markdown: 'REAL-CONTENT' }));
        actions.set('consume', async (params) => ({ saw: params.body }));
        registry.register(actionDef('test.produce', 'produce', [
            { name: 'markdown', role: 'output', label: 'Markdown', wire: true },
        ]));
        registry.register(actionDef('test.consume', 'consume', [
            { name: 'body', role: 'input', label: 'Body', wire: true, config: true, control: 'textarea' },
            { name: 'saw', role: 'output', label: 'Saw', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'producer', type: 'test.produce' },
                {
                    id: 'consumer',
                    type: 'test.consume',
                    // Refers to producer's output but has no edge from it.
                    config: { body: 'wrap {{nodes.producer.markdown}} end' },
                },
            ],
            edges: [],
        };

        // 1. Toposort places producer before consumer.
        const layers = toposortLayers(graph);
        const layerIndexById = new Map<string, number>();
        layers.forEach((layer, i) => layer.forEach((n) => layerIndexById.set(n.id, i)));
        expect(layerIndexById.get('producer')!).toBeLessThan(layerIndexById.get('consumer')!);

        // 2. The consumer interpolates the producer's actual output, not ''.
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.consumer.saw).toBe('wrap REAL-CONTENT end');
    });

    it('treats {{steps.x.y}} the same as {{nodes.x.y}} for ordering', async () => {
        actions.set('produce', async () => ({ value: 'XYZ' }));
        actions.set('consume', async (params) => ({ saw: params.body }));
        registry.register(actionDef('test.produce', 'produce', [
            { name: 'value', role: 'output', label: 'V', wire: true },
        ]));
        registry.register(actionDef('test.consume', 'consume', [
            { name: 'body', role: 'input', label: 'B', wire: true, config: true, control: 'text' },
            { name: 'saw', role: 'output', label: 'Saw', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'p', type: 'test.produce' },
                { id: 'c', type: 'test.consume', config: { body: '{{steps.p.value}}' } },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(result.nodeOutputs.c.saw).toBe('XYZ');
    });

    it('uses node.condition refs for ordering too', async () => {
        // Without this, a node whose `condition:` reads another node's
        // output could be evaluated in the wrong layer, with the
        // condition string interpolating to '' (falsy) and the node
        // wrongly skipped.
        const ranC = vi.fn();
        actions.set('flag', async () => ({ ok: 'yes' }));
        actions.set('mark', async () => { ranC(); return { done: true }; });
        registry.register(actionDef('test.flag', 'flag', [
            { name: 'ok', role: 'output', label: 'OK', wire: true },
        ]));
        registry.register(actionDef('test.mark', 'mark', [
            { name: 'done', role: 'output', label: 'Done', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'gate', type: 'test.flag' },
                { id: 'after', type: 'test.mark', condition: '{{nodes.gate.ok}}' },
            ],
            edges: [],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        expect(ranC).toHaveBeenCalledTimes(1);
        expect(result.nodeOutputs.after.done).toBe(true);
    });

    it('does not duplicate ordering when both an explicit edge and a config ref exist', async () => {
        // Regression guard: the inference shouldn't re-add a (producer,
        // consumer) implicit edge when the explicit edge already exists.
        // The layout should match the no-config-ref baseline exactly.
        actions.set('p', async () => ({ value: 'A' }));
        actions.set('c', async (params) => ({ saw: params.body }));
        registry.register(actionDef('test.p', 'p', [
            { name: 'value', role: 'output', label: 'V', wire: true },
        ]));
        registry.register(actionDef('test.c', 'c', [
            { name: 'body', role: 'input', label: 'B', wire: true, config: true, control: 'text' },
            { name: 'saw', role: 'output', label: 'Saw', wire: true },
        ]));
        const baseGraph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'p', type: 'test.p' },
                // No config ref here — pure explicit-edge baseline.
                { id: 'c', type: 'test.c', config: { body: 'static' } },
            ],
            edges: [
                { from: { node: 'p', port: 'value' }, to: { node: 'c', port: 'body' } },
            ],
        };
        const dupGraph: NodeGraph = {
            ...baseGraph,
            nodes: [
                ...baseGraph.nodes.slice(0, 2),
                // Has an explicit edge AND a {{nodes.p.value}} config ref —
                // the inferred edge would be a duplicate of the explicit one.
                { id: 'c', type: 'test.c', config: { body: '{{nodes.p.value}}!' } },
            ],
        };
        const flatten = (g: NodeGraph) => toposortLayers(g).map((l) => l.map((n) => n.id));
        expect(flatten(dupGraph)).toEqual(flatten(baseGraph));
    });

    it('ignores implicit refs to non-existent node ids — leaves the existing dangling-edge guard intact', async () => {
        // A typo `{{nodes.reveiw.markdown}}` (missing 'reveiw' node)
        // should NOT crash the toposort. The interpolation will resolve
        // to '' at runtime — the typo-preserving change covers literals,
        // and missing-but-prefixed refs still return ''.
        actions.set('echo', async (params) => ({ echoed: params.value }));
        registry.register(actionDef('test.echo', 'echo', [
            { name: 'value', role: 'input', label: 'V', wire: true, config: true, control: 'text' },
            { name: 'echoed', role: 'output', label: 'E', wire: true },
        ]));
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'e', type: 'test.echo', config: { value: '{{nodes.reveiw.x}} fallback' } },
            ],
            edges: [],
        };
        // Doesn't throw. Doesn't add a phantom edge to a non-existent node.
        expect(() => toposortLayers(graph)).not.toThrow();
    });
});
