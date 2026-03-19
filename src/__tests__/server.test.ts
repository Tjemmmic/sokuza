import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/server.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Server', () => {
    const server = createServer(logger);

    afterAll(async () => {
        await server.close();
    });

    it('should respond to health check', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/health',
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.status).toBe('ok');
        expect(body.timestamp).toBeDefined();
    });
});
