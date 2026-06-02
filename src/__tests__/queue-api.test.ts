import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';

const TMP_DIR = join(tmpdir(), `sokuza-queue-api-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

/**
 * Smoke test for the issue #3 fix: a `POST /api/queue/jobs/:id/cancel`
 * with `Content-Type: application/json` and an empty body used to fail
 * with HTTP 400 FST_ERR_CTP_EMPTY_JSON_BODY before reaching the handler.
 * Any HTTP client that sets the JSON content-type by default
 * (curl with `-H 'Content-Type: application/json'`, axios, browser
 * extensions, Postman) tripped the wall; only the dashboard worked
 * because it omits the header on action-only POSTs.
 *
 * The fix: register a custom JSON parser in `createServer` that returns
 * `null` for empty bodies instead of throwing. Verified end-to-end here
 * — the handler should get to its own 404 (job-not-found) response,
 * proving the parser let us through.
 */
describe('queue API — empty JSON body on cancel/retry', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
        const configPath = join(TMP_DIR, 'config.yaml');
        await writeFile(configPath, 'server:\n  port: 0\nworkflows: []\n', 'utf-8');

        server = createServer(logger);
        registerApiRoutes(server, {
            logger,
            configStore: new ConfigStore(configPath, logger),
            getTemplateDir: () => join(TMP_DIR, 'templates'),
            getIntegrationStatus: () => ({}),
            getRecentEvents: () => [],
            addEventSubscriber: () => () => {},
            getRegisteredActions: () => [],
            runWorkflow: async () => ({ ok: false, error: 'not implemented' }),
            rerunWorkflow: async () => ({ ok: false, error: 'not implemented' }),
            replayEvent: () => ({ ok: false, error: 'not implemented' }),
            getRunHistory: () => [],
            getConfig: () => ({ server: { port: 0 }, integrations: {}, workflows: [] }),
            previewEvent: () => ({ matched: [], unmatched: [] }),
            getWebhookDeliveries: () => [],
            // Minimal queue stub: every cancel/retry resolves to 404,
            // which is fine — we're testing whether the empty-body parse
            // step lets the request reach the handler at all.
            getQueue: () => ({
                cancel: () => false,
                retry: () => false,
            }) as never,
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('cancel with Content-Type: application/json + empty body reaches the handler (404, not 400)', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/queue/jobs/some-id/cancel',
            headers: { 'content-type': 'application/json' },
            payload: '',
        });
        // 404 = handler ran and reported "not found". The bug surfaced
        // as 400 (FST_ERR_CTP_EMPTY_JSON_BODY) — the parser rejected
        // the empty body before the handler even got to run.
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload).error).toMatch(/not found/i);
    });

    it('retry with Content-Type: application/json + empty body reaches the handler', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/queue/jobs/some-id/retry',
            headers: { 'content-type': 'application/json' },
            payload: '',
        });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload).error).toMatch(/not found|not retryable/i);
    });

    it('cancel with no Content-Type header (current dashboard behavior) still works', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/queue/jobs/some-id/cancel',
            payload: '',
        });
        expect(res.statusCode).toBe(404);
    });

    it('cancel with Content-Type: application/json + valid JSON body still parses correctly', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/queue/jobs/some-id/cancel',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({ reason: 'manual' }),
        });
        // Non-empty body should still parse cleanly via the custom
        // parser (it falls through to JSON.parse on non-empty input);
        // the handler then reports the 404.
        expect(res.statusCode).toBe(404);
    });

    it('a POST route that DOES need a body still rejects malformed JSON (not 2xx)', async () => {
        // Sanity: the parser only relaxes the empty-body case, not
        // arbitrary parse errors. Malformed input must NOT silently
        // pass through as if it were a valid request. Status is 4xx
        // (client error) or 5xx — Fastify version determines the exact
        // code; what matters is the request was rejected.
        const res = await server.inject({
            method: 'POST',
            url: '/api/events/preview',
            headers: { 'content-type': 'application/json' },
            payload: '{not valid json',
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
});
