import { Writable } from 'node:stream';

export interface LogEntry {
    level: number;
    time: number;
    msg: string;
    [key: string]: unknown;
}

const MAX_LOG_ENTRIES = 1000;
const LOG_LEVELS: Record<number, string> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};

function levelName(num: number): string {
    return LOG_LEVELS[num] ?? 'info';
}

export class LogStore extends Writable {
    private entries: LogEntry[] = [];
    private subscribers = new Set<(entry: LogEntry) => void>();

    constructor(private maxSize = MAX_LOG_ENTRIES) {
        super({ objectMode: true });
    }

    _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
        let record: LogEntry;
        if (typeof chunk === 'string') {
            try { record = JSON.parse(chunk); } catch { callback(); return; }
        } else if (typeof chunk === 'object' && chunk !== null) {
            record = chunk as LogEntry;
        } else {
            callback();
            return;
        }

        if (this.entries.length >= this.maxSize) {
            this.entries.shift();
        }

        const entry: LogEntry = {
            ...record,
            levelName: levelName(record.level ?? 30),
        };

        this.entries.push(entry);

        for (const cb of this.subscribers) {
            try { cb(entry); } catch { /* swallow */ }
        }

        callback();
    }

    getEntries(since?: number, level?: string, limit = 200): LogEntry[] {
        let result = this.entries;

        if (since) {
            result = result.filter((e) => e.time > since);
        }

        if (level) {
            const target = Object.entries(LOG_LEVELS).find(
                ([, name]) => name === level,
            )?.[0];
            if (target) {
                const num = Number(target);
                result = result.filter((e) => e.level >= num);
            }
        }

        return result.slice(-limit);
    }

    subscribe(cb: (entry: LogEntry) => void): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    clear(): void {
        this.entries = [];
    }

    get size(): number {
        return this.entries.length;
    }
}
