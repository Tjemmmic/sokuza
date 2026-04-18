import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';
import { runUpdateCommand } from '../cli/update.js';
import { VERSION } from '../version.js';

const TMP_DIR = join(tmpdir(), `sokuza-system-api-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

/**
 * Mount just enough of the API to exercise the /api/system/* routes. The
 * system endpoints shell out to OS-level managers (systemctl, launchctl,
 * schtasks) or npm, so most paths here assert response *shape* and the
 * handful of deterministic behaviours — full platform-specific service
 * installs are covered by the unit tests in service.test.ts.
 */
describe('/api/system/* routes', () => {
    let server: FastifyInstance;
    let configPath: string;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
        configPath = join(TMP_DIR, 'config.yaml');
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
            getConfig: () => ({
                server: { port: 0 },
                integrations: {},
                workflows: [],
            }),
            previewEvent: () => ({ matched: [], unmatched: [] }),
            getWebhookDeliveries: () => [],
        });
    });

    afterAll(async () => {
        await server.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    it('GET /api/system/info surfaces the version, platform, and config path the server is bound to', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/system/info' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.version).toBe(VERSION);
        expect(body.platform).toBe(process.platform);
        expect(typeof body.pid).toBe('number');
        // The dashboard needs to render the config path the engine actually loaded,
        // not an uninterpreted relative form — confirm we resolve through ConfigStore.
        expect(body.configPath).toBe(configPath);
    });

    it('GET /api/system/service returns a status shape for the current platform without shelling out on the happy path', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/system/service' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBeDefined();
        expect(body.status.platform).toBe(process.platform);
        // Whatever the current machine state is, the three booleans must be present
        // so the dashboard's rendering logic doesn't need to handle undefined.
        expect(typeof body.status.installed).toBe('boolean');
        expect(typeof body.status.enabled).toBe('boolean');
        expect(typeof body.status.active).toBe('boolean');
        expect(typeof body.status.unitPath).toBe('string');
        expect(body.status.unitPath.length).toBeGreaterThan(0);
    });

    it('GET /api/system/update returns a snapshot with the running version even when the cache is empty', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/system/update' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.current).toBe(VERSION);
        // `latest`/`checkedAt` can be null (no check yet); `updateAvailable` must be a boolean.
        expect(body).toHaveProperty('latest');
        expect(body).toHaveProperty('checkedAt');
        expect(typeof body.updateAvailable).toBe('boolean');
    });
});

describe('runUpdateCommand (pure)', () => {
    it('refuses to shell out when the entry path looks like a source checkout', async () => {
        // Crucial: the API route calls `runUpdateCommand` with
        // `process.argv[1]`, which during the test run points at vitest or
        // the test file — neither lives under a node_modules/sokuza prefix,
        // so detection labels it a source checkout. We rely on this to keep
        // the test suite from invoking a real `npm install -g`.
        const result = await runUpdateCommand({
            entryPath: '/tmp/not/a/real/install/sokuza/dist/index.js',
            captureOutput: true,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('source');
        expect(result.installer.name).toBe('source');
        expect(result.exitCode).toBeNull();
    });
});
