import { describe, it, expect } from 'vitest';
import { PtyTicketStore } from '../core/pty-ticket-store.js';

describe('PtyTicketStore', () => {
    it('accepts a freshly minted ticket exactly once', () => {
        const store = new PtyTicketStore();
        const ticket = store.mint();
        expect(store.consume(ticket)).toBe(true);
        // Single use: a replay fails.
        expect(store.consume(ticket)).toBe(false);
    });

    it('rejects unknown / empty tickets', () => {
        const store = new PtyTicketStore();
        expect(store.consume('never-minted')).toBe(false);
        expect(store.consume(undefined)).toBe(false);
        expect(store.consume(null)).toBe(false);
        expect(store.consume('')).toBe(false);
    });

    it('rejects an expired ticket and consumes it', () => {
        const store = new PtyTicketStore(-1); // already expired on mint
        const ticket = store.mint();
        expect(store.consume(ticket)).toBe(false);
    });

    it('mints unique tickets', () => {
        const store = new PtyTicketStore();
        const a = store.mint();
        const b = store.mint();
        expect(a).not.toBe(b);
    });
});
