import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { Logger } from 'pino';
import { executeGraph } from './runtime.js';
import { getNodeRegistry, resetNodeRegistry } from './registry.js';
import { registerBuiltinNodes } from './builtins.js';
import type { NodeGraph } from './types.js';
import type { ActionHandler, EventPayload } from '../types.js';

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

beforeEach(() => {
    resetNodeRegistry();
    registerBuiltinNodes(getNodeRegistry());
});

// The flow.if node's `then`/`else` outputs pass through the wired
// `value`, falling back to `true` only when the port is unwired. That's
// fine for data wires but breaks downstream `condition:` evaluation
// when the value is one of isStringTruthy's falsy literals — 0, false,
// "", "null", "undefined", "0", "false". A naive
// `condition: "{{nodes.if.then}}"` would resolve to a falsy string and
// skip the downstream node even though the if-node ran the then
// branch. The `thenFired` / `elseFired` ports are always-truthy
// sentinels for exactly this use case.

describe('flow.if branch-fired markers', () => {
    async function runIf(condition: string, value: unknown = undefined) {
        const captured: Record<string, unknown> = {};
        const actions = new Map<string, ActionHandler>();
        actions.set('capture', async (params) => {
            Object.assign(captured, params);
            return { ok: true };
        });
        const registry = getNodeRegistry();
        registry.register({
            type: 'test.capture',
            category: 'action',
            group: 'Test',
            title: 'Capture',
            description: 'Capture params for assertion',
            icon: '🧪',
            ports: [
                { name: 'thenVal', role: 'input', label: 'Then', wire: true, config: true, control: 'text' },
                { name: 'elseVal', role: 'input', label: 'Else', wire: true, config: true, control: 'text' },
                { name: 'thenFired', role: 'input', label: 'Then fired?', wire: true, config: true, control: 'text' },
                { name: 'elseFired', role: 'input', label: 'Else fired?', wire: true, config: true, control: 'text' },
                { name: 'matched', role: 'input', label: 'Matched', wire: true, config: true, control: 'text' },
            ],
            execute: async (inputs, ctx) => {
                const handler = ctx.actions.get('capture')!;
                return await handler(inputs, ctx);
            },
        });

        const graph: NodeGraph = {
            nodes: [
                { id: 'iff', type: 'flow.if', config: value === undefined ? { condition } : { condition, value } },
                { id: 'cap', type: 'test.capture', config: {} },
            ],
            edges: [
                { from: { node: 'iff', port: 'then' }, to: { node: 'cap', port: 'thenVal' } },
                { from: { node: 'iff', port: 'else' }, to: { node: 'cap', port: 'elseVal' } },
                { from: { node: 'iff', port: 'thenFired' }, to: { node: 'cap', port: 'thenFired' } },
                { from: { node: 'iff', port: 'elseFired' }, to: { node: 'cap', port: 'elseFired' } },
                { from: { node: 'iff', port: 'matched' }, to: { node: 'cap', port: 'matched' } },
            ],
        };
        await executeGraph(graph, evt(), actions, registry, noopLogger);
        return captured;
    }

    it('truthy condition emits then with the pass-through value AND a "true" thenFired sentinel', async () => {
        const got = await runIf('true', 'hello');
        expect(got.thenVal).toBe('hello');
        expect(got.thenFired).toBe('true');
        expect(got.elseFired).toBeUndefined();
        expect(got.matched).toBe('then');
    });

    it('falsy condition emits else with the pass-through value AND a "true" elseFired sentinel', async () => {
        const got = await runIf('false', 'hello');
        expect(got.elseVal).toBe('hello');
        expect(got.elseFired).toBe('true');
        expect(got.thenFired).toBeUndefined();
        expect(got.matched).toBe('else');
    });

    // The bug that prompted the new ports: a value of 0 (or false/"")
    // passed through `then` interpolates as the string "0" which is
    // explicitly in isStringTruthy's falsy set, so a downstream
    // `condition: "{{nodes.iff.then}}"` would have skipped the
    // downstream node even though the iff took the then branch.
    // `thenFired` is always "true" regardless of the value, so a
    // `condition:` wired to it survives the round-trip.
    it('thenFired stays "true" even when the pass-through value is 0 (the latent-bug case)', async () => {
        const got = await runIf('true', 0);
        // Pass-through still carries 0, for data consumers that want
        // the value:
        expect(got.thenVal).toBe(0);
        // …but the dedicated sentinel is the truthy "true" that
        // downstream `condition:` fields should be wired to:
        expect(got.thenFired).toBe('true');
    });

    it('thenFired stays "true" when the pass-through value is the literal boolean false', async () => {
        const got = await runIf('true', false);
        expect(got.thenVal).toBe(false);
        expect(got.thenFired).toBe('true');
    });

    it('thenFired stays "true" when the pass-through value is the empty string', async () => {
        const got = await runIf('true', '');
        expect(got.thenVal).toBe('');
        expect(got.thenFired).toBe('true');
    });

    it('no value wired: then carries the legacy true sentinel and thenFired carries "true"', async () => {
        const got = await runIf('true');
        expect(got.thenVal).toBe(true);
        expect(got.thenFired).toBe('true');
    });
});
