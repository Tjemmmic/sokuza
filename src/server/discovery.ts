import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * Directory where each running sokuza process writes its per-PID state file.
 * Per-instance files (rather than a single `state.json`) mean two concurrent
 * sokuzas don't race to overwrite the same file, and a crashed process leaves
 * behind evidence of what port it was on until the next startup prunes it.
 */
export function runtimeStateDir(): string {
    return join(homedir(), '.sokuza', 'instances');
}

function runtimeStateFileFor(pid: number): string {
    return join(runtimeStateDir(), `${pid}.json`);
}

/**
 * Write `~/.sokuza/instances/<pid>.json` with this process's runtime state.
 * Returns the written path so the caller (engine.stop) can delete it on
 * graceful shutdown. State files are diagnostic — the `/open` detector
 * probes ports directly rather than trusting this file — so best-effort
 * write failure is non-fatal.
 */
export async function persistRuntimeState(
    port: number,
    host: string,
): Promise<string> {
    const dir = runtimeStateDir();
    const file = runtimeStateFileFor(process.pid);
    await mkdir(dir, { recursive: true });
    const state: RuntimeState = {
        app: SOKUZA_APP_ID,
        version: VERSION,
        port,
        host,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    };
    await writeFile(file, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
    });
    return file;
}

/** Delete a previously-persisted state file. Safe to call multiple times. */
export async function clearRuntimeState(stateFile: string): Promise<void> {
    await rm(stateFile, { force: true });
}

/**
 * Check whether a pid belongs to a currently-running process.
 * `process.kill(pid, 0)` sends no signal but throws ESRCH if the process
 * doesn't exist. EPERM means the process exists but belongs to a different
 * user — for our purposes that still counts as "alive."
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Sweep the state directory for files belonging to processes that no longer
 * exist. Called at startup so a crashed previous run leaves a clean slate.
 * Silent on errors: this is housekeeping, never load-bearing.
 */
export async function pruneStaleRuntimeStates(logger?: Logger): Promise<number> {
    const dir = runtimeStateDir();
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return 0;
    }

    let pruned = 0;
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const pidPart = name.slice(0, -'.json'.length);
        const pid = Number.parseInt(pidPart, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        if (pid === process.pid) continue;

        const file = join(dir, name);
        if (!isProcessAlive(pid)) {
            try {
                await rm(file, { force: true });
                pruned++;
            } catch (err) {
                logger?.debug({ err, file }, 'Could not prune stale runtime state');
            }
        }
    }
    return pruned;
}

/**
 * Load every live runtime state. Returns only states whose pid is still
 * running — callers get a trustworthy snapshot without having to re-probe.
 * Used by future tooling like `sokuza status`.
 */
export async function listRuntimeStates(): Promise<RuntimeState[]> {
    const dir = runtimeStateDir();
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }

    const results: RuntimeState[] = [];
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        try {
            const raw = await readFile(join(dir, name), 'utf-8');
            const parsed = JSON.parse(raw) as RuntimeState;
            if (parsed.app === SOKUZA_APP_ID && isProcessAlive(parsed.pid)) {
                results.push(parsed);
            }
        } catch {
            // Malformed or unreadable — skip.
        }
    }
    return results;
}
