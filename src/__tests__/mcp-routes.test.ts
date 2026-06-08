import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { registerMcpRoutes } from '../server/mcp-routes.js';

const logger = pino({ level: 'silent' });

let server: FastifyInstance;
let events: any[];

beforeEach(async () => {
    server = Fastify({ logger: false });
    events = [];
    registerMcpRoutes(server, { logger, broadcastEvent: (e) => events.push(e) });
    await server.ready();
});

describe('MCP routes — status', () => {
    it('rejects an empty message with 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/api/mcp/status', payload: {} });
        expect(res.statusCode).toBe(400);
    });

    it('broadcasts a status event and defaults the level to info', async () => {
        const res = await server.inject({ method: 'POST', url: '/api/mcp/status', payload: { message: 'hello' } });
        expect(res.statusCode).toBe(200);
        const ev = events.find((e) => e.type === 'mcp-status');
        expect(ev).toMatchObject({ type: 'mcp-status', message: 'hello', level: 'info', source: 'mcp' });
    });

    it('passes through warn/error levels', async () => {
        await server.inject({ method: 'POST', url: '/api/mcp/status', payload: { message: 'x', level: 'error', source: 'cc' } });
        expect(events.find((e) => e.type === 'mcp-status')).toMatchObject({ level: 'error', source: 'cc' });
    });
});

describe('MCP routes — ask lifecycle', () => {
    it('rejects an empty prompt with 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/api/mcp/ask', payload: {} });
        expect(res.statusCode).toBe(400);
    });

    it('creates a pending ask (201), lists it, and broadcasts mcp-ask', async () => {
        const create = await server.inject({ method: 'POST', url: '/api/mcp/ask', payload: { prompt: 'go?', source: 'cc' } });
        expect(create.statusCode).toBe(201);
        const { id } = JSON.parse(create.payload);
        expect(id).toBeTruthy();
        expect(events.find((e) => e.type === 'mcp-ask')).toMatchObject({ id, prompt: 'go?', source: 'cc' });

        const list = await server.inject({ method: 'GET', url: '/api/mcp/asks' });
        expect(JSON.parse(list.payload).asks.some((a: any) => a.id === id)).toBe(true);

        const poll = await server.inject({ method: 'GET', url: `/api/mcp/ask/${id}` });
        expect(JSON.parse(poll.payload).status).toBe('pending');
    });

    it('answering resolves the ask and broadcasts mcp-ask-answered', async () => {
        const create = await server.inject({ method: 'POST', url: '/api/mcp/ask', payload: { prompt: 'q' } });
        const { id } = JSON.parse(create.payload);

        const answer = await server.inject({ method: 'POST', url: `/api/mcp/ask/${id}/answer`, payload: { answer: 'yes' } });
        expect(answer.statusCode).toBe(200);
        expect(events.find((e) => e.type === 'mcp-ask-answered')).toMatchObject({ id });

        const poll = await server.inject({ method: 'GET', url: `/api/mcp/ask/${id}` });
        expect(JSON.parse(poll.payload)).toMatchObject({ status: 'answered', answer: 'yes' });

        // No longer pending.
        const list = await server.inject({ method: 'GET', url: '/api/mcp/asks' });
        expect(JSON.parse(list.payload).asks.some((a: any) => a.id === id)).toBe(false);
    });

    it('returns 404 for an unknown ask id (poll + answer)', async () => {
        const poll = await server.inject({ method: 'GET', url: '/api/mcp/ask/nope' });
        expect(poll.statusCode).toBe(404);
        const answer = await server.inject({ method: 'POST', url: '/api/mcp/ask/nope/answer', payload: { answer: 'x' } });
        expect(answer.statusCode).toBe(404);
    });
});
