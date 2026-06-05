import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventPayload, Integration, SokuzaConfig } from './types.js';

const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'silent',
};

vi.mock('pino', () => {
    const noopStream = { write: vi.fn() };
    return {
        default: Object.assign(() => silentLogger, { multistream: () => noopStream }),
    };
});

vi.mock('pino-pretty', () => ({
    default: () => ({ write: vi.fn() }),
}));

vi.mock('./log-store.js', () => ({
    LogStore: class {
        write = vi.fn();
        getEntries = vi.fn(() => []);
        subscribe = vi.fn(() => vi.fn());
    },
}));

vi.mock('../server/server.js', () => ({
    createServer: vi.fn(() => ({ listen: vi.fn(), close: vi.fn() })),
}));

vi.mock('../server/api.js', () => ({
    registerApiRoutes: vi.fn(),
}));

let TMP_DIR: string;
let configPath: string;

function makeConfig(overrides: Partial<SokuzaConfig> = {}): SokuzaConfig {
    return {
        server: { port: 0 },
        integrations: {},
        workflows: [],
        ...overrides,
    };
}

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        action: 'opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: {},
        ...overrides,
    };
}

beforeEach(async () => {
    TMP_DIR = join(tmpdir(), `sokuza-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(TMP_DIR, { recursive: true });
    configPath = join(TMP_DIR, 'sokuza.config.yaml');
    await writeFile(
        configPath,
        'server:\n  port: 0\nintegrations: {}\nworkflows: []\n',
        'utf-8',
    );
    vi.clearAllMocks();
});

afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('SokuzaEngine', () => {
    async function createEngine(config?: Partial<SokuzaConfig>) {
        const { SokuzaEngine } = await import('./engine.js');
        return new SokuzaEngine(makeConfig(config), configPath);
    }

    describe('registerIntegration', () => {
        it('stores integration and collects its actions into the registry', async () => {
            const engine = await createEngine();
            const handler = vi.fn();
            const integration: Integration = {
                name: 'test-int',
                supportedEvents: ['test.event'],
                actions: { 'act-a': handler, 'act-b': handler },
                initialize: vi.fn(),
                registerRoutes: vi.fn(),
                parseEvent: vi.fn(),
            };

            engine.registerIntegration(integration);

            expect(engine.getIntegrationStatus()).toHaveProperty('test-int');
            expect(engine.getIntegrationStatus()['test-int'].enabled).toBe(false);
            expect(engine.getIntegrationStatus()['test-int'].events).toEqual(['test.event']);
        });
    });

    describe('registerAutoDetectedIntegration', () => {
        function makeGhLikeIntegration(): Integration {
            return {
                name: 'gh-cli',
                supportedEvents: ['pr.opened'],
                initialize: vi.fn(),
                registerRoutes: vi.fn(),
                parseEvent: vi.fn(),
            };
        }

        it('reports as enabled despite no entry in the config file', async () => {
            const engine = await createEngine();
            engine.registerAutoDetectedIntegration(makeGhLikeIntegration());

            expect(engine.getIntegrationStatus()['gh-cli'].enabled).toBe(true);
        });

        it('survives reloadConfig() — the config file never carries it', async () => {
            // Regression: reloadConfig() replaces config.integrations with the
            // on-disk version (which omits auto-detected gh-cli). Without
            // re-seeding, the integration flips to "not configured" after any
            // workflow edit triggers a reload.
            const engine = await createEngine();
            engine.registerAutoDetectedIntegration(makeGhLikeIntegration());
            expect(engine.getIntegrationStatus()['gh-cli'].enabled).toBe(true);

            await engine.reloadConfig();

            expect(engine.getIntegrationStatus()['gh-cli'].enabled).toBe(true);
        });
    });

    describe('registerAction', () => {
        it('stores action by name', async () => {
            const engine = await createEngine();
            const handler = vi.fn();

            engine.registerAction('my-action', handler);

            const registered = (engine as any).actions as Map<string, unknown>;
            expect(registered.has('my-action')).toBe(true);
        });
    });

    describe('handleEvent', () => {
        it('deduplicates by deliveryId', async () => {
            const engine = await createEngine({
                workflows: [
                    {
                        name: 'wf-a',
                        trigger: { source: 'github', event: 'pull_request.opened' },
                        steps: [{ action: 'log', params: {} }],
                    },
                ],
            });

            const handleEvent = (engine as any).handleEvent.bind(engine);
            const deliveryId = `del-${Date.now()}`;

            const event1 = makeEvent({ metadata: { deliveryId } });
            const event2 = makeEvent({ metadata: { deliveryId } });

            await handleEvent(event1);
            await handleEvent(event2);

            const queue = engine.getQueue();
            const jobs = queue.getJobs();
            expect(jobs.length).toBe(1);
        });

        it('matches workflows and enqueues them', async () => {
            const engine = await createEngine({
                workflows: [
                    {
                        name: 'wf-match',
                        trigger: { source: 'github', event: 'pull_request.opened' },
                        steps: [{ action: 'log', params: {} }],
                    },
                    {
                        name: 'wf-no-match',
                        trigger: { source: 'slack', event: 'message' },
                        steps: [{ action: 'log', params: {} }],
                    },
                ],
            });

            const handleEvent = (engine as any).handleEvent.bind(engine);
            await handleEvent(makeEvent());

            const queue = engine.getQueue();
            const jobs = queue.getJobs();
            expect(jobs.some((j) => j.workflow.name === 'wf-match')).toBe(true);
            expect(jobs.some((j) => j.workflow.name === 'wf-no-match')).toBe(false);
        });

        it('skips disabled workflows', async () => {
            const engine = await createEngine({
                workflows: [
                    {
                        name: 'wf-disabled',
                        enabled: false,
                        trigger: { source: 'github', event: 'pull_request.opened' },
                        steps: [{ action: 'log', params: {} }],
                    },
                ],
            });

            const handleEvent = (engine as any).handleEvent.bind(engine);
            await handleEvent(makeEvent());

            const queue = engine.getQueue();
            const jobs = queue.getJobs();
            expect(jobs.length).toBe(0);
        });
    });

    describe('previewEvent', () => {
        it('returns matched and unmatched workflow names', async () => {
            const engine = await createEngine({
                workflows: [
                    {
                        name: 'pr-review',
                        trigger: { source: 'github', event: 'pull_request.opened' },
                        steps: [{ action: 'log', params: {} }],
                    },
                    {
                        name: 'disabled-wf',
                        enabled: false,
                        trigger: { source: 'github', event: 'push' },
                        steps: [{ action: 'log', params: {} }],
                    },
                    {
                        name: 'filtered-pr',
                        trigger: {
                            source: 'github',
                            event: 'pull_request.opened',
                            filters: { 'metadata.repo': 'org/important' },
                        },
                        steps: [{ action: 'log', params: {} }],
                    },
                ],
            });

            const event = makeEvent();
            const result = engine.previewEvent(event);

            expect(result.matched).toContain('pr-review');
            expect(result.unmatched).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'disabled-wf', reason: expect.stringContaining('disabled') }),
                    expect.objectContaining({ name: 'filtered-pr' }),
                ]),
            );
        });
    });

    describe('runWorkflowByName', () => {
        it('throws for unknown workflow', async () => {
            const engine = await createEngine();

            const result = await engine.runWorkflowByName('nonexistent-wf');

            expect(result.ok).toBe(false);
            expect(result.error).toContain('not found');
        });
    });
});
