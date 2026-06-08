/**
 * In-memory store of human-in-the-loop questions raised by the MCP
 * `sokuza_ask_human` tool.
 *
 * An external CLI (e.g. Claude Code talking to `sokuza mcp`) POSTs a question
 * to the running engine; the engine parks it here and broadcasts it to the
 * dashboard, where a human types an answer that resolves the entry. The MCP
 * tool long-polls until the answer appears.
 *
 * State is intentionally process-local and ephemeral: a pending question only
 * matters while both the asking CLI and the dashboard are live. Entries are
 * pruned by TTL (answered questions) and a hard cap (defensive upper bound).
 */
import { randomBytes } from 'node:crypto';

export interface McpAsk {
    id: string;
    prompt: string;
    /** Optional source label, e.g. "claude-code". */
    source?: string;
    createdAt: string;
    status: 'pending' | 'answered';
    answer?: string;
    answeredAt?: string;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

export class McpAskStore {
    private asks = new Map<string, McpAsk>();

    constructor(
        private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
    ) {}

    create(prompt: string, source?: string): McpAsk {
        const id = randomBytes(9).toString('base64url');
        const ask: McpAsk = {
            id,
            prompt,
            source,
            createdAt: new Date().toISOString(),
            status: 'pending',
        };
        this.asks.set(id, ask);
        // Prune AFTER inserting so the size cap holds for the post-create
        // state (size <= maxEntries), including the entry we just added.
        this.prune();
        return ask;
    }

    get(id: string): McpAsk | undefined {
        return this.asks.get(id);
    }

    /** Resolve a pending question. Returns the updated entry, or undefined if
     *  the id is unknown. Answering an already-answered entry is a no-op that
     *  returns the existing entry. */
    answer(id: string, answer: string): McpAsk | undefined {
        const ask = this.asks.get(id);
        if (!ask) return undefined;
        if (ask.status === 'pending') {
            ask.status = 'answered';
            ask.answer = answer;
            ask.answeredAt = new Date().toISOString();
        }
        return ask;
    }

    listPending(): McpAsk[] {
        return [...this.asks.values()].filter((a) => a.status === 'pending');
    }

    private prune(): void {
        const now = Date.now();
        // Collect-then-delete rather than mutating the Map mid-iteration.
        const expired: string[] = [];
        for (const [id, ask] of this.asks) {
            if (ask.status === 'answered' && ask.answeredAt
                && now - Date.parse(ask.answeredAt) > this.ttlMs) {
                expired.push(id);
            }
        }
        for (const id of expired) this.asks.delete(id);

        // Hard cap. Evict ANSWERED entries first (oldest → newest) so a burst
        // of new questions can't drop a still-pending ask out from under a
        // blocked `sokuza_ask_human` caller. Only if the store is somehow full
        // of pending asks do we evict the oldest pending as a last resort.
        if (this.asks.size > this.maxEntries) {
            const evict = new Set<string>(); // Set for O(1) membership checks
            let over = this.asks.size - this.maxEntries;
            for (const [id, ask] of this.asks) {
                if (over <= 0) break;
                if (ask.status === 'answered') { evict.add(id); over--; }
            }
            if (over > 0) {
                for (const id of this.asks.keys()) {
                    if (over <= 0) break;
                    if (!evict.has(id)) { evict.add(id); over--; }
                }
            }
            for (const id of evict) this.asks.delete(id);
        }
    }
}
