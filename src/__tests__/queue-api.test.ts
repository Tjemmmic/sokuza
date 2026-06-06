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

describe('queue API — run context + job detail', () => {
    let server: FastifyInstance;

    // A completed PR-review job carrying the GitHub context the dashboard
    // needs: repo/owner in metadata, branch in the PR payload.
    const fakeJob = {
        id: 'job-42',
        status: 'completed',
        priority: 'normal',
        dedupKey: 'dk',
        enqueuedAt: '2026-06-05T10:00:00.000Z',
        startedAt: '2026-06-05T10:00:01.000Z',
        completedAt: '2026-06-05T10:00:05.000Z',
        attempts: 1,
        workflow: {
            name: 'pr-review',
            trigger: { source: 'github', event: 'pull_request.opened' },
            steps: [{ action: 'ai-review' }],
        },
        event: {
            source: 'github',
            event: 'pull_request.opened',
            action: 'opened',
            metadata: { repo: 'acme/widgets', owner: 'acme', repoName: 'widgets', prNumber: 42 },
            payload: { pull_request: { number: 42, head: { ref: 'feature/login' } } },
        },
        output: { results: {}, steps: {} },
    };

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
            getQueue: () => ({
                getStats: () => ({ queued: 0, running: 0, completed: 1, failed: 0 }),
                getJobs: () => [fakeJob],
                getJob: (id: string) => (id === fakeJob.id ? fakeJob : undefined),
            }) as never,
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('GET /api/queue surfaces repo/owner/PR/branch context on each job', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/queue' });
        expect(res.statusCode).toBe(200);
        const ev = JSON.parse(res.payload).jobs[0].event;
        expect(ev.repo).toBe('acme/widgets');
        expect(ev.owner).toBe('acme');
        expect(ev.prNumber).toBe(42);
        expect(ev.branch).toBe('feature/login');
    });

    it('GET /api/queue/jobs/:id returns full detail (workflow + metadata + output)', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/queue/jobs/job-42' });
        expect(res.statusCode).toBe(200);
        const job = JSON.parse(res.payload).job;
        expect(job.workflowName).toBe('pr-review');
        expect(job.event.branch).toBe('feature/login');
        expect(job.workflow.name).toBe('pr-review');
        expect(job.eventMetadata.repo).toBe('acme/widgets');
        expect(job.output).toEqual({ results: {}, steps: {} });
    });

    it('GET /api/queue/jobs/:id returns 404 for an unknown id', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/queue/jobs/nope' });
        expect(res.statusCode).toBe(404);
    });
});

describe('queue API — job detail redacts secrets', () => {
    let server: FastifyInstance;

    const secretJob = {
        id: 'job-secret',
        status: 'completed',
        priority: 'normal',
        dedupKey: 'dk',
        enqueuedAt: '2026-06-05T10:00:00.000Z',
        attempts: 1,
        workflow: { name: 'wf', trigger: { source: 'manual', event: 'manual' }, steps: [] },
        event: {
            source: 'webhook',
            event: 'incoming',
            metadata: { repo: 'acme/widgets', authorization: 'Bearer sk-live-zzz' },
            payload: {},
        },
        output: {
            results: {},
            steps: { fetch: { api_key: 'super-secret', note: 'visible' } },
        },
    };

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
            getQueue: () => ({
                getStats: () => ({ queued: 0, running: 0, completed: 1, failed: 0 }),
                getJobs: () => [secretJob],
                getJob: (id: string) => (id === secretJob.id ? secretJob : undefined),
            }) as never,
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('masks secret-bearing keys in output and metadata, preserves benign fields', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/queue/jobs/job-secret' });
        expect(res.statusCode).toBe(200);
        const job = JSON.parse(res.payload).job;
        expect(job.eventMetadata.authorization).toBe('[redacted]');
        expect(job.eventMetadata.repo).toBe('acme/widgets');
        expect(job.output.steps.fetch.api_key).toBe('[redacted]');
        expect(job.output.steps.fetch.note).toBe('visible');
    });
});
