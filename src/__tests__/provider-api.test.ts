import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';

// Exercises the dashboard provider API's header handling end-to-end: that
// custom headers are sanitized on write (the same rule the config parser
// applies), preserved across an edit that omits them, and clearable — and
// that the GET response surfaces them. These paths gate whether a header set
// via the dashboard actually reaches a request, so they need real coverage.

const TMP_DIR = join(tmpdir(), `sokuza-provider-api-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

describe('provider API — custom headers', () => {
    let server: FastifyInstance;
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
        const configPath = join(TMP_DIR, `config-${slug}.yaml`);
        // ConfigStore reads/updates an existing file — seed a minimal valid one.
        await writeFile(configPath, 'server:\n  port: 24847\n');
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

    /** Create an openai-compatible provider; returns the parsed response. */
    async function createProvider(body: Record<string, unknown>) {
        const res = await server.inject({ method: 'POST', url: '/api/ai/providers', payload: body });
        return { status: res.statusCode, json: JSON.parse(res.payload) };
    }

    async function putProvider(name: string, body: Record<string, unknown>) {
        const res = await server.inject({ method: 'PUT', url: `/api/ai/providers/${name}`, payload: body });
        return { status: res.statusCode, json: JSON.parse(res.payload) };
    }

    /** Fetch the masked entry for a provider from GET /api/ai/providers. */
    async function getProvider(name: string): Promise<Record<string, any> | undefined> {
        const res = await server.inject({ method: 'GET', url: '/api/ai/providers' });
        const { providers } = JSON.parse(res.payload) as { providers: Array<Record<string, any>> };
        return providers.find((p) => p.name === name);
    }

    const base = {
        name: 'kimi',
        kind: 'openai-compatible-api',
        base_url: 'https://api.kimi.com/coding/v1',
        api_key: 'sk-test',
        default_model: 'kimi-k2.6',
    };

    it('POST persists valid custom headers and GET surfaces them', async () => {
        const created = await createProvider({ ...base, headers: { 'User-Agent': 'claude-code/0.1.0' } });
        expect(created.status).toBe(200);

        const got = await getProvider('kimi');
        expect(got?.headers_masked).toEqual({ 'User-Agent': 'claude-code/0.1.0' });
        // Secrets stay masked; headers are returned as-is.
        expect(got?.api_key_masked).not.toBe('sk-test');
    });

    it('PUT strips reserved names, invalid names, and control-char values', async () => {
        await createProvider({ ...base, headers: { 'User-Agent': 'claude-code/0.1.0' } });

        const res = await putProvider('kimi', {
            ...base,
            headers: {
                Authorization: 'Bearer evil',
                'content-type': 'text/plain',
                'Bad Name': 'x',
                'X-Inject': 'a\r\nB: c',
                'X-Keep': 'yes',
            },
        });
        expect(res.status).toBe(200);

        const got = await getProvider('kimi');
        expect(got?.headers_masked).toEqual({ 'X-Keep': 'yes' });
    });

    it('PUT omitting headers preserves the existing set', async () => {
        await createProvider({ ...base, headers: { 'User-Agent': 'claude-code/0.1.0' } });

        // A normal edit (e.g. changing the model) sends no headers field.
        const res = await putProvider('kimi', { ...base, default_model: 'kimi-k2.7' });
        expect(res.status).toBe(200);

        const got = await getProvider('kimi');
        expect(got?.headers_masked).toEqual({ 'User-Agent': 'claude-code/0.1.0' });
        expect(got?.default_model).toBe('kimi-k2.7');
    });

    it('PUT with an empty headers map clears the existing set', async () => {
        await createProvider({ ...base, headers: { 'User-Agent': 'claude-code/0.1.0' } });

        const res = await putProvider('kimi', { ...base, headers: {} });
        expect(res.status).toBe(200);

        const got = await getProvider('kimi');
        expect(got?.headers_masked).toBeUndefined();
    });

    it('GET masks secret-bearing header values but not benign ones', async () => {
        await createProvider({
            ...base,
            headers: { 'User-Agent': 'claude-code/0.1.0', 'X-API-Key': 'super-secret-value-123' },
        });

        const got = await getProvider('kimi');
        expect(got?.headers_masked['User-Agent']).toBe('claude-code/0.1.0');
        // The secret value is not echoed in cleartext.
        expect(got?.headers_masked['X-API-Key']).not.toBe('super-secret-value-123');
        expect(got?.headers_masked['X-API-Key']).toBeTruthy();
    });

    it('round-tripping the masked GET payload does not corrupt the stored secret', async () => {
        await createProvider({ ...base, headers: { 'X-API-Key': 'super-secret-value-123' } });

        // A naive client echoes the GET payload back (masked headers under
        // `headers_masked`) while editing another field. The write path reads
        // `headers`, which the GET deliberately doesn't expose, so the raw
        // secret must survive.
        const got = await getProvider('kimi');
        const res = await putProvider('kimi', {
            ...base,
            default_model: 'kimi-k2.7',
            headers_masked: got?.headers_masked,
        });
        expect(res.status).toBe(200);

        // Assert against the RAW stored value — masking is idempotent, so a GET
        // can't distinguish a corrupted (mask-of-mask) header from a good one.
        const cfg = await configStore.read() as any;
        expect(cfg.ai.providers.kimi.headers['X-API-Key']).toBe('super-secret-value-123');
    });

    it('PUT preserves the api_key when the edit omits it', async () => {
        await createProvider({ ...base, headers: { 'User-Agent': 'claude-code/0.1.0' } });

        // Edit without re-sending the (masked) key — must not blank it out.
        const res = await putProvider('kimi', {
            name: 'kimi',
            kind: 'openai-compatible-api',
            base_url: 'https://api.kimi.com/coding/v1',
            default_model: 'kimi-k2.6',
        });
        expect(res.status).toBe(200);

        const got = await getProvider('kimi');
        expect(got?.key_status).toBe('plaintext');
    });
});
