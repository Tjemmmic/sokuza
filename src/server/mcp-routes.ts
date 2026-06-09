/**
 * MCP bridge HTTP routes.
 *
 * Endpoints the `sokuza mcp` stdio server calls to reach this running engine:
 * push a status line to the dashboard, and ask a human a question (parked in
 * an in-memory store, answered from the dashboard, long-polled by the MCP
 * tool). State is process-local and ephemeral.
 *
 * Extracted from api.ts so the contract (validation + broadcast shapes) is
 * directly testable without constructing the full ApiDeps surface.
 *
 * Auth: these are normal `/api/` routes, so the bearer-token gate applies. The
 * `sokuza mcp` stdio bridge authenticates by reading the dashboard token from
 * `~/.sokuza/dashboard-token` (0600, same-user) and sending it as
 * `Authorization: Bearer …` — see HttpEngineBridge in core/mcp-server.ts. So
 * the human-in-the-loop trust boundary is "can read the local token file",
 * i.e. the same user that owns the dashboard. They are NOT unauthenticated.
 *
 *   POST /api/mcp/status         — broadcast a status line
 *   POST /api/mcp/ask            — create a pending question → { id }
 *   GET  /api/mcp/asks           — list pending questions
 *   GET  /api/mcp/ask/:id        — poll a question's status/answer
 *   POST /api/mcp/ask/:id/answer — resolve a question
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { McpAskStore } from '../core/mcp-ask-store.js';

export interface McpRoutesDeps {
    logger: Logger;
    broadcastEvent: (payload: unknown) => void;
    /** Injectable for tests; defaults to a fresh in-memory store. */
    askStore?: McpAskStore;
}

export function registerMcpRoutes(server: FastifyInstance, deps: McpRoutesDeps): void {
    const { logger, broadcastEvent } = deps;
    const mcpAsks = deps.askStore ?? new McpAskStore();

    server.post('/api/mcp/status', async (request, reply) => {
        const body = (request.body ?? {}) as { message?: unknown; level?: unknown; source?: unknown };
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) return reply.status(400).send({ error: 'message is required' });
        const level = body.level === 'warn' || body.level === 'error' ? body.level : 'info';
        const source = typeof body.source === 'string' ? body.source : 'mcp';
        broadcastEvent({ type: 'mcp-status', source, level, message, timestamp: new Date().toISOString() });
        logger.info({ source, level, message }, 'MCP status report');
        return { ok: true };
    });

    server.post('/api/mcp/ask', async (request, reply) => {
        const body = (request.body ?? {}) as { prompt?: unknown; source?: unknown };
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) return reply.status(400).send({ error: 'prompt is required' });
        const source = typeof body.source === 'string' ? body.source : undefined;
        const ask = mcpAsks.create(prompt, source);
        broadcastEvent({ type: 'mcp-ask', id: ask.id, prompt: ask.prompt, source, timestamp: ask.createdAt });
        return reply.status(201).send({ id: ask.id });
    });

    server.get('/api/mcp/asks', async () => {
        return { asks: mcpAsks.listPending() };
    });

    server.get('/api/mcp/ask/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const ask = mcpAsks.get(id);
        if (!ask) return reply.status(404).send({ error: 'unknown ask' });
        return { status: ask.status, prompt: ask.prompt, answer: ask.answer };
    });

    server.post('/api/mcp/ask/:id/answer', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { answer?: unknown };
        const answer = typeof body.answer === 'string' ? body.answer : '';
        const ask = mcpAsks.answer(id, answer);
        if (!ask) return reply.status(404).send({ error: 'unknown ask' });
        broadcastEvent({ type: 'mcp-ask-answered', id, timestamp: new Date().toISOString() });
        return { ok: true, ask };
    });
}
