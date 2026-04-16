import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';
import { matchesTrigger } from '../core/workflow.js';
import type { FastifyInstance } from 'fastify';
import type { EventPayload, SokuzaConfig } from '../core/types.js';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = join(tmpdir(), `sokuza-preview-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

const mockConfig: SokuzaConfig = {
    server: { port: 0 },
    integrations: {},
    workflows: [
        {
            name: 'pr-review',
            trigger: { source: 'github', event: 'pull_request.opened' },
            steps: [{ action: 'log', params: { message: 'review' } }],
        },
        {
            name: 'issue-triage',
            trigger: { source: 'github', event: 'issues.opened' },
            steps: [{ action: 'log', params: { message: 'triage' } }],
        },
        {
            name: 'disabled-wf',
            enabled: false,
            trigger: { source: 'github', event: 'push' },
            steps: [{ action: 'log', params: { message: 'never' } }],
        },
        {
            name: 'filtered-pr',
            trigger: {
                source: 'github',
                event: 'pull_request.opened',
                filters: { 'metadata.repo': 'org/important' },
            },
            steps: [{ action: 'log', params: { message: 'filtered' } }],
        },
    ],
};

function previewEvent(event: EventPayload) {
    const matched: string[] = [];
    const unmatched: Array<{ name: string; reason: string }> = [];

    for (const wf of mockConfig.workflows) {
        if (matchesTrigger(wf, event)) {
            matched.push(wf.name);
        } else {
            if (wf.enabled === false) {
                unmatched.push({ name: wf.name, reason: 'workflow is disabled' });
            } else {
                unmatched.push({ name: wf.name, reason: 'trigger conditions not met' });
            }
        }
    }

    return { matched, unmatched };
}

describe('POST /api/events/preview', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
        const configPath = join(TMP_DIR, 'config.yaml');
        await writeFile(configPath, 'server:\n  port: 0\nworkflows: []\n', 'utf-8');
        const configStore = new ConfigStore(configPath, logger);

        server = createServer(logger);
        registerApiRoutes(server, {
            logger,
            configStore,
            getTemplateDir: () => join(TMP_DIR, 'templates'),
            getIntegrationStatus: () => ({}),
            getRecentEvents: () => [],
            addEventSubscriber: () => () => {},
            getRegisteredActions: () => [],
            runWorkflow: async () => ({ ok: false, error: 'not implemented' }),
            rerunWorkflow: async () => ({ ok: false, error: 'not implemented' }),
            getRunHistory: () => [],
            getConfig: () => mockConfig,
            previewEvent,
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('returns matched and unmatched workflows for a given event', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/events/preview',
            payload: {
                event: {
                    source: 'github',
                    event: 'pull_request.opened',
                    timestamp: new Date().toISOString(),
                    payload: {},
                    metadata: {},
                },
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.matched).toContain('pr-review');
        expect(body.unmatched).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'issue-triage' }),
                expect.objectContaining({ name: 'disabled-wf', reason: expect.stringContaining('disabled') }),
                expect.objectContaining({ name: 'filtered-pr' }),
            ]),
        );
    });

    it('matches filtered workflow when metadata matches', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/events/preview',
            payload: {
                event: {
                    source: 'github',
                    event: 'pull_request.opened',
                    timestamp: new Date().toISOString(),
                    payload: {},
                    metadata: { repo: 'org/important' },
                },
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.matched).toContain('pr-review');
        expect(body.matched).toContain('filtered-pr');
    });

    it('rejects request without event.source or event.event', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/events/preview',
            payload: { event: { source: 'github' } },
        });

        expect(res.statusCode).toBe(400);
    });

    it('returns empty matches for an event with no matching workflows', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/api/events/preview',
            payload: {
                event: {
                    source: 'slack',
                    event: 'message',
                    timestamp: new Date().toISOString(),
                    payload: {},
                    metadata: {},
                },
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.matched).toEqual([]);
        expect(body.unmatched.length).toBe(4);
    });
});
