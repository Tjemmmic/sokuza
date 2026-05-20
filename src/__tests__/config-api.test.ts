import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';

const TMP_DIR = join(tmpdir(), `sokuza-config-api-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

// The dashboard's Settings page used to round-trip the config through a
// hand-rolled YAML serializer that flattened nested object values inside
// array items to one indent level. The result was a YAML file that
// `yaml.load` accepted silently (with silent key collisions) until a
// duplicate-key clash made the whole file unparseable. The contract here
// pins that GET /api/config returns the raw bytes so the dashboard can
// display them without round-tripping.

describe('/api/config preserves raw YAML', () => {
    let server: FastifyInstance;
    let configPath: string;
    let configStore: ConfigStore;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
    });

    afterAll(async () => {
        await server?.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    beforeEach(async () => {
        const slug = Math.random().toString(36).slice(2, 8);
        configPath = join(TMP_DIR, `config-${slug}.yaml`);
        configStore = new ConfigStore(configPath, logger);

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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            getConfig: () => ({} as any),
            previewEvent: () => ({ matched: [], unmatched: [] }),
            getWebhookDeliveries: () => [],
            reloadConfig: async () => undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    it('GET /api/config exposes a raw YAML string identical to the on-disk file', async () => {
        const rawIn = [
            'server:',
            '  port: 24847',
            'workflows:',
            '  - name: nested-thing',
            '    trigger:',
            '      source: manual',
            '      event: []',
            '    inputs:',
            '      - name: pr',
            '        label: Pull Request',
            '        type: github-pr',
            '        required: true',
            '',
        ].join('\n');
        await writeFile(configPath, rawIn, 'utf-8');

        const res = await server.inject({ method: 'GET', url: '/api/config' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.raw).toBe(rawIn);
        // parsed view still works for callers that want structured access.
        expect(body.config?.workflows?.[0]?.trigger?.source).toBe('manual');
        expect(body.config?.workflows?.[0]?.inputs?.[0]?.label).toBe('Pull Request');
    });

    it('PUT __raw_yaml → GET round-trip preserves nested indentation byte-for-byte', async () => {
        await writeFile(configPath, 'server:\n  port: 0\n', 'utf-8');

        const yamlIn = [
            'server:',
            '  port: 24847',
            'workflows:',
            '  - name: my-flow',
            '    trigger:',
            '      source: manual',
            '    graph:',
            '      nodes:',
            '        - id: a',
            '          type: ai.agent',
            '          config:',
            '            prompt: hello',
            '        - id: b',
            '          type: github.comment',
            '',
        ].join('\n');

        const put = await server.inject({
            method: 'PUT',
            url: '/api/config',
            payload: { __raw_yaml: yamlIn },
        });
        expect(put.statusCode).toBe(200);

        // The file on disk must exactly equal what we sent — no
        // re-dumping, no normalising. Otherwise the editor will diverge
        // from disk and any "save without changes" round-trip will
        // silently rewrite the user's file.
        const onDisk = await readFile(configPath, 'utf-8');
        expect(onDisk).toBe(yamlIn);

        const got = await server.inject({ method: 'GET', url: '/api/config' });
        expect(JSON.parse(got.payload).raw).toBe(yamlIn);
    });

    it('rejects invalid YAML with a 400 — silent indent corruption never reaches disk', async () => {
        await writeFile(configPath, 'server:\n  port: 0\n', 'utf-8');

        // Duplicate mapping key — exactly the shape the old client-side
        // toYaml used to produce by flattening a graph workflow's nodes
        // array (each node has its own `type:`, but flat indent makes
        // them siblings on the parent workflow object).
        const broken = [
            'workflows:',
            '  - name: x',
            '    type: a',
            '    type: b',
            '',
        ].join('\n');

        const put = await server.inject({
            method: 'PUT',
            url: '/api/config',
            payload: { __raw_yaml: broken },
        });
        expect(put.statusCode).toBe(400);
        expect(JSON.parse(put.payload).error).toMatch(/Invalid YAML/);

        // Disk untouched.
        expect(await readFile(configPath, 'utf-8')).toBe('server:\n  port: 0\n');
    });
});
