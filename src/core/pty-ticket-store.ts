/**
 * Short-lived, single-use tickets that authorize a PTY WebSocket attach.
 *
 * Browsers can't set an Authorization header on a WebSocket, and the
 * dashboard bearer token grants interactive host-shell access — so we must
 * not put the long-lived token in the WebSocket URL (query strings leak into
 * access logs, proxy logs, and browser history). Instead the dashboard mints
 * a ticket via an authenticated `POST /api/pty/ticket` (Authorization header,
 * not logged), then passes only that ticket in the WS URL. The ticket is
 * valid once and for a few seconds — long enough to open the socket, useless
 * afterward.
 */
import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 15_000;
/** Hard cap so unconsumed tickets can't grow without bound if minting
 *  outpaces consumption + expiry. */
const MAX_TICKETS = 1_000;

export class PtyTicketStore {
    private tickets = new Map<string, number>(); // ticket -> expiry epoch ms

    constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

    /** Mint a fresh single-use ticket. */
    mint(): string {
        this.prune();
        const ticket = randomBytes(24).toString('base64url');
        this.tickets.set(ticket, Date.now() + this.ttlMs);
        // Last-resort cap if minting outpaces expiry (Map is insertion-ordered,
        // so the first keys are the oldest).
        while (this.tickets.size > MAX_TICKETS) {
            const oldest = this.tickets.keys().next().value;
            if (oldest === undefined) break;
            this.tickets.delete(oldest);
        }
        return ticket;
    }

    /**
     * Validate and consume a ticket. Returns true only if it existed and had
     * not expired. The ticket is removed regardless, so it can never be
     * replayed.
     */
    consume(ticket: string | undefined | null): boolean {
        // Also sweep expired tickets here so they don't linger in a
        // long-running process that has stopped minting.
        this.prune();
        if (!ticket) return false;
        const expiry = this.tickets.get(ticket);
        if (expiry === undefined) return false;
        this.tickets.delete(ticket);
        return expiry > Date.now();
    }

    private prune(): void {
        const now = Date.now();
        // Collect-then-delete rather than mutating the Map mid-iteration.
        const expired: string[] = [];
        for (const [ticket, expiry] of this.tickets) {
            if (expiry <= now) expired.push(ticket);
        }
        for (const ticket of expired) this.tickets.delete(ticket);
    }
}
