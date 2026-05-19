import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';
import type { SokuzaConfig } from '../core/types.js';

const TMP_DIR = join(tmpdir(), `sokuza-workflow-crud-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

// The dashboard's flow when a user installs a library workflow is:
//   POST /api/workflows          → writes the new entry to YAML on disk
//   GET  /api/workflows/:name/details  → reads from the engine's in-memory config
//
// Without `reloadConfig()` after the POST, the in-memory config never sees
// the new workflow and the GET 404s — making installed/duplicated
// workflows un-editable. These tests pin that contract.

describe('/api/workflows CRUD reloads in-memory config', () => {
    let server: FastifyInstance;
    let configPath: string;
    let cachedConfig: SokuzaConfig;
    let configStore: ConfigStore;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
    });

    afterAll(async () => {
        await server?.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    beforeEach(async () => {
        configPath = join(TMP_DIR, `config-${Math.random().toString(36).slice(2, 8)}.yaml`);
        await writeFile(configPath, 'server:\n  port: 0\nworkflows: []\n', 'utf-8');
        configStore = new ConfigStore(configPath, logger);

        // Mirror the engine: getConfig returns a cached snapshot;
        // reloadConfig refreshes it from disk. The two diverge until
        // someone calls reloadConfig.
        cachedConfig = { server: { port: 0 }, integrations: {}, workflows: [] };

        if (server) await server.close();
        server = createServer(logger);
        registerApiRoutes(server, {
            logger,
            configStore,
            getTemplateDir: () => join(TMP_DIR, 'templates'),
            getIntegrationStatus: () => ({}),
            getRecentEvents: () => [],
            addEventSubscriber: () => () => undefined,
            getRegisteredActions: () => [],
            runWorkflow: async () => ({ ok: false, error: 'unused' }),
            rerunWorkflow: async () => ({ ok: false, error: 'unused' }),
            replayEvent: () => ({ ok: false, error: 'unused' }),
            getRunHistory: () => [],
            getConfig: () => cachedConfig,
            previewEvent: () => ({ matched: [], unmatched: [] }),
            getWebhookDeliveries: () => [],
            reloadConfig: async () => {
                const raw = await configStore.readRaw();
                const parsed = yaml.load(raw) as Record<string, unknown>;
                cachedConfig = {
                    server: { port: 0 },
                    integrations: {},
                    workflows: ((parsed.workflows as Array<Record<string, unknown>>) ?? []).map((w) => ({
                        name: w.name as string,
                        trigger: w.trigger as { source: string; event: string },
                        steps: w.steps as never,
                        graph: w.graph as never,
                        template: w.template as string | undefined,
                    })),
                };
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    it('POST → GET /:name/details: a freshly-created workflow is immediately editable (regression: in-memory config used to lag the YAML)', async () => {
        const create = await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'my-new-flow', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });
        expect(create.statusCode).toBe(200);

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/my-new-flow/details',
        });
        expect(detail.statusCode).toBe(200);
        const body = JSON.parse(detail.payload);
        expect(body.workflow?.name).toBe('my-new-flow');
    });

    it('PUT → GET /:name/details: edits land in the in-memory config without a manual reload', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'edit-me', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [{ id: 'n1' }], edges: [] } },
        });

        await server.inject({
            method: 'PUT',
            url: '/api/workflows/edit-me',
            payload: { name: 'edit-me', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] } },
        });

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/edit-me/details',
        });
        expect(detail.statusCode).toBe(200);
        const body = JSON.parse(detail.payload);
        expect(body.workflow?.graph?.nodes?.length).toBe(2);
    });

    it('DELETE → GET /:name/details: a deleted workflow is no longer in the in-memory config', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'to-delete', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });

        const del = await server.inject({
            method: 'DELETE',
            url: '/api/workflows/to-delete',
        });
        expect(del.statusCode).toBe(200);

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/to-delete/details',
        });
        expect(detail.statusCode).toBe(404);
    });
});
