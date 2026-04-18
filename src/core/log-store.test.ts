import { describe, it, expect } from 'vitest';
import { LogStore } from './log-store.js';

describe('LogStore', () => {
    it('stores log entries in a ring buffer', () => {
        const store = new LogStore(5);

        for (let i = 0; i < 8; i++) {
            store.write({ level: 30, time: Date.now(), msg: `msg-${i}` });
        }

        const entries = store.getEntries();
        expect(entries).toHaveLength(5);
        expect(entries[0].msg).toBe('msg-3');
        expect(entries[4].msg).toBe('msg-7');
    });

    it('adds levelName to entries', () => {
        const store = new LogStore();
        store.write({ level: 40, time: 1000, msg: 'warning' });

        const entries = store.getEntries();
        expect(entries[0].levelName).toBe('warn');
    });

    it('filters by since timestamp', () => {
        const store = new LogStore();

        store.write({ level: 30, time: 1000, msg: 'old' });
        store.write({ level: 30, time: 2000, msg: 'newer' });
        store.write({ level: 30, time: 3000, msg: 'newest' });

        const entries = store.getEntries(1500);
        expect(entries).toHaveLength(2);
        expect(entries[0].msg).toBe('newer');
        expect(entries[1].msg).toBe('newest');
    });

    it('filters by minimum level', () => {
        const store = new LogStore();

        store.write({ level: 30, time: 1000, msg: 'info' });
        store.write({ level: 40, time: 2000, msg: 'warn' });
        store.write({ level: 50, time: 3000, msg: 'error' });

        const entries = store.getEntries(undefined, 'warn');
        expect(entries).toHaveLength(2);
        expect(entries[0].msg).toBe('warn');
        expect(entries[1].msg).toBe('error');
    });

    it('respects limit parameter', () => {
        const store = new LogStore();

        for (let i = 0; i < 10; i++) {
            store.write({ level: 30, time: i * 1000, msg: `msg-${i}` });
        }

        const entries = store.getEntries(undefined, undefined, 3);
        expect(entries).toHaveLength(3);
        expect(entries[0].msg).toBe('msg-7');
    });

    it('notifies subscribers on write', () => {
        const store = new LogStore();
        const received: unknown[] = [];
        const unsubscribe = store.subscribe((entry) => received.push(entry));

        store.write({ level: 30, time: 1000, msg: 'hello' });
        store.write({ level: 40, time: 2000, msg: 'world' });

        expect(received).toHaveLength(2);
        expect(received[0].msg).toBe('hello');
        expect(received[1].msg).toBe('world');

        unsubscribe();
        store.write({ level: 50, time: 3000, msg: 'after' });
        expect(received).toHaveLength(2);
    });

    it('clear removes all entries', () => {
        const store = new LogStore();
        store.write({ level: 30, time: 1000, msg: 'a' });
        store.write({ level: 30, time: 2000, msg: 'b' });

        expect(store.size).toBe(2);
        store.clear();
        expect(store.size).toBe(0);
        expect(store.getEntries()).toHaveLength(0);
    });

    it('preserves extra fields from pino log entries', () => {
        const store = new LogStore();
        store.write({ level: 30, time: 1000, msg: 'test', integration: 'github', requestId: 'abc123' });

        const entries = store.getEntries();
        expect(entries[0].integration).toBe('github');
        expect(entries[0].requestId).toBe('abc123');
    });

    it('handles unknown level numbers', () => {
        const store = new LogStore();
        store.write({ level: 99, time: 1000, msg: 'unknown' });

        const entries = store.getEntries();
        expect(entries[0].levelName).toBe('info');
    });
});
