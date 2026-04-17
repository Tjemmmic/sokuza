import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { VERSION } from '../version.js';

export const SOKUZA_APP_ID = 'sokuza';
// Port 24847 is deliberately obscure: below Linux's ephemeral range (32768+)
// and the k8s NodePort range (30000+), clear of every common dev tool,
// database, and local AI service we could find. Conflicts are rare enough
// that the 5-port fallback window almost always suffices.
export const DEFAULT_PREFERRED_PORT = 24847;
export const FALLBACK_PORTS = [24848, 24849, 24850, 24851, 24852];

const PRODUCTION_ORIGINS: ReadonlySet<string> = new Set([
    'https://sokuza.ai',
    'https://www.sokuza.ai',
]);

// Astro defaults to 4321 but walks up when it's busy. Allow the small range
// Astro actually uses so local dev doesn't need a CORS dance each session.
const DEV_ORIGINS: ReadonlySet<string> = new Set([
    'http://localhost:4321', 'http://127.0.0.1:4321',
    'http://localhost:4322', 'http://127.0.0.1:4322',
    'http://localhost:4323', 'http://127.0.0.1:4323',
]);

export function isAllowedDiscoveryOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    if (PRODUCTION_ORIGINS.has(origin)) return true;
    return process.env.SOKUZA_ALLOW_DEV_ORIGINS === '1' && DEV_ORIGINS.has(origin);
}

/**
 * Strict per-request CORS for discovery endpoints. Echoes a single allowed
 * origin (never `*`), never sets Allow-Credentials, and restricts methods to
 * GET/OPTIONS. Safe to call on both actual requests and preflight.
 */
export function applyDiscoveryCors(
    request: FastifyRequest,
    reply: FastifyReply,
): void {
    const origin = request.headers.origin as string | undefined;
    reply.header('Vary', 'Origin');
    if (isAllowedDiscoveryOrigin(origin)) {
        reply.header('Access-Control-Allow-Origin', origin!);
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
        reply.header('Access-Control-Max-Age', '600');

        // Chrome's Private Network Access: a public-origin page (sokuza.ai)
        // probing a private address (127.0.0.1) will eventually require this
        // opt-in on the preflight. Granting it only to allowed origins keeps
        // the local service invisible to arbitrary sites.
        if (request.headers['access-control-request-private-network'] === 'true') {
            reply.header('Access-Control-Allow-Private-Network', 'true');
        }
    }
}

export interface HealthResponse {
    app: typeof SOKUZA_APP_ID;
    ok: true;
    version: string;
}

export function buildHealthResponse(): HealthResponse {
    return { app: SOKUZA_APP_ID, ok: true, version: VERSION };
}

/**
 * Listen on the preferred port, falling back through FALLBACK_PORTS when
 * the preferred is in use. Returns the port actually bound.
 *
 * Only `EADDRINUSE` triggers fallback — permission/address errors still
 * throw so misconfiguration is loud.
 */
export async function listenWithFallback(
    server: FastifyInstance,
    host: string,
    preferredPort: number,
    logger: Logger,
): Promise<number> {
    const seen = new Set<number>();
    const order: number[] = [];
    for (const p of [preferredPort, ...FALLBACK_PORTS]) {
        if (!seen.has(p)) { order.push(p); seen.add(p); }
    }

    let lastInUse: Error | null = null;
    for (const port of order) {
        try {
            await server.listen({ port, host });
            if (port !== preferredPort) {
                logger.warn(
                    { preferredPort, actualPort: port },
                    'Preferred port busy — fell back to next available Sokuza port',
                );
            }
            return port;
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'EADDRINUSE') {
                lastInUse = e;
                continue;
            }
            throw err;
        }
    }

    throw new Error(
        `All Sokuza discovery ports are in use (${order.join(', ')}). ` +
        `Free one of these ports, then restart. Last error: ${lastInUse?.message ?? 'unknown'}`,
    );
}

export interface RuntimeState {
    app: typeof SOKUZA_APP_ID;
    version: string;
    port: number;
    host: string;
    pid: number;
    startedAt: string;
}

/**
 * Persist the active port to ~/.sokuza/state.json so operators and future
 * tooling (e.g. `sokuza open`) can locate the running instance without
 * parsing logs.
 */
export async function persistRuntimeState(
    port: number,
    host: string,
): Promise<string> {
    const dir = join(homedir(), '.sokuza');
    const file = join(dir, 'state.json');
    await mkdir(dir, { recursive: true });
    const state: RuntimeState = {
        app: SOKUZA_APP_ID,
        version: VERSION,
        port,
        host,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    };
    await writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    return file;
}
