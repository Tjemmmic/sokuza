/**
 * PTY HTTP + WebSocket routes.
 *
 * Registered as an encapsulated plugin that loads `@fastify/websocket` first,
 * so the `{ websocket: true }` route below is recognised. The parent registers
 * the Host guard and bearer-token auth gate BEFORE this plugin.
 *
 * Auth: the HTTP routes are gated by the bearer token via the parent auth gate.
 * The WebSocket attach can't carry an Authorization header (browser limit) and
 * must not carry the long-lived token in its URL (it grants shell access), so
 * it authenticates a short-lived single-use TICKET instead — minted by the
 * authenticated `POST /api/pty/ticket` and verified in-handler. The auth gate
 * exempts only the WS upgrade to /api/pty/* for this reason.
 *
 *   POST   /api/pty/ticket     — mint a single-use WebSocket ticket
 *   POST   /api/pty/spawn      — start a session (optionally for a repo/PR)
 *   GET    /api/pty/sessions   — list active sessions
 *   DELETE /api/pty/:id        — kill a session
 *   GET    /api/pty/:id  (WS)  — attach: stream output, accept input/resize
 */
import fastifyWebsocket from '@fastify/websocket';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { PTYManager } from '../core/pty-manager.js';
import type { WorkdirManager } from '../core/workdir-store.js';
import { PtyTicketStore } from '../core/pty-ticket-store.js';

export interface PtyRoutesDeps {
    ptyManager: PTYManager;
    logger: Logger;
    getWorkdirManager: () => WorkdirManager;
}

/** Owner/repo segment validation — mirrors the workdir API's ID_RE. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

interface SpawnBody {
    command?: string;
    args?: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
    owner?: string;
    repo?: string;
    pr?: number | string;
    label?: string;
}

/** Default interactive command when the caller doesn't specify one — the
 *  user's login shell, falling back to bash. Returns the BASENAME (PATH-
 *  resolved) so it satisfies the allow-list, which rejects path-qualified
 *  commands (e.g. SHELL=/bin/bash → "bash"). */
function defaultCommand(): string {
    const shell = process.env.SHELL?.trim();
    if (shell) return basename(shell);
    return 'bash';
}

/**
 * Register the PTY routes onto an instance that has `@fastify/websocket`
 * available. Call inside an encapsulated plugin (see engine wiring).
 */
export function registerPtyRoutes(server: FastifyInstance, deps: PtyRoutesDeps): void {
    const { ptyManager, logger } = deps;
    // Single ticket store per server: tickets are minted and consumed within
    // this closure, and the auth gate's WS exemption relies on the attach
    // handler consuming from the same store. ptyPlugin is registered exactly
    // once by the engine, so this is a coherent singleton — do not register
    // the plugin more than once.
    const tickets = new PtyTicketStore();

    // Mint a single-use WebSocket ticket. Gated by the bearer token via the
    // parent auth gate (this is a normal POST, not a WS upgrade).
    server.post('/api/pty/ticket', async () => {
        return { ticket: tickets.mint() };
    });

    server.post('/api/pty/spawn', async (request, reply) => {
        const raw = request.body;
        // Defend against a misconfigured body parser handing us a string,
        // Buffer, or array: a type assertion would let property access silently
        // yield undefined, and this route resolves a filesystem cwd from it.
        if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
            return reply.status(400).send({ error: 'request body must be a JSON object' });
        }
        const body = (raw ?? {}) as SpawnBody;

        // Resolve cwd: an explicit repo/PR triple wins (spawn inside the
        // persistent auto-fix workdir), otherwise an explicit cwd, otherwise
        // the engine's working directory.
        let cwd = body.cwd;
        if (body.owner || body.repo || body.pr !== undefined) {
            const owner = String(body.owner ?? '');
            const repo = String(body.repo ?? '');
            const prRaw = String(body.pr ?? '');
            if (!ID_RE.test(owner) || !ID_RE.test(repo) || !/^\d{1,8}$/.test(prRaw)) {
                return reply.status(400).send({ error: 'invalid owner/repo/pr' });
            }
            cwd = deps.getWorkdirManager().repoPath(owner, repo, parseInt(prRaw, 10));
        }
        cwd = cwd || process.cwd();

        const command = body.command?.trim() || defaultCommand();
        try {
            const info = await ptyManager.createSession({
                command,
                args: Array.isArray(body.args) ? body.args.map(String) : [],
                cwd,
                cols: body.cols,
                rows: body.rows,
                label: typeof body.label === 'string' ? body.label : undefined,
            });
            return reply.status(201).send({ session: info });
        } catch (err: any) {
            // PTYManager tags client errors (bad command / cwd / session cap)
            // with an HTTP status; anything else (e.g. missing native binding)
            // is a 500 we log.
            const status = typeof err?.status === 'number' ? err.status : 500;
            const msg = err?.message ?? 'failed to spawn PTY';
            if (status === 500) logger.error({ err, command, cwd }, 'PTY spawn failed');
            return reply.status(status).send({ error: msg });
        }
    });

    server.get('/api/pty/sessions', async () => {
        return { sessions: ptyManager.list() };
    });

    server.delete('/api/pty/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const killed = ptyManager.kill(id);
        if (!killed) return reply.status(404).send({ error: 'unknown session' });
        return { ok: true };
    });

    // ─── WebSocket attach ───────────────────────────────────────────────────
    server.get<{ Params: { id: string }; Querystring: { ticket?: string } }>(
        '/api/pty/:id',
        { websocket: true },
        (socket, request) => {
            // Explicit per-route auth: this route is exempt from the bearer
            // gate (see auth.ts), so it MUST verify the single-use ticket here.
            if (!tickets.consume(request.query.ticket)) {
                socket.close(1008, 'unauthorized');
                return;
            }
            const { id } = request.params;
            const info = ptyManager.get(id);
            if (!info) {
                // 1008 = policy violation; the closest standard code for
                // "this resource doesn't exist".
                socket.close(1008, 'unknown session');
                return;
            }
            if (info.status === 'exited') {
                // The session already exited (retained briefly for late
                // attaches). The 'exit' event has already fired and won't fire
                // again, so report it now and close rather than hang.
                trySend(socket, { type: 'ready', session: info });
                trySend(socket, { type: 'exit', exitCode: info.exitCode ?? null });
                try { socket.close(1000, 'session exited'); } catch { /* already closing */ }
                return;
            }

            const onData = (sid: string, chunk: string) => {
                if (sid !== id) return;
                trySend(socket, { type: 'output', data: chunk });
            };
            const onExit = (sid: string, exitCode: number) => {
                if (sid !== id) return;
                trySend(socket, { type: 'exit', exitCode });
                try { socket.close(1000, 'session exited'); } catch { /* already closing */ }
            };

            ptyManager.on('data', onData);
            ptyManager.on('exit', onExit);

            // Greet with current session metadata so the client can size the
            // terminal to match.
            trySend(socket, { type: 'ready', session: info });

            socket.on('message', (raw: Buffer) => {
                let msg: { type?: string; data?: string; cols?: number; rows?: number };
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return; // ignore malformed frames
                }
                try {
                    if (msg.type === 'input' && typeof msg.data === 'string') {
                        ptyManager.write(id, msg.data);
                    } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                        ptyManager.resize(id, msg.cols, msg.rows);
                    }
                } catch (err) {
                    // The session may have exited between attach and write.
                    trySend(socket, { type: 'error', error: (err as Error).message });
                }
            });

            const cleanup = () => {
                ptyManager.off('data', onData);
                ptyManager.off('exit', onExit);
            };
            socket.on('close', cleanup);
            socket.on('error', cleanup);
        },
    );
}

/** Send a JSON frame, swallowing errors from a socket that's mid-close. */
function trySend(socket: { send: (data: string) => void }, payload: unknown): void {
    try {
        socket.send(JSON.stringify(payload));
    } catch {
        /* client gone */
    }
}

/** The websocket plugin + PTY routes as one encapsulated Fastify plugin.
 *  Awaiting the inner register guarantees the websocket onRoute hook is
 *  installed before the `{ websocket: true }` route is added. */
export async function ptyPlugin(server: FastifyInstance, deps: PtyRoutesDeps): Promise<void> {
    await server.register(fastifyWebsocket, { options: { maxPayload: 1 << 20 } });
    registerPtyRoutes(server, deps);
}
