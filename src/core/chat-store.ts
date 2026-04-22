/**
 * On-disk store for chat sessions.
 *
 * Layout under `~/.sokuza/chat-sessions/<sessionId>/`:
 *
 *   metadata.json  — a single `ChatSession` record
 *   messages.jsonl — one JSON-per-line `ChatMessage`, append-only
 *   workdir/       — the cloned git repo for this session (created by
 *                    github-clone-repo via its `destDir` param)
 *
 * Append-only JSONL keeps per-turn writes cheap, survives crashes
 * (no partial rewrites), and makes streaming readers trivial. There is
 * no DB — just the filesystem.
 *
 * All methods are safe to call concurrently per-session: each session's
 * writes go through a write lock so interleaved appends don't corrupt
 * `messages.jsonl`.
 */

import { mkdir, readFile, writeFile, appendFile, readdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { ChatMessage, ChatSession, SessionScope, ChatMessageRole, ChatToolCall, ChatToolResult } from './types.js';

const SESSIONS_DIR = join(homedir(), '.sokuza', 'chat-sessions');
const METADATA_FILE = 'metadata.json';
const MESSAGES_FILE = 'messages.jsonl';
const WORKDIR_NAME = 'workdir';

export interface CreateSessionParams {
    scope: SessionScope;
    provider: string;
    title?: string;
}

export interface AppendMessageParams {
    role: ChatMessageRole;
    content: string;
    toolCall?: ChatToolCall;
    toolResult?: ChatToolResult;
}

export class ChatStore {
    private readonly logger: Logger;
    private readonly baseDir: string;
    /** Per-session write locks so concurrent appends don't interleave. */
    private writeLocks = new Map<string, Promise<void>>();

    constructor(logger: Logger, baseDir: string = SESSIONS_DIR) {
        this.logger = logger;
        this.baseDir = baseDir;
    }

    private sessionDir(sessionId: string): string {
        return join(this.baseDir, sessionId);
    }

    /** Absolute path to the workdir a session should clone into. */
    workdirFor(sessionId: string): string {
        return join(this.sessionDir(sessionId), WORKDIR_NAME);
    }

    /**
     * Create a new session record on disk. Does NOT clone the repo —
     * the caller (API handler) invokes `githubCloneRepoAction` with
     * `destDir: store.workdirFor(id)` separately, because cloning
     * involves workflow-engine types that don't belong in the store.
     */
    async createSession(params: CreateSessionParams): Promise<ChatSession> {
        const id = generateSessionId();
        const now = new Date().toISOString();
        const session: ChatSession = {
            id,
            scope: params.scope,
            workdir: this.workdirFor(id),
            provider: params.provider,
            title: params.title?.trim() || autoTitle(params.scope),
            createdAt: now,
            updatedAt: now,
            status: 'active',
        };

        await mkdir(this.sessionDir(id), { recursive: true });
        await writeFile(join(this.sessionDir(id), METADATA_FILE), JSON.stringify(session, null, 2), 'utf-8');
        // Session metadata may reference provider API keys indirectly —
        // constrain to owner read/write like the main config file.
        await chmod(join(this.sessionDir(id), METADATA_FILE), 0o600).catch(() => undefined);
        // Pre-create an empty messages log so readers don't have to special-case
        // the missing-file state.
        await writeFile(join(this.sessionDir(id), MESSAGES_FILE), '', 'utf-8');

        this.logger.info({ sessionId: id, scope: params.scope.kind }, 'Chat session created');
        return session;
    }

    async getSession(sessionId: string): Promise<ChatSession | null> {
        const metaPath = join(this.sessionDir(sessionId), METADATA_FILE);
        if (!existsSync(metaPath)) return null;
        const raw = await readFile(metaPath, 'utf-8');
        return JSON.parse(raw) as ChatSession;
    }

    async listSessions(): Promise<ChatSession[]> {
        if (!existsSync(this.baseDir)) return [];
        const entries = await readdir(this.baseDir, { withFileTypes: true });
        const sessions: ChatSession[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const meta = await this.getSession(entry.name).catch(() => null);
            if (meta) sessions.push(meta);
        }
        // Newest first.
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return sessions;
    }

    /** Merge a partial update into the session record and bump `updatedAt`. */
    async updateSession(
        sessionId: string,
        patch: Partial<Pick<ChatSession, 'title' | 'status'>>,
    ): Promise<ChatSession | null> {
        return this.withLock(sessionId, async () => {
            const current = await this.getSession(sessionId);
            if (!current) return null;
            const next: ChatSession = {
                ...current,
                ...patch,
                updatedAt: new Date().toISOString(),
            };
            await writeFile(
                join(this.sessionDir(sessionId), METADATA_FILE),
                JSON.stringify(next, null, 2),
                'utf-8',
            );
            await chmod(join(this.sessionDir(sessionId), METADATA_FILE), 0o600).catch(() => undefined);
            return next;
        });
    }

    /** Remove the entire session directory — metadata, messages, workdir. */
    async deleteSession(sessionId: string): Promise<boolean> {
        const dir = this.sessionDir(sessionId);
        if (!existsSync(dir)) return false;
        await rm(dir, { recursive: true, force: true });
        this.logger.info({ sessionId }, 'Chat session deleted');
        return true;
    }

    async appendMessage(sessionId: string, params: AppendMessageParams): Promise<ChatMessage> {
        return this.withLock(sessionId, async () => {
            const session = await this.getSession(sessionId);
            if (!session) throw new Error(`Chat session "${sessionId}" not found`);

            const message: ChatMessage = {
                id: generateMessageId(),
                role: params.role,
                content: params.content,
                toolCall: params.toolCall,
                toolResult: params.toolResult,
                createdAt: new Date().toISOString(),
            };

            await appendFile(
                join(this.sessionDir(sessionId), MESSAGES_FILE),
                JSON.stringify(message) + '\n',
                'utf-8',
            );

            // Bump updatedAt without going through updateSession (to avoid
            // recursive lock — we already hold it).
            const nextMeta: ChatSession = { ...session, updatedAt: message.createdAt };
            await writeFile(
                join(this.sessionDir(sessionId), METADATA_FILE),
                JSON.stringify(nextMeta, null, 2),
                'utf-8',
            );

            return message;
        });
    }

    async getMessages(sessionId: string): Promise<ChatMessage[]> {
        const path = join(this.sessionDir(sessionId), MESSAGES_FILE);
        if (!existsSync(path)) return [];
        const raw = await readFile(path, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim());
        const messages: ChatMessage[] = [];
        for (const line of lines) {
            try {
                messages.push(JSON.parse(line) as ChatMessage);
            } catch (err) {
                this.logger.warn({ sessionId, line: line.slice(0, 100), err }, 'Skipping corrupt message line');
            }
        }
        return messages;
    }

    /**
     * Serialize writes per-session. Reads don't take the lock — they
     * operate on an eventually-consistent snapshot, which is fine for a
     * JSONL log that only grows.
     */
    private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.writeLocks.get(sessionId) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => { release = resolve; });
        this.writeLocks.set(sessionId, prev.then(() => next));
        try {
            await prev;
            return await fn();
        } finally {
            release();
            // Best-effort garbage collection: drop the lock entry when the
            // chain drains so we don't leak entries for long-dead sessions.
            if (this.writeLocks.get(sessionId) === next) {
                this.writeLocks.delete(sessionId);
            }
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateSessionId(): string {
    // Timestamp prefix keeps sessions sortable by creation even if the
    // random bits collide (unlikely with 8 bytes = 16 hex chars).
    const ts = Date.now().toString(36);
    const rand = randomBytes(8).toString('hex');
    return `${ts}-${rand}`;
}

function generateMessageId(): string {
    return randomBytes(8).toString('hex');
}

function autoTitle(scope: SessionScope): string {
    switch (scope.kind) {
        case 'repo':
            return scope.repo;
        case 'branch':
            return `${scope.repo} @ ${scope.ref}`;
        case 'pr': {
            const prBit = `PR #${scope.prNumber}`;
            return scope.title ? `${prBit}: ${scope.title}` : `${scope.repo} ${prBit}`;
        }
    }
}
