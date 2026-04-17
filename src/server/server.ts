import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDiscoveryCors, buildHealthResponse } from './discovery.js';

/** Dashboard directory — at project root (works from both src/ and dist/). */
function getDashboardDir(): string {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        join(dirname(here), '..', '..', 'dashboard'),
        join(dirname(here), '..', 'dashboard'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return candidates[0];
}

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

/**
 * Create a pre-configured Fastify server instance.
 */
export function createServer(logger: Logger): FastifyInstance {
    const server = Fastify({
        logger: false, // We use our own pino instance
    });

    // ─── Discovery: /health ────────────────────────────────────────────────
    // Public surface probed by https://sokuza.ai to detect a locally running
    // instance. Response shape is stable — it is the contract the public site
    // validates against. Strict CORS: only sokuza.ai (and dev origins when
    // explicitly enabled) may read this cross-origin.
    server.get('/health', async (request, reply) => {
        applyDiscoveryCors(request, reply);
        return buildHealthResponse();
    });

    // CORS preflight for /health. Browsers send this before any cross-origin
    // GET that sets non-simple headers or is inspected as JSON from JS.
    server.options('/health', async (request, reply) => {
        applyDiscoveryCors(request, reply);
        reply.status(204).send();
    });

    // ─── Dashboard static file serving ──────────────────────────────────────
    const dashboardDir = getDashboardDir();

    server.get('/', async (_request, reply) => {
        return serveFile(reply, join(dashboardDir, 'index.html'), dashboardDir);
    });

    server.get('/dashboard/*', async (request, reply) => {
        const file = (request.params as Record<string, string>)['*'];
        const safePath = file.replace(/[^a-zA-Z0-9._/-]/g, '').replace(/\.\./g, '');
        return serveFile(reply, join(dashboardDir, safePath), dashboardDir);
    });

    // ─── Global error handler ──────────────────────────────────────────────
    server.setErrorHandler((error, _request, reply) => {
        logger.error({ err: error }, 'Unhandled request error');
        reply.status(500).send({ error: 'Internal server error' });
    });

    return server;
}

async function serveFile(reply: any, filePath: string, allowedDir?: string): Promise<void> {
    if (allowedDir) {
        const resolved = resolve(filePath);
        const allowed = resolve(allowedDir);
        if (resolved !== allowed && !resolved.startsWith(allowed + '/')) {
            reply.status(403).send({ error: 'Forbidden' });
            return;
        }
    }
    try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        reply.header('Content-Type', contentType).send(content);
    } catch {
        reply.status(404).send({ error: 'Not found' });
    }
}
