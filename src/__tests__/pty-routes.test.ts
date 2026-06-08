import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import pino from 'pino';
import { ptyPlugin } from '../server/pty-routes.js';
import { PTYManager } from '../core/pty-manager.js';
import { registerAuthGate, registerHostGuard, DEFAULT_ALLOWED_HOSTS } from '../server/auth.js';

const logger = pino({ level: 'silent' });
const TOKEN = 'a'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

let server: FastifyInstance;
let port: number;

beforeAll(async () => {
    server = Fastify({ logger: false });
    registerHostGuard(server, DEFAULT_ALLOWED_HOSTS, logger);
    registerAuthGate(server, TOKEN, logger);
    const ptyManager = new PTYManager(logger);
    // Mirror the engine wiring: ptyPlugin in an encapsulated child plugin.
    await server.register(async (instance) => {
        await ptyPlugin(instance, {
            ptyManager,
            logger,
            getWorkdirManager: () => ({ repoPath: () => '/nonexistent' }) as any,
        });
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    port = (server.server.address() as { port: number }).port;
});

afterAll(async () => {
    await server.close();
});

async function mintTicket(): Promise<string> {
    const res = await server.inject({ method: 'POST', url: '/api/pty/ticket', headers: AUTH });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).ticket;
}

function wsConnect(url: string): Promise<{ readyMsg?: any; closeCode?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        let readyMsg: any;
        const done = (extra: object) => { try { ws.close(); } catch { /* */ } resolve({ readyMsg, ...extra }); };
        ws.on('message', (d) => {
            try {
                const m = JSON.parse(d.toString());
                if (m.type === 'ready') { readyMsg = m; done({}); }
            } catch { /* */ }
        });
        ws.on('close', (code) => resolve({ readyMsg, closeCode: code }));
        ws.on('error', () => { /* close event follows */ });
        setTimeout(() => done({ closeCode: -1 }), 4000);
    });
}

describe('PTY routes — ticket + spawn validation', () => {
    it('mints a ticket for an authenticated request', async () => {
        const ticket = await mintTicket();
        expect(typeof ticket).toBe('string');
        expect(ticket.length).toBeGreaterThan(10);
    });

    it('rejects ticket minting without the bearer token', async () => {
        const res = await server.inject({ method: 'POST', url: '/api/pty/ticket' });
        expect(res.statusCode).toBe(401);
    });

    it('rejects a non-object spawn body', async () => {
        const res = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: { ...AUTH, 'content-type': 'application/json' },
            payload: '"i am a string"',
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a disallowed command', async () => {
        const res = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: 'rm', cwd: process.cwd() },
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a path-qualified allowed command (allow-list bypass guard)', async () => {
        const res = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: '/bin/bash', cwd: process.cwd() },
        });
        expect(res.statusCode).toBe(400);
    });

    it('defaults to the login shell basename (no command) — survives the allow-list', async () => {
        const prev = process.env.SHELL;
        process.env.SHELL = '/bin/bash'; // path-qualified $SHELL must still work
        try {
            const res = await server.inject({
                method: 'POST', url: '/api/pty/spawn', headers: AUTH,
                payload: { cwd: process.cwd() },
            });
            expect(res.statusCode).toBe(201);
            const id = JSON.parse(res.payload).session.id;
            expect(JSON.parse(res.payload).session.command).toBe('bash');
            await server.inject({ method: 'DELETE', url: `/api/pty/${id}`, headers: AUTH });
        } finally {
            if (prev === undefined) delete process.env.SHELL; else process.env.SHELL = prev;
        }
    });
});

function wsCollect(url: string): Promise<{ msgs: any[]; closeCode?: number }> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        const msgs: any[] = [];
        ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('close', (code) => resolve({ msgs, closeCode: code }));
        ws.on('error', () => { /* close follows */ });
        setTimeout(() => { try { ws.close(); } catch { /* */ } resolve({ msgs, closeCode: -1 }); }, 4000);
    });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PTY routes — session lifecycle + WebSocket attach', () => {
    it('reports exit and closes when attaching to an already-exited session', async () => {
        const spawn = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: 'bash', args: ['-c', 'exit 0'], cwd: process.cwd() },
        });
        const id = JSON.parse(spawn.payload).session.id;
        await delay(600); // let the fast command exit (retained for late attach)

        const ticket = await mintTicket();
        const { msgs, closeCode } = await wsCollect(`ws://127.0.0.1:${port}/api/pty/${id}?ticket=${ticket}`);
        expect(msgs.some((m) => m.type === 'exit')).toBe(true);
        expect(closeCode).toBe(1000);
    });

    it('spawns, lists, attaches with a valid ticket, then deletes', async () => {
        // spawn
        const spawn = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: 'bash', args: ['-i'], cwd: process.cwd() },
        });
        expect(spawn.statusCode).toBe(201);
        const id = JSON.parse(spawn.payload).session.id;

        // list includes it
        const list = await server.inject({ method: 'GET', url: '/api/pty/sessions', headers: AUTH });
        expect(JSON.parse(list.payload).sessions.some((s: any) => s.id === id)).toBe(true);

        // attach with a valid ticket → ready frame
        const ticket = await mintTicket();
        const attached = await wsConnect(`ws://127.0.0.1:${port}/api/pty/${id}?ticket=${ticket}`);
        expect(attached.readyMsg?.session?.id).toBe(id);

        // delete
        const del = await server.inject({ method: 'DELETE', url: `/api/pty/${id}`, headers: AUTH });
        expect(del.statusCode).toBe(200);
        const del2 = await server.inject({ method: 'DELETE', url: `/api/pty/${id}`, headers: AUTH });
        expect(del2.statusCode).toBe(404);
    });

    it('rejects a WebSocket attach with a missing ticket', async () => {
        const spawn = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: 'bash', args: ['-i'], cwd: process.cwd() },
        });
        const id = JSON.parse(spawn.payload).session.id;
        const res = await wsConnect(`ws://127.0.0.1:${port}/api/pty/${id}`);
        expect(res.readyMsg).toBeUndefined();
        expect(res.closeCode).toBe(1008);
        await server.inject({ method: 'DELETE', url: `/api/pty/${id}`, headers: AUTH });
    });

    it('rejects a replayed (already-consumed) ticket', async () => {
        const spawn = await server.inject({
            method: 'POST', url: '/api/pty/spawn', headers: AUTH,
            payload: { command: 'bash', args: ['-i'], cwd: process.cwd() },
        });
        const id = JSON.parse(spawn.payload).session.id;
        const ticket = await mintTicket();

        const first = await wsConnect(`ws://127.0.0.1:${port}/api/pty/${id}?ticket=${ticket}`);
        expect(first.readyMsg?.session?.id).toBe(id);

        const replay = await wsConnect(`ws://127.0.0.1:${port}/api/pty/${id}?ticket=${ticket}`);
        expect(replay.readyMsg).toBeUndefined();
        expect(replay.closeCode).toBe(1008);

        await server.inject({ method: 'DELETE', url: `/api/pty/${id}`, headers: AUTH });
    });
});
