import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
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

    it('emits Cache-Control: no-store on /health so browsers do not serve stale ports', async () => {
        const response = await server.inject({ method: 'GET', url: '/health' });
        expect(response.headers['cache-control']).toBe('no-store');
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

describe('SOKUZA_ALLOW_DEV_ORIGINS env variations', () => {
    const ALLOWED_DEV = 'http://localhost:4321';
    const originalValue = process.env.SOKUZA_ALLOW_DEV_ORIGINS;

    beforeEach(() => {
        delete process.env.SOKUZA_ALLOW_DEV_ORIGINS;
    });

    afterEach(() => {
        if (originalValue === undefined) delete process.env.SOKUZA_ALLOW_DEV_ORIGINS;
        else process.env.SOKUZA_ALLOW_DEV_ORIGINS = originalValue;
    });

    async function probeDevOrigin(): Promise<string | undefined> {
        const s = createServer(logger);
        try {
            const res = await s.inject({
                method: 'GET',
                url: '/health',
                headers: { origin: ALLOWED_DEV },
            });
            return res.headers['access-control-allow-origin'] as string | undefined;
        } finally {
            await s.close();
        }
    }

    it('accepts "1" as truthy', async () => {
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = '1';
        expect(await probeDevOrigin()).toBe(ALLOWED_DEV);
    });

    it('accepts "true" as truthy (case insensitive)', async () => {
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = 'TRUE';
        expect(await probeDevOrigin()).toBe(ALLOWED_DEV);
    });

    it('accepts "yes" and "on"', async () => {
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = 'yes';
        expect(await probeDevOrigin()).toBe(ALLOWED_DEV);
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = 'on';
        expect(await probeDevOrigin()).toBe(ALLOWED_DEV);
    });

    it('rejects other values (no accidental enablement)', async () => {
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = '0';
        expect(await probeDevOrigin()).toBeUndefined();
        process.env.SOKUZA_ALLOW_DEV_ORIGINS = 'nope';
        expect(await probeDevOrigin()).toBeUndefined();
    });
});
