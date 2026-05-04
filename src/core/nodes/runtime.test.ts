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
        expect(result.nodeOutputs.b).toEqual({ __error: expect.stringContaining('kaboom') });
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
});
