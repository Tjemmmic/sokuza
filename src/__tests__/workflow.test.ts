import { describe, it, expect } from 'vitest';
import { matchesTrigger, interpolateParams } from '../core/workflow.js';
import type {
    ActionContext,
    EventPayload,
    WorkflowDefinition,
} from '../core/types.js';
import { loadAIProviders } from '../core/ai-providers.js';
import pino from 'pino';

const mockLogger = pino({ level: 'silent' });

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'issues.opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: { repo: 'my-org/my-repo' },
        ...overrides,
    };
}

function makeWorkflow(
    overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
    return {
        name: 'test-workflow',
        trigger: {
            source: 'github',
            event: 'issues.opened',
        },
        steps: [],
        ...overrides,
    };
}

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
        event: makeEvent({
            payload: {
                issue: { title: 'Bug report', number: 42 },
            },
        }),
        results: {},
        steps: {},
        integrationConfigs: {},
        ai: loadAIProviders(undefined),
        logger: mockLogger,
        ...overrides,
    };
}

describe('matchesTrigger', () => {
    it('should match when source and event match', () => {
        expect(matchesTrigger(makeWorkflow(), makeEvent())).toBe(true);
    });

    it('should not match when source differs', () => {
        const wf = makeWorkflow({
            trigger: { source: 'slack', event: 'issues.opened' },
        });
        expect(matchesTrigger(wf, makeEvent())).toBe(false);
    });

    it('should not match when event differs', () => {
        const wf = makeWorkflow({
            trigger: { source: 'github', event: 'push' },
        });
        expect(matchesTrigger(wf, makeEvent())).toBe(false);
    });

    it('should match with passing metadata filters', () => {
        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'issues.opened',
                filters: { 'metadata.repo': 'my-org/my-repo' },
            },
        });
        expect(matchesTrigger(wf, makeEvent())).toBe(true);
    });

    it('should not match with failing metadata filters', () => {
        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'issues.opened',
                filters: { 'metadata.repo': 'other-org/other-repo' },
            },
        });
        expect(matchesTrigger(wf, makeEvent())).toBe(false);
    });

    // ─── Deep-path filter tests ─────────────────────────────────────────

    it('should match deep payload path filters', () => {
        const event = makeEvent({
            event: 'pull_request.opened',
            payload: {
                pull_request: {
                    user: { login: 'alice' },
                    base: { ref: 'main' },
                },
            },
        });

        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'pull_request.opened',
                filters: {
                    'payload.pull_request.user.login': 'alice',
                    'payload.pull_request.base.ref': 'main',
                },
            },
        });

        expect(matchesTrigger(wf, event)).toBe(true);
    });

    it('should reject when deep payload path does not match', () => {
        const event = makeEvent({
            event: 'pull_request.opened',
            payload: {
                pull_request: {
                    user: { login: 'bob' },
                    base: { ref: 'main' },
                },
            },
        });

        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'pull_request.opened',
                filters: {
                    'payload.pull_request.user.login': 'alice',
                },
            },
        });

        expect(matchesTrigger(wf, event)).toBe(false);
    });

    // ─── Array-contains filter tests ────────────────────────────────────

    it('should match array-contains filter when label exists', () => {
        const event = makeEvent({
            event: 'pull_request.labeled',
            payload: {
                pull_request: {
                    labels: [
                        { name: 'bug' },
                        { name: 'needs-review' },
                    ],
                },
            },
        });

        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'pull_request.labeled',
                filters: {
                    'payload.pull_request.labels[].name': 'needs-review',
                },
            },
        });

        expect(matchesTrigger(wf, event)).toBe(true);
    });

    it('should reject array-contains filter when label is missing', () => {
        const event = makeEvent({
            event: 'pull_request.labeled',
            payload: {
                pull_request: {
                    labels: [{ name: 'bug' }],
                },
            },
        });

        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'pull_request.labeled',
                filters: {
                    'payload.pull_request.labels[].name': 'needs-review',
                },
            },
        });

        expect(matchesTrigger(wf, event)).toBe(false);
    });

    it('should reject array-contains when field is not an array', () => {
        const event = makeEvent({
            event: 'pull_request.labeled',
            payload: {
                pull_request: { labels: 'not-an-array' },
            },
        });

        const wf = makeWorkflow({
            trigger: {
                source: 'github',
                event: 'pull_request.labeled',
                filters: {
                    'payload.pull_request.labels[].name': 'needs-review',
                },
            },
        });

        expect(matchesTrigger(wf, event)).toBe(false);
    });
});

describe('interpolateParams', () => {
    it('should interpolate simple template expressions', () => {
        const context = makeContext();
        const params = { message: 'Issue: {{event.payload.issue.title}}' };
        const result = interpolateParams(params, context);
        expect(result.message).toBe('Issue: Bug report');
    });

    it('should interpolate numeric values', () => {
        const context = makeContext();
        const params = { number: 'Issue #{{event.payload.issue.number}}' };
        const result = interpolateParams(params, context);
        expect(result.number).toBe('Issue #42');
    });

    it('should handle nested object params', () => {
        const context = makeContext();
        const params = {
            body: {
                title: '{{event.payload.issue.title}}',
                static: 'hello',
            },
        };
        const result = interpolateParams(params, context);
        expect((result.body as any).title).toBe('Bug report');
        expect((result.body as any).static).toBe('hello');
    });

    it('should replace missing paths with empty string', () => {
        const context = makeContext();
        const params = { message: '{{event.payload.nonexistent.field}}' };
        const result = interpolateParams(params, context);
        expect(result.message).toBe('');
    });

    it('should preserve non-string values', () => {
        const context = makeContext();
        const params = { count: 5, enabled: true };
        const result = interpolateParams(params, context);
        expect(result.count).toBe(5);
        expect(result.enabled).toBe(true);
    });

    it('should resolve steps.* references by step ID', () => {
        const context = makeContext({
            steps: {
                fetch_diff: { diff: 'some diff content', files: ['a.ts'] },
            },
        });
        const params = { diff: '{{steps.fetch_diff.diff}}' };
        const result = interpolateParams(params, context);
        expect(result.diff).toBe('some diff content');
    });
});
