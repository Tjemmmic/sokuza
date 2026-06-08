/**
 * CLI session transcript watcher.
 *
 * Surfaces transcripts of locally-run Claude Code sessions in Sokuza's
 * dashboard. Claude Code writes JSONL transcripts to
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (one JSON object per
 * line, appended as the session progresses) — NOT to a `.claude/sessions/`
 * folder inside the repo, as an earlier plan assumed. This watcher tails those
 * files and broadcasts compact per-entry events to the dashboard event stream.
 *
 * The watch root defaults to `~/.claude/projects` and is overridable via
 * `SOKUZA_CLI_SESSIONS_DIR` (used by tests and non-default Claude setups).
 *
 * chokidar v4 dropped glob support, so we watch the root recursively and
 * filter to `.jsonl` files in the `ignored` predicate + handlers. Each file is
 * tailed by byte offset so only newly-appended, complete lines are emitted.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { open, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, basename, dirname } from 'node:path';
import type { Logger } from 'pino';

export interface TranscriptEvent {
    type: 'cli-transcript';
    /** Encoded project directory name (Claude's slugged cwd). */
    project: string;
    /** Transcript file id (filename without `.jsonl`). */
    sessionId: string;
    /** The transcript entry's own `type`, e.g. 'user' | 'assistant'. */
    entryType?: string;
    /** Message role when present. */
    role?: string;
    /** Short, capped text preview of the entry. */
    preview?: string;
    /** Entry timestamp (from the line if present, else ingest time). */
    timestamp: string;
}

export type TranscriptListener = (event: TranscriptEvent) => void;

export interface SessionWatcherOptions {
    logger: Logger;
    onEvent: TranscriptListener;
    /** Override the watch root. Falls back to env then ~/.claude/projects. */
    rootDir?: string;
}

const PREVIEW_MAX = 500;

/** Resolve the transcript root: explicit arg → env → default. */
export function defaultTranscriptRoot(): string {
    return process.env.SOKUZA_CLI_SESSIONS_DIR ?? join(homedir(), '.claude', 'projects');
}

export class SessionWatcher {
    private watcher: FSWatcher | null = null;
    private offsets = new Map<string, number>();
    /** Per-file ingest chains so two rapid events for the same file can't both
     *  read the same offset and emit duplicate entries. */
    private chains = new Map<string, Promise<void>>();
    private readonly root: string;
    private readonly logger: Logger;
    private readonly onEvent: TranscriptListener;

    constructor(opts: SessionWatcherOptions) {
        this.root = opts.rootDir ?? defaultTranscriptRoot();
        this.logger = opts.logger;
        this.onEvent = opts.onEvent;
    }

    async start(): Promise<void> {
        if (this.watcher) return;
        if (!existsSync(this.root)) {
            this.logger.info(
                { root: this.root },
                'CLI transcript dir not found — session watcher idle (set SOKUZA_CLI_SESSIONS_DIR to override)',
            );
            return;
        }
        // Prime offsets for files that already exist so a restart only emits
        // genuinely-new appends, not the entire backlog of in-flight sessions.
        // Awaited before attaching handlers so a `change` can't fire before
        // its offset is seeded.
        await this.seedOffsets();
        this.watcher = chokidar.watch(this.root, {
            ignoreInitial: true,
            persistent: true,
            // Watch directories; only act on `.jsonl` files.
            ignored: (p: string, stats?: { isFile(): boolean }) =>
                stats?.isFile() === true && !p.endsWith('.jsonl'),
        });
        const handle = (p: string) => { void this.ingest(p); };
        this.watcher.on('add', handle);
        this.watcher.on('change', handle);
        this.watcher.on('error', (err) => this.logger.warn({ err }, 'Session watcher error'));
        this.logger.info({ root: this.root }, 'CLI session watcher started');
    }

    /** Record the current size of every existing `.jsonl` file so we tail from
     *  the end on a restart rather than replaying historical entries.
     *  Async so it never blocks the event loop during engine startup. */
    private async seedOffsets(): Promise<void> {
        let entries: string[];
        try {
            entries = await readdir(this.root, { recursive: true }) as string[];
        } catch {
            return;
        }
        for (const rel of entries) {
            if (typeof rel !== 'string' || !rel.endsWith('.jsonl')) continue;
            const abs = join(this.root, rel);
            try {
                this.offsets.set(abs, (await stat(abs)).size);
            } catch {
                /* file vanished mid-scan; ignore */
            }
        }
    }

    async stop(): Promise<void> {
        if (!this.watcher) return;
        await this.watcher.close();
        this.watcher = null;
        this.offsets.clear();
        this.chains.clear();
    }

    /**
     * Tail `filePath` from the last byte offset and emit one event per newly
     * appended, complete JSONL line. Serialized per file so concurrent
     * filesystem events can't double-read the same offset. Public for direct
     * testing (no chokidar).
     */
    ingest(filePath: string): Promise<void> {
        const prev = this.chains.get(filePath) ?? Promise.resolve();
        const next = prev
            .catch(() => undefined)
            .then(() => this.ingestOnce(filePath));
        this.chains.set(filePath, next);
        // Drop the chain entry once it's the settled tail, so the map doesn't
        // grow unbounded across many files.
        void next.finally(() => {
            if (this.chains.get(filePath) === next) this.chains.delete(filePath);
        });
        return next;
    }

    /** One tail pass: read only the bytes appended since the last offset. */
    private async ingestOnce(filePath: string): Promise<void> {
        if (!filePath.endsWith('.jsonl')) return;
        let handle;
        try {
            handle = await open(filePath, 'r');
        } catch {
            return; // file vanished between event and read
        }
        try {
            const { size } = await handle.stat();
            let offset = this.offsets.get(filePath) ?? 0;
            if (offset > size) offset = 0; // truncated / rotated
            if (offset >= size) return; // nothing new

            const buf = Buffer.allocUnsafe(size - offset);
            const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
            const slice = buf.subarray(0, bytesRead);
            const lastNl = slice.lastIndexOf(0x0a);
            if (lastNl < 0) return; // no complete line appended yet
            this.offsets.set(filePath, offset + lastNl + 1);

            const text = slice.subarray(0, lastNl + 1).toString('utf8');
            const project = relativeProject(this.root, filePath);
            const sessionId = basename(filePath, '.jsonl');
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    continue; // skip non-JSON / partially-written lines defensively
                }
                this.onEvent(buildEvent(parsed, project, sessionId));
            }
        } finally {
            await handle.close();
        }
    }
}

/** Directory name of the transcript file relative to the watch root. */
function relativeProject(root: string, filePath: string): string {
    const rel = relative(root, dirname(filePath));
    return rel || basename(dirname(filePath));
}

/** Extract a compact, display-friendly event from a raw transcript line. */
export function buildEvent(parsed: unknown, project: string, sessionId: string): TranscriptEvent {
    const entry = (parsed ?? {}) as Record<string, any>;
    const entryType = typeof entry.type === 'string' ? entry.type : undefined;
    const role: string | undefined = entry.message?.role ?? (typeof entry.role === 'string' ? entry.role : undefined);
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();

    return {
        type: 'cli-transcript',
        project,
        sessionId,
        entryType,
        role,
        preview: extractPreview(entry),
        timestamp,
    };
}

/** Pull a short human preview out of a transcript entry, tolerant of the
 *  several content shapes Claude Code emits. */
function extractPreview(entry: Record<string, any>): string | undefined {
    const content = entry.message?.content ?? entry.content;
    let preview: string | undefined;

    if (typeof content === 'string') {
        preview = content;
    } else if (Array.isArray(content)) {
        const textPart = content.find((p) => p?.type === 'text' && typeof p.text === 'string');
        if (textPart) {
            preview = textPart.text;
        } else {
            const toolUse = content.find((p) => p?.type === 'tool_use');
            if (toolUse) preview = `[tool_use: ${toolUse.name ?? 'tool'}]`;
            else {
                const toolResult = content.find((p) => p?.type === 'tool_result');
                if (toolResult) preview = '[tool_result]';
            }
        }
    } else if (typeof entry.summary === 'string') {
        preview = entry.summary;
    }

    if (preview && preview.length > PREVIEW_MAX) {
        preview = preview.slice(0, PREVIEW_MAX) + '…';
    }
    return preview;
}
