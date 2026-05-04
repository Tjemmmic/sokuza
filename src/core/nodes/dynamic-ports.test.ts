import { describe, it, expect } from 'vitest';
import { resolveOutputPorts, type NodeDefinition } from './types.js';

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

describe('resolveOutputPorts (dynamic)', () => {
    it('manual trigger: each user input becomes a typed output port', () => {
        const ports = resolveOutputPorts(manualDef, {
            inputs: [
                { name: 'pr', label: 'Pull Request', type: 'github-pr' },
                { name: 'note', label: 'Note', type: 'text' },
            ],
        });
        expect(ports.find((p) => p.name === 'pr')?.type).toBe('pr');
        expect(ports.find((p) => p.name === 'note')?.type).toBe('string');
        // Static ports remain.
        expect(ports.find((p) => p.name === 'event')).toBeDefined();
        expect(ports.find((p) => p.name === 'payload')).toBeDefined();
    });

    it('manual trigger: empty inputs leaves only the static base outputs', () => {
        const ports = resolveOutputPorts(manualDef, { inputs: [] });
        expect(ports.map((p) => p.name).sort()).toEqual(['event', 'payload']);
    });

    it('github trigger: pull_request.opened unlocks pr/prNumber ports', () => {
        const ports = resolveOutputPorts(githubDef, { events: ['pull_request.opened'] });
        const names = ports.map((p) => p.name);
        expect(names).toContain('pr');
        expect(names).toContain('prNumber');
        expect(names).not.toContain('issue');
    });

    it('github trigger: issues.opened unlocks issue port', () => {
        const ports = resolveOutputPorts(githubDef, { events: ['issues.opened'] });
        const names = ports.map((p) => p.name);
        expect(names).toContain('issue');
        expect(names).not.toContain('pr');
    });

    it('github trigger: combined event sets unlock the union', () => {
        const ports = resolveOutputPorts(githubDef, {
            events: ['pull_request.opened', 'issues.opened'],
        });
        const names = ports.map((p) => p.name);
        expect(names).toContain('pr');
        expect(names).toContain('issue');
    });

    it('null/missing config falls back to static ports', () => {
        const ports = resolveOutputPorts(manualDef, undefined);
        expect(ports.map((p) => p.name).sort()).toEqual(['event', 'payload']);
    });
});
