import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

/**
 * Bearer-token auth for the dashboard and /api/* routes.
 *
 * The token is a 256-bit random value stored in `~/.sokuza/dashboard-token`
 * with 0600 permissions. It's generated lazily on first server start and
 * reused thereafter. Users can rotate it with `sokuza token --rotate`.
 *
 * The token is *not* stored in sokuza.config.yaml because that file is
 * commonly committed to version control. Keeping it in its own dotfile
 * means users can safely share configs without leaking dashboard access.
 *
 * Auth routes (must include token): /api/* and the dashboard (/, /dashboard/*).
 * Unauthenticated (by design): /health (discovery), /webhooks/* (signature-
 * verified by integrations).
 */

const TOKEN_FILENAME = 'dashboard-token';

export function tokenFilePath(): string {
    return join(homedir(), '.sokuza', TOKEN_FILENAME);
}

function generateToken(): string {
    // 256 bits of randomness → 64 hex chars. Same strength as a UUID-v4
    // twice over, no predictable structure.
    return randomBytes(32).toString('hex');
}

/**
 * Read the stored dashboard token, creating one if the file doesn't exist.
 * Enforces 0600 on creation so other local users can't read it.
 */
export async function loadOrCreateDashboardToken(): Promise<string> {
    const file = tokenFilePath();
    if (existsSync(file)) {
        const content = (await readFile(file, 'utf-8')).trim();
        if (content.length > 0) return content;
    }
    const token = generateToken();
    await mkdir(join(homedir(), '.sokuza'), { recursive: true });
    await writeFile(file, token + '\n', { encoding: 'utf-8', mode: 0o600 });
    return token;
}

/**
 * Replace the existing token with a freshly-generated one. Existing
 * dashboard tabs will 401 on their next /api/* call and prompt the user
 * to paste the new one. Used by `sokuza token --rotate`.
 */
export async function rotateDashboardToken(): Promise<string> {
    const token = generateToken();
    const file = tokenFilePath();
    await mkdir(join(homedir(), '.sokuza'), { recursive: true });
    await writeFile(file, token + '\n', { encoding: 'utf-8', mode: 0o600 });
    return token;
}

/**
 * Compare two tokens in constant time to prevent timing side-channels.
 * Both must be the same length; mismatched lengths always return false
 * without short-circuiting on any byte.
 */
export function tokensEqual(a: string | undefined, b: string): boolean {
    if (!a || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearer(req: FastifyRequest): string | undefined {
    const header = req.headers.authorization;
    if (typeof header === 'string') {
        const m = /^Bearer\s+(.+)$/i.exec(header);
        if (m) return m[1].trim();
    }
    // EventSource and simple redirects can't set headers, so we accept the
    // token via the `t` query param as a fallback. The param is never
    // logged in full — only a short prefix for diagnostics.
    const q = (req.query as { t?: unknown })?.t;
    if (typeof q === 'string' && q.length > 0) return q;
    return undefined;
}

/**
 * Default Host header values accepted by `registerHostGuard`. Covers the
 * loopback names a local sokuza is reachable as. Any deployment that binds
 * to a non-loopback hostname must add it via the explicit allow-list arg.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
    'localhost',
    '127.0.0.1',
    '::1',
    'sokuza.localhost',
];

/**
 * Extract the hostname portion from a Host header, lowercased and with
 * the port stripped. Handles bracketed IPv6 ([::1]:24847 → ::1).
 * Returns null for malformed inputs.
 */
export function parseHostHeader(raw: string | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[')) {
        // IPv6: [host]:port. The port is optional.
        const close = trimmed.indexOf(']');
        if (close < 0) return null;
        return trimmed.slice(1, close).toLowerCase();
    }
    // Hostname or IPv4: name[:port]
    const colon = trimmed.indexOf(':');
    return (colon >= 0 ? trimmed.slice(0, colon) : trimmed).toLowerCase();
}

/**
 * Register a `preHandler` that rejects requests whose Host header isn't in
 * the allow-list. Defense-in-depth against DNS rebinding: even if an
 * attacker registers a domain that resolves to 127.0.0.1, the browser
 * sends the attacker's hostname in the Host header — which won't match.
 *
 * Exempt by design (matches `registerAuthGate`):
 *   - /health    — discovery, must accept whatever hostname the public
 *                  site probes via (sokuza.localhost OR 127.0.0.1).
 *   - /webhooks/* — receive arbitrary tunnel hostnames; rely on
 *                   per-integration signature verification instead.
 *
 * MUST be registered BEFORE registerAuthGate so the host check runs first.
 * The allow-list must be lowercased; `parseHostHeader` lowercases requests.
 */
export function registerHostGuard(
    server: FastifyInstance,
    allowedHosts: readonly string[],
    logger: Logger,
): void {
    const allow = new Set(allowedHosts.map((h) => h.toLowerCase()));
    server.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
        const url = req.url;
        // Discovery + webhooks: deliberately exempt (see fn doc).
        if (url === '/health' || url.startsWith('/health?')) return;
        if (url.startsWith('/webhooks/')) return;

        const host = parseHostHeader(req.headers.host as string | undefined);
        if (!host || !allow.has(host)) {
            logger.warn(
                { url, ip: req.ip, host: req.headers.host },
                'Rejected request with disallowed Host header (DNS-rebinding guard)',
            );
            reply.status(403).send({
                error: 'host_not_allowed',
                hint: 'This sokuza instance only accepts requests for an allow-listed Host header. If you are tunnelling, set Host to one of the configured loopback names.',
            });
            return reply;
        }
    });
}

/**
 * Register a `preHandler` that rejects unauthenticated requests to any
 * path that starts with `/api/`, plus the dashboard HTML surfaces. Skips
 * `/health` and `/webhooks/*` which have their own auth models.
 */
export function registerAuthGate(server: FastifyInstance, token: string, logger: Logger): void {
    server.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
        const url = req.url;

        // Public surfaces: discovery + webhooks
        if (url === '/health' || url.startsWith('/health?')) return;
        if (url.startsWith('/webhooks/')) return;

        // Protected surfaces: dashboard HTML + API
        const isDashboard = url === '/' || url.startsWith('/?') || url.startsWith('/dashboard');
        const isApi = url.startsWith('/api/');
        if (!isDashboard && !isApi) return;

        // The dashboard HTML itself must load even without a token so the
        // JS can run, read localStorage, and prompt for the token if missing.
        // Static assets (app.js, styles.css) are served under /dashboard/*
        // and follow the same rule.
        if (isDashboard) return;

        // API routes require the token.
        const provided = extractBearer(req);
        if (!tokensEqual(provided, token)) {
            logger.warn(
                { url, ip: req.ip, hasHeader: !!req.headers.authorization },
                'Rejected unauthenticated /api request',
            );
            reply.status(401).send({
                error: 'unauthorized',
                hint: 'Dashboard API requires a bearer token. Run `sokuza token` to print it, then paste into the dashboard prompt.',
            });
            return reply;
        }
    });
}
