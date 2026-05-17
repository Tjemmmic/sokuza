import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { resolveOutputPorts, type NodeDefinition, type NodePort } from '../core/nodes/types.js';

// graph-logic.js ships to the browser as a plain UMD <script> (no bundler).
// Vite would rewrite an ESM import of it, so evaluate the literal file in a
// CommonJS vm sandbox — this exercises exactly the bytes the dashboard loads.
function loadGraphLogic() {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../dashboard/graph-logic.js'), 'utf8');
    const sandboxModule: { exports: Record<string, unknown> } = { exports: {} };
    vm.runInNewContext(src, { module: sandboxModule });
    return sandboxModule.exports as {
        eventGlobMatch(pattern: string, value: string): boolean;
        portTypeForInputType(t: string | undefined): NodePort['type'];
        resolveWireableOutputPorts(
            def: NodeDefinition,
            node: { config?: Record<string, unknown> },
        ): NodePort[];
    };
}

const graphLogic = loadGraphLogic();

const manualDef: NodeDefinition = {
    type: 'trigger.manual',
    category: 'trigger',
    group: 'Triggers',
    title: 'Manual',
    description: '',
    icon: '🎮',
    ports: [
        { name: 'inputs', label: 'Form Fields', role: 'input', config: true, control: 'kv' },
        { name: 'event', label: 'Event', role: 'output', wire: true, type: 'event' },
        { name: 'payload', label: 'Payload', role: 'output', wire: true, type: 'json' },
    ],
    dynamicOutputs: [{ kind: 'per-input', inputsConfigKey: 'inputs' }],
};

const githubDef: NodeDefinition = {
    type: 'trigger.github',
    category: 'trigger',
    group: 'Triggers',
    title: 'GitHub',
    description: '',
    icon: '🐙',
    ports: [
        { name: 'events', label: 'Events', role: 'input', config: true, control: 'multiselect' },
        { name: 'event', label: 'Event', role: 'output', wire: true, type: 'event' },
        { name: 'payload', label: 'Payload', role: 'output', wire: true, type: 'json' },
    ],
    dynamicOutputs: [{
        kind: 'event-conditional',
        eventsConfigKey: 'events',
        rules: [
            {
                whenEvents: ['pull_request.*'],
                ports: [
                    { name: 'pr', label: 'PR', role: 'output', wire: true, type: 'pr' },
                    { name: 'prNumber', label: 'PR #', role: 'output', wire: true, type: 'number' },
                ],
            },
            {
                whenEvents: ['issues.*'],
                ports: [{ name: 'issue', label: 'Issue', role: 'output', wire: true, type: 'issue' }],
            },
        ],
    }],
};

/** The user-visible contract: which output ports the editor draws a handle
 *  for. The runtime returns every output port; the editor only wires the ones
 *  not flagged `wire: false`, so compare under that same predicate. */
function runtimeWireableNames(def: NodeDefinition, config: Record<string, unknown> | undefined): string[] {
    return resolveOutputPorts(def, config)
        .filter((p) => p.role === 'output' && p.wire !== false)
        .map((p) => p.name)
        .sort();
}

function clientWireableNames(def: NodeDefinition, config: Record<string, unknown> | undefined): string[] {
    return graphLogic
        .resolveWireableOutputPorts(def, { config })
        .map((p) => p.name)
        .sort();
}

describe('graph-logic ↔ runtime port-resolution parity', () => {
    const cases: Array<{ name: string; def: NodeDefinition; config: Record<string, unknown> | undefined }> = [
        { name: 'manual: no config', def: manualDef, config: undefined },
        { name: 'manual: empty inputs', def: manualDef, config: { inputs: [] } },
        {
            name: 'manual: typed inputs',
            def: manualDef,
            config: { inputs: [
                { name: 'pr', label: 'Pull Request', type: 'github-pr' },
                { name: 'note', type: 'text' },
            ] },
        },
        {
            name: 'manual: input name colliding with a static output is not duplicated',
            def: manualDef,
            config: { inputs: [{ name: 'event', type: 'text' }] },
        },
        { name: 'github: no events', def: githubDef, config: {} },
        { name: 'github: pull_request.opened', def: githubDef, config: { events: ['pull_request.opened'] } },
        { name: 'github: issues.opened', def: githubDef, config: { events: ['issues.opened'] } },
        {
            name: 'github: union of event sets',
            def: githubDef,
            config: { events: ['pull_request.opened', 'issues.labeled'] },
        },
        { name: 'github: unrelated event unlocks nothing', def: githubDef, config: { events: ['push'] } },
    ];

    for (const { name, def, config } of cases) {
        it(name, () => {
            expect(clientWireableNames(def, config)).toEqual(runtimeWireableNames(def, config));
        });
    }

    it('client also maps dynamic input types the same way the runtime does', () => {
        const config = { inputs: [
            { name: 'a', type: 'github-pr' },
            { name: 'b', type: 'github-issue' },
            { name: 'c', type: 'number' },
            { name: 'd', type: 'boolean' },
            { name: 'e', type: 'github-branch' },
            { name: 'f', type: 'select' },
        ] };
        const runtime = new Map(resolveOutputPorts(manualDef, config).map((p) => [p.name, p.type]));
        for (const p of graphLogic.resolveWireableOutputPorts(manualDef, { config })) {
            expect(p.type).toBe(runtime.get(p.name));
        }
    });
});

describe('eventGlobMatch', () => {
    it('matches exact strings', () => {
        expect(graphLogic.eventGlobMatch('pull_request.opened', 'pull_request.opened')).toBe(true);
    });
    it('treats * as a wildcard segment', () => {
        expect(graphLogic.eventGlobMatch('pull_request.*', 'pull_request.closed')).toBe(true);
        expect(graphLogic.eventGlobMatch('issues.*', 'pull_request.opened')).toBe(false);
    });
    it('escapes regex metacharacters in the literal part', () => {
        // The dot must be literal, not "any char": "pull_requestXopened" must not match.
        expect(graphLogic.eventGlobMatch('pull_request.opened', 'pull_requestXopened')).toBe(false);
    });
    it('non-wildcard patterns only match exactly', () => {
        expect(graphLogic.eventGlobMatch('push', 'pushy')).toBe(false);
    });
});

describe('portTypeForInputType', () => {
    it('maps known input control types and falls back to string', () => {
        expect(graphLogic.portTypeForInputType('github-pr')).toBe('pr');
        expect(graphLogic.portTypeForInputType('github-issue')).toBe('issue');
        expect(graphLogic.portTypeForInputType('number')).toBe('number');
        expect(graphLogic.portTypeForInputType('boolean')).toBe('boolean');
        expect(graphLogic.portTypeForInputType('textarea')).toBe('string');
        expect(graphLogic.portTypeForInputType(undefined)).toBe('string');
        expect(graphLogic.portTypeForInputType('something-unknown')).toBe('string');
    });
});
