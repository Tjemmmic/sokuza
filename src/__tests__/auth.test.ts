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
});
