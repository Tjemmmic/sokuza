import { describe, it, expect, beforeEach } from 'vitest';
import { NodeRegistry } from './registry.js';
import { registerBuiltinNodes, builtinNodes } from './builtins.js';

describe('NodeRegistry', () => {
    let r: NodeRegistry;
    beforeEach(() => { r = new NodeRegistry(); });

    it('registers and retrieves nodes', () => {
        r.register({
            type: 'x.y', category: 'action', group: 'G', title: 'T',
            description: '', icon: '⚡', ports: [], execute: async () => ({}),
        });
        expect(r.has('x.y')).toBe(true);
        expect(r.get('x.y')?.title).toBe('T');
    });

    it('rejects duplicate registrations', () => {
        const def = {
            type: 'dup', category: 'action' as const, group: 'G', title: 'T',
            description: '', icon: '⚡', ports: [], execute: async () => ({}),
        };
        r.register(def);
        expect(() => r.register(def)).toThrow(/already registered/);
    });

    it('serialize() drops the execute function', () => {
        r.register({
            type: 'x.y', category: 'action', group: 'G', title: 'T',
            description: '', icon: '⚡', ports: [{ name: 'p', label: 'P', role: 'output' }],
            execute: async () => ({}),
        });
        const ser = r.serialize();
        expect(ser).toHaveLength(1);
        expect((ser[0] as any).execute).toBeUndefined();
        expect(ser[0].ports).toHaveLength(1);
    });
});

describe('builtin nodes', () => {
    it('exposes a non-trivial palette including triggers, AI, GitHub, Flow', () => {
        const all = builtinNodes();
        expect(all.length).toBeGreaterThan(15);
        const groups = new Set(all.map((n) => n.group));
        expect(groups.has('Triggers')).toBe(true);
        expect(groups.has('AI')).toBe(true);
        expect(groups.has('GitHub')).toBe(true);
        expect(groups.has('Flow')).toBe(true);
    });

    it('every action node references an action handler', () => {
        for (const def of builtinNodes()) {
            if (def.category === 'action') {
                expect(typeof def.execute).toBe('function');
            }
        }
    });

    it('registerBuiltinNodes is idempotent', () => {
        const r = new NodeRegistry();
        registerBuiltinNodes(r);
        const first = r.list().length;
        registerBuiltinNodes(r);
        expect(r.list().length).toBe(first);
    });
});
