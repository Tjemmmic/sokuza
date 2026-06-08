import { describe, it, expect } from 'vitest';
import { McpAskStore } from '../core/mcp-ask-store.js';

describe('McpAskStore', () => {
    it('creates pending asks with unique ids', () => {
        const store = new McpAskStore();
        const a = store.create('what now?', 'claude-code');
        const b = store.create('and then?');
        expect(a.id).not.toBe(b.id);
        expect(a.status).toBe('pending');
        expect(a.source).toBe('claude-code');
        expect(store.listPending().map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('resolves an ask and removes it from the pending list', () => {
        const store = new McpAskStore();
        const ask = store.create('ship it?');
        const answered = store.answer(ask.id, 'yes');
        expect(answered?.status).toBe('answered');
        expect(answered?.answer).toBe('yes');
        expect(store.get(ask.id)?.status).toBe('answered');
        expect(store.listPending()).toHaveLength(0);
    });

    it('returns undefined when answering an unknown id', () => {
        const store = new McpAskStore();
        expect(store.answer('nope', 'x')).toBeUndefined();
    });

    it('does not overwrite an already-answered ask', () => {
        const store = new McpAskStore();
        const ask = store.create('q');
        store.answer(ask.id, 'first');
        const again = store.answer(ask.id, 'second');
        expect(again?.answer).toBe('first');
    });

    it('enforces the hard cap by dropping the oldest entries', () => {
        const store = new McpAskStore(3);
        const ids = [0, 1, 2, 3, 4].map((i) => store.create(`q${i}`).id);
        // Only the 3 most recent survive.
        const surviving = ids.filter((id) => store.get(id));
        expect(surviving).toEqual(ids.slice(-3));
    });

    it('evicts answered asks before pending ones when over the cap', () => {
        const store = new McpAskStore(2);
        const a1 = store.create('q1');
        store.answer(a1.id, 'done'); // a1 is answered
        const a2 = store.create('q2'); // pending
        const a3 = store.create('q3'); // pending → over cap, must evict a1 (answered)
        expect(store.get(a1.id)).toBeUndefined();
        expect(store.get(a2.id)?.status).toBe('pending');
        expect(store.get(a3.id)?.status).toBe('pending');
    });
});
