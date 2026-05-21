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

// Test scaffolding: run a one-shot graph and capture downstream params.
// Each suite below defines its own ports/edges on top of this.
function captureNode(portNames: string[]) {
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
        ports: portNames.map((name) => ({
            name, role: 'input' as const, label: name, wire: true, config: true, control: 'text' as const,
        })),
        execute: async (inputs, ctx) => {
            const handler = ctx.actions.get('capture')!;
            return await handler(inputs, ctx);
        },
    });
    return { captured, actions, registry };
}

// ─── flow.switch ────────────────────────────────────────────────────────────

describe('flow.switch — N-way branch', () => {
    async function runSwitch(opts: {
        value: unknown;
        cases: Record<string, string>;
        capturePorts: string[];
    }) {
        const { captured, actions, registry } = captureNode([...opts.capturePorts, 'matched', 'defaultVal']);
        const graph: NodeGraph = {
            nodes: [
                { id: 'sw', type: 'flow.switch', config: { value: opts.value, cases: opts.cases } },
                { id: 'cap', type: 'test.capture', config: {} },
            ],
            edges: [
                ...opts.capturePorts.map((port) => ({ from: { node: 'sw', port }, to: { node: 'cap', port } })),
                { from: { node: 'sw', port: 'default' }, to: { node: 'cap', port: 'defaultVal' } },
                { from: { node: 'sw', port: 'matched' }, to: { node: 'cap', port: 'matched' } },
            ],
        };
        await executeGraph(graph, evt(), actions, registry, noopLogger);
        return captured;
    }

    it('routes a matching value to the named case port and sets matched to the port name', async () => {
        const got = await runSwitch({
            value: 'APPROVE',
            cases: { APPROVE: 'approved', CHANGES_REQUESTED: 'blocked' },
            capturePorts: ['approved', 'blocked'],
        });
        // The pass-through value lands on the matched port…
        expect(got.approved).toBe('APPROVE');
        // …the other case port stays undefined…
        expect(got.blocked).toBeUndefined();
        // …default does NOT fire when a case matched…
        expect(got.defaultVal).toBeUndefined();
        // …and `matched` reports which port fired.
        expect(got.matched).toBe('approved');
    });

    it('multiple match values can share a single port (deduplicated ports)', async () => {
        // Real-world pattern: route both OPEN and REOPENED to the same
        // "active" branch. Both keys map to the same value; the dynamic-
        // output resolver creates only one `active` port.
        const got = await runSwitch({
            value: 'REOPENED',
            cases: { OPEN: 'active', REOPENED: 'active', CLOSED: 'inactive' },
            capturePorts: ['active', 'inactive'],
        });
        expect(got.active).toBe('REOPENED');
        expect(got.inactive).toBeUndefined();
        expect(got.matched).toBe('active');
    });

    it('falls through to default when no case key equals the input value', async () => {
        const got = await runSwitch({
            value: 'UNKNOWN',
            cases: { APPROVE: 'approved', CHANGES_REQUESTED: 'blocked' },
            capturePorts: ['approved', 'blocked'],
        });
        expect(got.approved).toBeUndefined();
        expect(got.blocked).toBeUndefined();
        expect(got.defaultVal).toBe('UNKNOWN');
        expect(got.matched).toBe('default');
    });

    it('trims whitespace on both sides of the equality check', async () => {
        // KV editor users routinely add stray spaces; the editor's
        // change-tracking can leave " APPROVE " in keys. Treating these
        // as exact-string-different from "APPROVE" would surprise the
        // user. Trim-then-compare is the forgiving default.
        const got = await runSwitch({
            value: '  APPROVE  ',
            cases: { ' APPROVE': 'approved' },
            capturePorts: ['approved'],
        });
        expect(got.approved).toBe('  APPROVE  ');
        expect(got.matched).toBe('approved');
    });

    it('coerces non-string input to string for comparison (numbers, booleans)', async () => {
        const got = await runSwitch({
            value: 42,
            cases: { '42': 'forty-two', '7': 'seven' },
            capturePorts: ['forty-two', 'seven'],
        });
        expect(got['forty-two']).toBe(42);
        expect(got.matched).toBe('forty-two');
    });

    it('returns to default when cases is empty or missing', async () => {
        const got = await runSwitch({
            value: 'anything',
            cases: {},
            capturePorts: [],
        });
        expect(got.defaultVal).toBe('anything');
        expect(got.matched).toBe('default');
    });

    it('skips empty port-name entries (kv editor lets users add unfinished rows)', async () => {
        const got = await runSwitch({
            value: 'OPEN',
            // A row with an empty value happens when the user adds a row
            // and hasn't typed the port name yet. We must not route to
            // an unnamed port (would clobber 'matched' otherwise).
            cases: { OPEN: '', CLOSED: 'closed' },
            capturePorts: ['closed'],
        });
        // OPEN had an empty port name → falls through to default.
        expect(got.defaultVal).toBe('OPEN');
        expect(got.matched).toBe('default');
    });

    // Regression: returning `{ matched: <value>, matched: portName }` is
    // a JS duplicate-key spec violation — the actual value is silently
    // discarded. Similarly `default` aliases the no-match fallback,
    // making routing indistinguishable. The runtime now refuses to honor
    // either; the value falls through to default so the misconfiguration
    // is at least visible to the user (and a warning is logged).

    it('skips a case whose port name collides with the reserved "matched" output', async () => {
        const got = await runSwitch({
            value: 'X',
            cases: { X: 'matched' },
            capturePorts: [],
        });
        expect(got.defaultVal).toBe('X');
        expect(got.matched).toBe('default');
    });

    it('skips a case whose port name collides with the reserved "default" output', async () => {
        const got = await runSwitch({
            value: 'Y',
            cases: { Y: 'default' },
            capturePorts: [],
        });
        expect(got.defaultVal).toBe('Y');
        expect(got.matched).toBe('default');
    });
});

// ─── flow.switch dynamic ports ─────────────────────────────────────────────
//
// Separately from the runtime behaviour, the node definition has to
// expose the unique case ports to the editor so wires can be drawn at
// design time. The runtime test above proves wiring works end to end;
// this block pins the editor surface so a refactor of the resolver
// can't silently break the palette.

describe('flow.switch dynamic outputs (per-config-value resolution)', () => {
    it('resolveOutputPorts adds one port per unique value in the cases kv map', async () => {
        const registry = getNodeRegistry();
        const defs = registry.serialize();
        const switchDef = defs.find((d) => d.type === 'flow.switch')!;
        expect(switchDef).toBeDefined();

        const { resolveOutputPorts } = await import('./types.js');
        const ports = resolveOutputPorts(
            // Use the live definition with its execute() — but for port
            // resolution we only need the static `ports` + `dynamicOutputs`.
            switchDef as Parameters<typeof resolveOutputPorts>[0],
            { cases: { OPEN: 'active', REOPENED: 'active', CLOSED: 'inactive' } },
        );

        const names = ports.map((p) => p.name);
        // Static outputs always present:
        expect(names).toContain('default');
        expect(names).toContain('matched');
        // Dynamic ports — one per UNIQUE value, deduplicated:
        expect(names).toContain('active');
        expect(names).toContain('inactive');
        // …and not duplicated even though `active` appears twice in cases:
        expect(names.filter((n) => n === 'active').length).toBe(1);
    });

    it('skips empty values (unfinished kv rows) without crashing', async () => {
        const registry = getNodeRegistry();
        const switchDef = registry.serialize().find((d) => d.type === 'flow.switch')!;
        const { resolveOutputPorts } = await import('./types.js');
        const ports = resolveOutputPorts(
            switchDef as Parameters<typeof resolveOutputPorts>[0],
            { cases: { OPEN: '', CLOSED: 'closed' } },
        );
        const names = ports.map((p) => p.name);
        expect(names).toContain('closed');
        // Empty value never becomes a port — would otherwise create a
        // nameless output port that the editor can't render.
        expect(names.every((n) => n.length > 0)).toBe(true);
    });
});

// ─── flow.delay ─────────────────────────────────────────────────────────────

describe('flow.delay', () => {
    async function runDelay(seconds: unknown, value: unknown, signal?: AbortSignal) {
        const { captured, actions, registry } = captureNode(['outValue', 'delayed']);
        const graph: NodeGraph = {
            nodes: [
                { id: 'd', type: 'flow.delay', config: { seconds, input: value } },
                { id: 'cap', type: 'test.capture', config: {} },
            ],
            edges: [
                { from: { node: 'd', port: 'value' }, to: { node: 'cap', port: 'outValue' } },
                { from: { node: 'd', port: 'delayed' }, to: { node: 'cap', port: 'delayed' } },
            ],
        };
        return { captured, run: () => executeGraph(graph, evt(), actions, registry, noopLogger, { signal }) };
    }

    it('waits the requested duration before forwarding value', async () => {
        const { captured, run } = await runDelay(0.25, 'after-delay');
        const start = Date.now();
        await run();
        const elapsed = Date.now() - start;
        expect(captured.outValue).toBe('after-delay');
        expect(captured.delayed).toBe(true);
        // Within a generous tolerance — Node timers have low precision
        // and CI is often slow.
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(2000);
    });

    it('skips the wait when seconds is zero (delayed=false)', async () => {
        const { captured, run } = await runDelay(0, 'value');
        const start = Date.now();
        await run();
        const elapsed = Date.now() - start;
        expect(captured.outValue).toBe('value');
        expect(captured.delayed).toBe(false);
        expect(elapsed).toBeLessThan(200);
    });

    it('skips the wait when seconds is negative (delayed=false)', async () => {
        const { captured, run } = await runDelay(-5, 'value');
        await run();
        expect(captured.delayed).toBe(false);
    });

    it('coerces numeric strings (kv editor stores numbers as strings)', async () => {
        const { captured, run } = await runDelay('0', 'value');
        await run();
        expect(captured.delayed).toBe(false);
    });

    it('aborts cleanly mid-wait when the workflow signal fires', async () => {
        // A long delay should reject promptly when aborted, not block
        // the whole workflow until the timer expires.
        const ac = new AbortController();
        const { run } = await runDelay(30, 'value', ac.signal);
        const start = Date.now();
        setTimeout(() => ac.abort('cancelled'), 100);
        await expect(run()).rejects.toThrow();
        const elapsed = Date.now() - start;
        // Should reject within a second — way under the 30s delay.
        expect(elapsed).toBeLessThan(2000);
    });

    it('throws immediately if the signal is already aborted at execute time', async () => {
        const ac = new AbortController();
        ac.abort('cancelled');
        const { run } = await runDelay(30, 'value', ac.signal);
        const start = Date.now();
        await expect(run()).rejects.toThrow();
        expect(Date.now() - start).toBeLessThan(500);
    });
});

// ─── flow.fail ──────────────────────────────────────────────────────────────

describe('flow.fail', () => {
    function failGraph(opts: { message: unknown; cause?: unknown; condition?: string }): NodeGraph {
        const node: NodeGraph['nodes'][number] = {
            id: 'f',
            type: 'flow.fail',
            config: { message: opts.message, cause: opts.cause },
        };
        if (opts.condition !== undefined) node.condition = opts.condition;
        return { nodes: [node], edges: [] };
    }

    it('throws an Error with the configured message', async () => {
        const actions = new Map<string, ActionHandler>();
        const registry = getNodeRegistry();
        await expect(
            executeGraph(failGraph({ message: 'merge-ready check failed' }), evt(), actions, registry, noopLogger),
        ).rejects.toThrow(/merge-ready check failed/);
    });

    it('includes the cause value (JSON-stringified) in the error tail when provided', async () => {
        const actions = new Map<string, ActionHandler>();
        const registry = getNodeRegistry();
        await expect(
            executeGraph(
                failGraph({ message: 'parse error', cause: { line: 12, snippet: 'oops' } }),
                evt(), actions, registry, noopLogger,
            ),
        ).rejects.toThrow(/parse error.*line.*12/s);
    });

    it('honors the node-level condition gate — does not throw when condition is falsy', async () => {
        // The gate belongs on the node, not duplicated in the executor.
        // When `condition: "false"` skips the node, no throw fires —
        // proving the design choice of "always throws when executed".
        const actions = new Map<string, ActionHandler>();
        const registry = getNodeRegistry();
        await expect(
            executeGraph(
                failGraph({ message: 'should not fire', condition: 'false' }),
                evt(), actions, registry, noopLogger,
            ),
        ).resolves.toBeDefined();
    });

    it('uses a generic fallback message when the user left message blank', async () => {
        // Defensive: required-in-the-port doesn't stop a user editing
        // YAML and removing the field. Don't throw a confusing
        // "undefined" error.
        const actions = new Map<string, ActionHandler>();
        const registry = getNodeRegistry();
        await expect(
            executeGraph(failGraph({ message: '' }), evt(), actions, registry, noopLogger),
        ).rejects.toThrow(/flow.fail invoked/);
    });
});
