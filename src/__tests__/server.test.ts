import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/server.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Server', () => {
    const server = createServer(logger);

    afterAll(async () => {
        await server.close();
    });

    it('should respond to /health with the discovery contract shape', async () => {
        const response = await server.inject({ method: 'GET', url: '/health' });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.app).toBe('sokuza');
        expect(body.ok).toBe(true);
        expect(typeof body.version).toBe('string');
    });

    it('should echo sokuza.ai as Allow-Origin on /health requests from sokuza.ai', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/health',
            headers: { origin: 'https://sokuza.ai' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe('https://sokuza.ai');
        expect(response.headers['vary']).toMatch(/Origin/i);
    });

    it('should not grant CORS to unknown origins', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/health',
            headers: { origin: 'https://evil.example' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should respond to /health preflight with 204 and CORS headers', async () => {
        const response = await server.inject({
            method: 'OPTIONS',
            url: '/health',
            headers: {
                origin: 'https://sokuza.ai',
                'access-control-request-method': 'GET',
            },
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('https://sokuza.ai');
        expect(response.headers['access-control-allow-methods']).toMatch(/GET/);
    });
});
