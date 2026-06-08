import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import pino from 'pino';
import {
    loadOrCreateDashboardToken,
    registerAuthGate,
    registerHostGuard,
    parseHostHeader,
    DEFAULT_ALLOWED_HOSTS,
    rotateDashboardToken,
    tokenFilePath,
    tokensEqual,
} from '../server/auth.js';

const logger = pino({ level: 'silent' });

let sandbox: string;
const realHome = process.env.HOME;

beforeEach(async () => {
    sandbox = join(tmpdir(), `sokuza-auth-test-${process.pid}-${Date.now()}`);
    await mkdir(sandbox, { recursive: true });
    process.env.HOME = sandbox;
});

afterEach(async () => {
    process.env.HOME = realHome;
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

describe('loadOrCreateDashboardToken', () => {
    it('creates a 64-char hex token on first call', async () => {
        const token = await loadOrCreateDashboardToken();
        expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('reuses the existing token on subsequent calls', async () => {
        const first = await loadOrCreateDashboardToken();
        const second = await loadOrCreateDashboardToken();
        expect(first).toBe(second);
    });

    it('stores the token at ~/.sokuza/dashboard-token', async () => {
        await loadOrCreateDashboardToken();
        const stored = (await readFile(tokenFilePath(), 'utf-8')).trim();
        expect(stored).toMatch(/^[a-f0-9]{64}$/);
    });

    it('writes with 0600 so other local users cannot read it', async () => {
        if (process.platform === 'win32') return;
        await loadOrCreateDashboardToken();
        const mode = statSync(tokenFilePath()).mode & 0o777;
        expect(mode).toBe(0o600);
    });
});

describe('rotateDashboardToken', () => {
    it('produces a different token from the previous one', async () => {
        const before = await loadOrCreateDashboardToken();
        const after = await rotateDashboardToken();
        expect(after).not.toBe(before);
        expect(after).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('tokensEqual', () => {
    it('returns true for identical strings', () => {
        expect(tokensEqual('abc', 'abc')).toBe(true);
    });

    it('returns false for different-length strings without crashing', () => {
        expect(tokensEqual('abc', 'abcd')).toBe(false);
    });

    it('returns false for undefined input', () => {
        expect(tokensEqual(undefined, 'abc')).toBe(false);
    });

    it('returns false for different same-length strings', () => {
        expect(tokensEqual('abc', 'abd')).toBe(false);
    });
});

describe('registerAuthGate', () => {
    const TOKEN = 'f'.repeat(64);

    function newServer() {
        const s = Fastify({ logger: false });
        registerAuthGate(s, TOKEN, logger);
        s.get('/health', async () => ({ ok: true }));
        s.get('/api/ping', async () => ({ pong: true }));
        // Stand-ins for the PTY routes the WS-upgrade exemption must reason about.
        s.get('/api/pty/abc', async () => ({ attach: true }));
        s.get('/api/pty/sessions', async () => ({ sessions: [] }));
        s.post('/api/pty/spawn', async () => ({ spawned: true }));
        s.get('/webhooks/foo', async () => ({ received: true }));
        s.get('/', async (_req, reply) => reply.type('text/html').send('<html>dashboard</html>'));
        s.get('/dashboard/app.js', async (_req, reply) => reply.type('application/javascript').send('// app'));
        return s;
    }

    it('lets /health through without auth', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
    });

    it('lets /webhooks/* through without auth', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/webhooks/foo' });
        expect(res.statusCode).toBe(200);
    });

    it('lets the dashboard HTML shell load so its JS can run the token prompt', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/' });
        expect(res.statusCode).toBe(200);
    });

    it('lets dashboard static assets load (the JS itself must fetch its code)', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/dashboard/app.js' });
        expect(res.statusCode).toBe(200);
    });

    it('rejects /api/* with no token', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/api/ping' });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload).error).toBe('unauthorized');
    });

    it('accepts /api/* with a valid bearer header', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: '/api/ping',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
    });

    it('accepts /api/* with a valid `?t=` query param (for EventSource)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: `/api/ping?t=${TOKEN}`,
        });
        expect(res.statusCode).toBe(200);
    });

    it('rejects /api/* with a wrong-length token (no timing leak, no crash)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: '/api/ping',
            headers: { Authorization: `Bearer short` },
        });
        expect(res.statusCode).toBe(401);
    });

    it('rejects /api/* with a same-length wrong token', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: '/api/ping',
            headers: { Authorization: `Bearer ${'e'.repeat(64)}` },
        });
        expect(res.statusCode).toBe(401);
    });

    // ─── PTY WebSocket-upgrade exemption (ticket-authenticated) ──────────────

    it('exempts a GET WebSocket upgrade to the PTY attach route (ticket-auth in-handler)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: '/api/pty/abc',
            headers: { upgrade: 'websocket', connection: 'Upgrade' },
        });
        expect(res.statusCode).toBe(200); // passed the gate; handler does ticket auth
    });

    it('still gates the PTY attach route when it is NOT a WebSocket upgrade', async () => {
        const s = newServer();
        const res = await s.inject({ method: 'GET', url: '/api/pty/abc' });
        expect(res.statusCode).toBe(401);
    });

    it('does NOT exempt POST /api/pty/spawn even with a forged Upgrade header', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'POST',
            url: '/api/pty/spawn',
            headers: { upgrade: 'websocket', connection: 'Upgrade' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('does NOT exempt GET /api/pty/sessions even with a forged Upgrade header', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET',
            url: '/api/pty/sessions',
            headers: { upgrade: 'websocket', connection: 'Upgrade' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('does NOT exempt reserved sub-routes (ticket) on a forged Upgrade', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/api/pty/ticket',
            headers: { upgrade: 'websocket', connection: 'Upgrade' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('does NOT exempt deeper paths than /api/pty/:id (segment-based match)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/api/pty/abc/extra',
            headers: { upgrade: 'websocket', connection: 'Upgrade' },
        });
        expect(res.statusCode).toBe(401);
    });
});

describe('parseHostHeader', () => {
    it('strips a numeric port', () => {
        expect(parseHostHeader('localhost:24847')).toBe('localhost');
        expect(parseHostHeader('127.0.0.1:9000')).toBe('127.0.0.1');
    });

    it('handles bare hostnames without a port', () => {
        expect(parseHostHeader('sokuza.localhost')).toBe('sokuza.localhost');
    });

    it('handles bracketed IPv6 with and without port', () => {
        expect(parseHostHeader('[::1]:24847')).toBe('::1');
        expect(parseHostHeader('[::1]')).toBe('::1');
        expect(parseHostHeader('[2001:db8::1]:8080')).toBe('2001:db8::1');
    });

    it('lowercases the hostname (Host headers are case-insensitive)', () => {
        expect(parseHostHeader('LocalHost:24847')).toBe('localhost');
    });

    it('returns null for missing or malformed input', () => {
        expect(parseHostHeader(undefined)).toBeNull();
        expect(parseHostHeader('')).toBeNull();
        expect(parseHostHeader('   ')).toBeNull();
        // Unclosed bracket is a malformed Host.
        expect(parseHostHeader('[::1')).toBeNull();
    });
});

describe('registerHostGuard', () => {
    function newServer(allowed: readonly string[] = DEFAULT_ALLOWED_HOSTS) {
        const s = Fastify({ logger: false });
        registerHostGuard(s, allowed, logger);
        s.get('/health', async () => ({ ok: true }));
        s.get('/api/ping', async () => ({ pong: true }));
        s.get('/webhooks/foo', async () => ({ received: true }));
        s.get('/', async (_req, reply) => reply.type('text/html').send('<html>dashboard</html>'));
        s.get('/dashboard/app.js', async (_req, reply) => reply.type('application/javascript').send('// app'));
        return s;
    }

    it('lets /health through with any Host header (discovery exemption)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/health',
            headers: { host: 'attacker.example.com:24847' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('lets /webhooks/* through with any Host header (tunnel exemption)', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/webhooks/foo',
            headers: { host: 'sokuza.ngrok.app' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('accepts /api/* with an allowed loopback Host', async () => {
        const s = newServer();
        for (const host of ['localhost:24847', '127.0.0.1', '[::1]:24847', 'sokuza.localhost:24847']) {
            const res = await s.inject({
                method: 'GET', url: '/api/ping',
                headers: { host },
            });
            expect(res.statusCode, `host=${host}`).toBe(200);
        }
    });

    it('rejects /api/* when Host is not in the allow-list', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/api/ping',
            headers: { host: 'attacker.example.com' },
        });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error).toBe('host_not_allowed');
    });

    it('rejects the dashboard HTML when Host is not in the allow-list', async () => {
        // Without this rejection, an attacker DNS-rebinding to 127.0.0.1
        // could load the dashboard HTML in their origin's context, then
        // try to read the bearer token off localStorage from the user's
        // existing tab. The host gate stops it at the door.
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/',
            headers: { host: 'attacker.example.com' },
        });
        expect(res.statusCode).toBe(403);
    });

    it('honors caller-supplied allow-list extensions', async () => {
        const s = newServer([...DEFAULT_ALLOWED_HOSTS, 'my-bind.example.local']);
        const res = await s.inject({
            method: 'GET', url: '/api/ping',
            headers: { host: 'my-bind.example.local:24847' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('compares hosts case-insensitively', async () => {
        const s = newServer();
        const res = await s.inject({
            method: 'GET', url: '/api/ping',
            headers: { host: 'LOCALHOST:24847' },
        });
        expect(res.statusCode).toBe(200);
    });
});
