/**
 * PTY session manager.
 *
 * Spawns interactive developer CLIs (claude, gemini, opencode, codex, a shell)
 * inside real pseudo-terminals and keeps track of the live sessions so the
 * dashboard can attach to them over a WebSocket. node-pty is a native addon;
 * it is imported lazily so that non-interactive entry points (`sokuza mcp`,
 * the headless engine on a box without a compiler) never load it and a missing
 * build degrades to a clear, contained error instead of crashing startup.
 *
 * Security: every spawn is gated by the dashboard bearer token at the route
 * layer. As defense-in-depth this manager additionally restricts the spawnable
 * command to an allow-list of known developer CLIs (plus the user's shell),
 * so an authenticated-but-mistaken request can't launch an arbitrary host
 * binary by absolute path. The allow-list is overridable via
 * `SOKUZA_PTY_ALLOWED_COMMANDS` (comma-separated basenames, or `*` to allow
 * anything for power users who accept the risk).
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
// Type-only import: erased at compile time, so it never pulls the native
// binding into entry points that don't spawn PTYs.
import type { IPty } from 'node-pty';

/** node-pty's module shape — just the bits we use. */
type NodePty = typeof import('node-pty');

export interface PtySessionInfo {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    cols: number;
    rows: number;
    pid: number;
    createdAt: string;
    status: 'running' | 'exited';
    exitCode?: number;
    /** Optional human label, e.g. "claude · owner/repo#42". */
    label?: string;
}

export interface CreateSessionOptions {
    command: string;
    args?: string[];
    cwd: string;
    cols?: number;
    rows?: number;
    /** Extra environment overlaid on top of the inherited process env. */
    env?: Record<string, string>;
    label?: string;
}

interface PtySession {
    info: PtySessionInfo;
    pty: IPty;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Built-in allow-list: the interactive CLIs this feature targets, plus the
 *  common shells a user might want a raw terminal for. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
    'claude', 'gemini', 'opencode', 'codex',
    'bash', 'sh', 'zsh', 'fish',
];

/**
 * Events emitted (all carry the session id as the first argument):
 *   - 'data'   (id: string, chunk: string)   PTY produced output
 *   - 'exit'   (id: string, exitCode: number, signal?: number)
 *   - 'resize' (id: string, cols: number, rows: number)
 */
export class PTYManager extends EventEmitter {
    private sessions = new Map<string, PtySession>();
    private ptyModule: NodePty | null = null;
    private readonly allowed: ReadonlySet<string> | null; // null = allow all

    constructor(private readonly logger: Logger) {
        super();
        // Each attached WebSocket adds a 'data' + 'exit' listener; with many
        // concurrent terminal tabs that exceeds the default cap of 10 and logs
        // a spurious MaxListenersExceededWarning. Listeners are cleaned up on
        // socket close, so lifting the cap is safe.
        this.setMaxListeners(0);
        const override = process.env.SOKUZA_PTY_ALLOWED_COMMANDS?.trim();
        if (override === '*') {
            this.allowed = null;
        } else if (override) {
            this.allowed = new Set(override.split(',').map((s) => s.trim()).filter(Boolean));
        } else {
            this.allowed = new Set(DEFAULT_ALLOWED_COMMANDS);
        }
    }

    /** True if `command` is permitted to be spawned. */
    isAllowed(command: string): boolean {
        if (this.allowed === null) return true;
        return this.allowed.has(basename(command));
    }

    /** The human-readable allow-list, for surfacing in API/UI errors. */
    allowedCommands(): string[] | '*' {
        return this.allowed === null ? '*' : [...this.allowed];
    }

    /** Lazily load node-pty. Cached after first success. Throws a clear,
     *  actionable error if the native binding isn't built. */
    private async loadPty(): Promise<NodePty> {
        if (this.ptyModule) return this.ptyModule;
        try {
            this.ptyModule = await import('node-pty');
            return this.ptyModule;
        } catch (err) {
            throw new Error(
                'node-pty native binding is unavailable — interactive terminals are disabled. ' +
                'Reinstall sokuza in an environment with a build toolchain (Python, make, a C++ compiler). ' +
                `Underlying error: ${(err as Error).message}`,
            );
        }
    }

    async createSession(opts: CreateSessionOptions): Promise<PtySessionInfo> {
        const command = opts.command?.trim();
        if (!command) throw new Error('command is required');
        if (!this.isAllowed(command)) {
            const list = this.allowedCommands();
            throw new Error(
                `command "${command}" is not allowed. Permitted: ${list === '*' ? '*' : list.join(', ')}. ` +
                'Set SOKUZA_PTY_ALLOWED_COMMANDS to change this.',
            );
        }
        if (!opts.cwd || !existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
            throw new Error(`cwd does not exist or is not a directory: ${opts.cwd}`);
        }

        const pty = await this.loadPty();
        const cols = clampDimension(opts.cols, DEFAULT_COLS);
        const rows = clampDimension(opts.rows, DEFAULT_ROWS);

        const child = pty.spawn(command, opts.args ?? [], {
            name: 'xterm-256color',
            cwd: opts.cwd,
            cols,
            rows,
            env: { ...process.env, TERM: 'xterm-256color', ...(opts.env ?? {}) } as Record<string, string>,
        });

        const id = randomBytes(9).toString('base64url');
        const info: PtySessionInfo = {
            id,
            command,
            args: opts.args ?? [],
            cwd: opts.cwd,
            cols,
            rows,
            pid: child.pid,
            createdAt: new Date().toISOString(),
            status: 'running',
            label: opts.label,
        };
        this.sessions.set(id, { info, pty: child });

        child.onData((chunk) => this.emit('data', id, chunk));
        child.onExit(({ exitCode, signal }) => {
            const session = this.sessions.get(id);
            if (session) {
                session.info.status = 'exited';
                session.info.exitCode = exitCode;
            }
            this.emit('exit', id, exitCode, signal);
            // Keep the (exited) record briefly so a late WebSocket attach can
            // still read the exit code, then drop it to avoid unbounded growth.
            setTimeout(() => this.sessions.delete(id), 30_000).unref?.();
        });

        this.logger.info({ id, command, cwd: opts.cwd, pid: child.pid }, 'PTY session created');
        return info;
    }

    write(id: string, data: string): void {
        const session = this.requireRunning(id);
        session.pty.write(data);
    }

    resize(id: string, cols: number, rows: number): void {
        const session = this.requireRunning(id);
        const c = clampDimension(cols, session.info.cols);
        const r = clampDimension(rows, session.info.rows);
        session.pty.resize(c, r);
        session.info.cols = c;
        session.info.rows = r;
        this.emit('resize', id, c, r);
    }

    kill(id: string, signal?: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;
        try {
            session.pty.kill(signal);
        } catch (err) {
            this.logger.warn({ id, err }, 'Failed to kill PTY session');
        }
        this.sessions.delete(id);
        return true;
    }

    /** Terminate every live session. Called on engine shutdown. */
    killAll(): void {
        for (const id of [...this.sessions.keys()]) this.kill(id);
    }

    get(id: string): PtySessionInfo | undefined {
        return this.sessions.get(id)?.info;
    }

    /** Active (running) sessions. Exited sessions linger in the map for a short
     *  grace period so a late WebSocket attach can read the exit code via
     *  get(), but they're excluded here so the dashboard list shows no stale
     *  entries. */
    list(): PtySessionInfo[] {
        return [...this.sessions.values()]
            .map((s) => s.info)
            .filter((info) => info.status === 'running');
    }

    private requireRunning(id: string): PtySession {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`unknown PTY session: ${id}`);
        if (session.info.status !== 'running') throw new Error(`PTY session has exited: ${id}`);
        return session;
    }
}

/** Clamp a terminal dimension to a sane positive range; fall back on garbage. */
function clampDimension(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(1000, Math.floor(value)));
}
