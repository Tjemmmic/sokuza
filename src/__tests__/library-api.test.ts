import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';

const TMP_DIR = join(tmpdir(), `sokuza-library-api-test-${Date.now()}`);
const TEMPLATE_DIR = join(TMP_DIR, 'templates');
const LIBRARY_DIR = join(TEMPLATE_DIR, 'library');
const logger = pino({ level: 'silent' });

// Exercises the library-template endpoints the dashboard depends on:
//   - GET /api/templates/library            → list with parsed graph
//   - GET /api/templates/library/:name/graph → single template, full graph

describe('/api/templates/library/* routes', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
        await mkdir(LIBRARY_DIR, { recursive: true });
        // A minimal graph-form template
        await writeFile(
            join(LIBRARY_DIR, 'demo-graph.yaml'),
            `description: Demo graph
icon: 🧪
trigger:
  source: manual
  event: manual
graph:
  nodes:
    - id: trigger
      type: trigger.manual
      config: { inputs: [] }
    - id: log
      type: utility.log
      config: { message: hello }
  edges:
    - from: { node: trigger, port: event }
      to: { node: log, port: __seq }
`,
            'utf-8',
        );
        // A legacy steps-form template that should NOT appear as a recipe
        // candidate (no graph block) but should still load via the
        // single-template endpoint.
        await writeFile(
            join(LIBRARY_DIR, 'demo-steps.yaml'),
            `trigger: { source: github, event: push }
steps:
  - action: log
    params: { message: legacy }
`,
            'utf-8',
        );
        // A malformed YAML to exercise error paths.
        await writeFile(
            join(LIBRARY_DIR, 'broken.yaml'),
            `trigger: { source: github
  this: is not valid yaml at all`,
            'utf-8',
        );

        const configPath = join(TMP_DIR, 'config.yaml');
        await writeFile(configPath, 'server:\n  port: 0\nworkflows: []\n', 'utf-8');

        server = createServer(logger);
        registerApiRoutes(server, {
            logger,
            configStore: new ConfigStore(configPath, logger),
            getTemplateDir: () => TEMPLATE_DIR,
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
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('GET /api/templates/library lists every template with its parsed graph + metadata', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/templates/library' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.templates)).toBe(true);

        const byName = new Map<string, any>(body.templates.map((t: any) => [t.name, t]));
        const demo = byName.get('demo-graph');
        expect(demo).toBeDefined();
        expect(demo.icon).toBe('🧪');
        expect(demo.description).toBe('Demo graph');
        expect(demo.graph?.nodes?.length).toBe(2);

        const legacy = byName.get('demo-steps');
        expect(legacy).toBeDefined();
        expect(legacy.steps?.length).toBe(1);
        expect(legacy.graph).toBeUndefined();
    });

    it('GET /api/templates/library/:name/graph returns the parsed graph for a graph template', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/templates/library/demo-graph/graph',
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.name).toBe('demo-graph');
        expect(body.icon).toBe('🧪');
        expect(body.graph?.nodes?.[1]?.type).toBe('utility.log');
    });

    it('GET /api/templates/library/:name/graph returns the steps for a legacy template', async () => {
        // The endpoint returns whatever the YAML provides — graph if
        // present, steps otherwise. The dashboard's openLibraryItemInEditor
        // path falls back to staging steps when graph is missing.
        const res = await server.inject({
            method: 'GET',
            url: '/api/templates/library/demo-steps/graph',
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.name).toBe('demo-steps');
        expect(body.graph).toBeUndefined();
        expect(body.steps?.length).toBe(1);
    });

    it('GET /api/templates/library/:name/graph returns 404 for a missing template', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/templates/library/no-such-template/graph',
        });
        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.payload);
        expect(body.error).toMatch(/not found/i);
    });

    it('GET /api/templates/library/:name/graph returns 400 for malformed YAML', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/templates/library/broken/graph',
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.error).toMatch(/Invalid YAML/);
    });

    it('GET /api/templates/library/:name/graph sanitizes the name to prevent path escape', async () => {
        // The handler runs the raw `:name` through sanitizeFileName before
        // joining it to the library dir, so traversal attempts can't reach
        // outside the templates folder. Here we just confirm the request
        // doesn't 500 and doesn't return the contents of /etc/passwd.
        const res = await server.inject({
            method: 'GET',
            url: '/api/templates/library/..%2F..%2Fetc%2Fpasswd/graph',
        });
        expect([404, 400]).toContain(res.statusCode);
    });
});
