import { describe, it, expect } from 'vitest';
import {
    resolveQueueConfig,
    validateQueueConfig,
    DEFAULT_QUEUE_SETTINGS,
} from './queue-config.js';
import type {
    EventPayload,
    QueueConfig,
    WorkflowDefinition,
} from './types.js';

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'gh-cli',
        event: 'pull_request.opened',
        action: 'opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: { repo: 'org/repo', prNumber: 42 },
        ...overrides,
    };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-workflow',
        trigger: { source: 'gh-cli', event: 'pull_request.opened' },
        steps: [{ action: 'log', params: {} }],
        ...overrides,
    };
}

describe('resolveQueueConfig', () => {
    it('should return defaults when no config provided', () => {
        const config = resolveQueueConfig(makeWorkflow(), makeEvent(), undefined, undefined);

        expect(config.concurrency).toBe(DEFAULT_QUEUE_SETTINGS.concurrency);
        expect(config.dedup).toBe('latest-wins');
        expect(config.priority).toBe('normal');
        expect(config.timeout).toBe(600);
        expect(config.retry).toBe(0);
        expect(config.retryDelay).toBe(30);
    });

    it('should apply global defaults', () => {
        const globalConfig: QueueConfig = {
            defaults: {
                concurrency: 5,
                timeout: 600,
            },
        };

        const config = resolveQueueConfig(makeWorkflow(), makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(5);
        expect(config.timeout).toBe(600);
        expect(config.dedup).toBe('latest-wins');
    });

    it('should apply per_workflow overrides', () => {
        const globalConfig: QueueConfig = {
            defaults: { concurrency: 5 },
            per_workflow: {
                'test-workflow': { concurrency: 1, priority: 'critical' },
            },
        };

        const config = resolveQueueConfig(makeWorkflow(), makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(1);
        expect(config.priority).toBe('critical');
    });

    it('should apply per_repo overrides', () => {
        const globalConfig: QueueConfig = {
            per_repo: {
                'org/repo': { concurrency: 10, priority: 'high' },
            },
        };

        const config = resolveQueueConfig(makeWorkflow(), makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(10);
        expect(config.priority).toBe('high');
    });

    it('should apply inline workflow queue override (highest priority)', () => {
        const globalConfig: QueueConfig = {
            defaults: { concurrency: 5 },
            per_workflow: { 'test-workflow': { concurrency: 2 } },
        };

        const workflow = makeWorkflow({ queue: { concurrency: 1 } });
        const config = resolveQueueConfig(workflow, makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(1);
    });

    it('should interpolate dedup_key template', () => {
        const config = resolveQueueConfig(makeWorkflow(), makeEvent(), undefined, undefined);
        expect(config.dedupKey).toBe('test-workflow:org/repo:42');
    });

    it('should resolve provider name from workflow AI config', () => {
        const globalConfig: QueueConfig = {
            per_provider: {
                opencode: { concurrency: 1 },
            },
        };

        const workflow = makeWorkflow({ ai: { provider: 'opencode' } });
        const config = resolveQueueConfig(workflow, makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(1);
    });

    it('should layer overrides correctly: defaults < per_provider < per_repo < per_workflow < inline', () => {
        const globalConfig: QueueConfig = {
            defaults: { concurrency: 10, timeout: 100 },
            per_provider: { anthropic: { concurrency: 8 } },
            per_repo: { 'org/repo': { concurrency: 6 } },
            per_workflow: { 'test-workflow': { concurrency: 4 } },
        };
        const workflow = makeWorkflow({
            ai: { provider: 'anthropic' },
            queue: { concurrency: 2 },
        });

        const config = resolveQueueConfig(workflow, makeEvent(), globalConfig, undefined);
        expect(config.concurrency).toBe(2);
        expect(config.timeout).toBe(100);
    });
});

describe('validateQueueConfig', () => {
    it('should return undefined for undefined input', () => {
        expect(validateQueueConfig(undefined)).toBeUndefined();
    });

    it('should return undefined for null input', () => {
        expect(validateQueueConfig(null)).toBeUndefined();
    });

    it('should validate a correct config', () => {
        const config = validateQueueConfig({
            defaults: { concurrency: 3 },
            per_workflow: { 'my-wf': { timeout: 120 } },
        });
        expect(config).toBeDefined();
        expect(config!.defaults!.concurrency).toBe(3);
    });

    it('should reject non-object config', () => {
        expect(() => validateQueueConfig('bad')).toThrow('queue config must be an object');
    });

    it('should reject invalid concurrency', () => {
        expect(() => validateQueueConfig({ defaults: { concurrency: 0 } }))
            .toThrow('concurrency must be a positive number');
    });

    it('should reject invalid dedup strategy', () => {
        expect(() => validateQueueConfig({ defaults: { dedup: 'invalid' } }))
            .toThrow('dedup must be one of');
    });

    it('should reject invalid priority', () => {
        expect(() => validateQueueConfig({ defaults: { priority: 'urgent' } }))
            .toThrow('priority must be one of');
    });

    it('should reject negative timeout', () => {
        expect(() => validateQueueConfig({ defaults: { timeout: -1 } }))
            .toThrow('timeout must be a non-negative number');
    });

    it('should reject negative retry', () => {
        expect(() => validateQueueConfig({ defaults: { retry: -1 } }))
            .toThrow('retry must be a non-negative number');
    });

    it('should reject non-object per_workflow', () => {
        expect(() => validateQueueConfig({ per_workflow: 'bad' }))
            .toThrow('per_workflow must be an object');
    });

    it('should reject invalid per_workflow entry', () => {
        expect(() => validateQueueConfig({ per_workflow: { wf: 42 } }))
            .toThrow('per_workflow.wf must be an object');
    });
});
