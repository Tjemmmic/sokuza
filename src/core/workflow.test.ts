import { describe, it, expect, vi } from 'vitest';
import { matchesTrigger, executeWorkflow, interpolateParams } from './workflow.js';
import type { EventPayload, WorkflowDefinition, ActionHandler, ActionContext } from './types.js';
import type { Logger } from 'pino';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: {},
        ...overrides,
    };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-wf',
        trigger: {
            source: 'github',
            event: 'pull_request.opened',
        },
        steps: [],
        ...overrides,
    };
}

const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ─── matchesTrigger ─────────────────────────────────────────────────────────

describe('matchesTrigger', () => {
    describe('basic matching', () => {
        it('matches when source and event are exact', () => {
            const wf = makeWorkflow();
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match wrong source', () => {
            const wf = makeWorkflow({ trigger: { source: 'slack', event: 'message' } });
            const event = makeEvent({ source: 'github', event: 'message' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('does not match wrong event', () => {
            const wf = makeWorkflow({ trigger: { source: 'github', event: 'issues.opened' } });
            const event = makeEvent({ event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });
    });

    describe('disabled workflows', () => {
        it('does not match when enabled is false', () => {
            const wf = makeWorkflow({ enabled: false });
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('matches when enabled is true', () => {
            const wf = makeWorkflow({ enabled: true });
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('matches when enabled is undefined (default enabled)', () => {
            const wf = makeWorkflow();
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });

    describe('multi-value source', () => {
        it('matches any source in the array', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'slack'], event: 'message' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'message' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'slack', event: 'message' }))).toBe(true);
        });

        it('does not match source not in the array', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'slack'], event: 'message' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'cron', event: 'message' }))).toBe(false);
        });
    });

    describe('multi-value event', () => {
        it('matches any event in the array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({ event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ event: 'pull_request.synchronize' }))).toBe(true);
        });

        it('does not match event not in the array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({ event: 'issues.opened' }))).toBe(false);
        });
    });

    describe('source isolation (no cross-matching)', () => {
        it('github-poll source does NOT match github trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'github-poll' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('gh-cli source does NOT match github trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'gh-cli' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('gh-cli source matches gh-cli trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'gh-cli', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'gh-cli' });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('workflow can target multiple sources explicitly', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'gh-cli'], event: 'pull_request.opened' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'github' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'gh-cli' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'github-poll' }))).toBe(false);
        });
    });

    describe('manual source matching', () => {
        it('matches when manual is in the trigger source list', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'manual'], event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when manual is NOT in the trigger source list', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });
    });

    describe('filters', () => {
        it('matches when filter value equals resolved path', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo' } });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when filter value differs', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ metadata: { repo: 'other/repo' } });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('supports deep dot-path filters', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.base.ref': 'main' },
                },
            });
            const event = makeEvent({
                payload: { pull_request: { base: { ref: 'main' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('supports array-contains filter with [] syntax', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.labels[].name': 'needs-review' },
                },
            });
            const event = makeEvent({
                payload: {
                    pull_request: {
                        labels: [
                            { name: 'bug' },
                            { name: 'needs-review' },
                        ],
                    },
                },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('array-contains returns false when label not found', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.labels[].name': 'urgent' },
                },
            });
            const event = makeEvent({
                payload: {
                    pull_request: {
                        labels: [{ name: 'bug' }, { name: 'docs' }],
                    },
                },
            });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('skips filters for manual triggers', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: ['github', 'manual'],
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened', metadata: {} });
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });

    describe('multi-value repo/branch/author shorthand matching', () => {
        it('matches when repo is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['org/repo-a', 'org/repo-b'],
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo-a' } });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when repo is not in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['org/repo-a', 'org/repo-b'],
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo-c' } });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('matches when branch is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    branch: ['main', 'develop'],
                },
            });
            const event = makeEvent({
                payload: { pull_request: { base: { ref: 'develop' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('matches when author is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    author: ['user-a', 'user-b'],
                },
            });
            const event = makeEvent({
                payload: { pull_request: { user: { login: 'user-b' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('single-value repo is handled by filters, not shorthand', () => {
            // Single values are < 2 items so shorthand check skips (values.length <= 1)
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: 'org/repo',
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo' } });
            // This still matches because single-value is handled by filters or trivially passes
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });
});

// ─── interpolateParams ──────────────────────────────────────────────────────

describe('interpolateParams', () => {
    const baseContext: ActionContext = {
        event: makeEvent({
            payload: { pull_request: { title: 'Fix bug', number: 42 } },
            metadata: { repo: 'org/repo' },
        }),
        results: { 0: { summary: 'All good' } },
        steps: { analysis: { needs_fix: true, summary: 'Found issue' } },
        integrationConfigs: {},
        logger: noopLogger,
    };

    it('resolves simple event paths', () => {
        const params = { repo: '{{event.metadata.repo}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.repo).toBe('org/repo');
    });

    it('resolves nested payload paths', () => {
        const params = { title: '{{event.payload.pull_request.title}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.title).toBe('Fix bug');
    });

    it('resolves step results by id', () => {
        const params = { summary: '{{steps.analysis.summary}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.summary).toBe('Found issue');
    });

    it('resolves results by index', () => {
        const params = { prev: '{{results.0.summary}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.prev).toBe('All good');
    });

    it('returns empty string for undefined paths', () => {
        const params = { missing: '{{event.payload.nonexistent.path}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.missing).toBe('');
    });

    it('handles multiple expressions in one string', () => {
        const params = { msg: 'PR #{{event.payload.pull_request.number}} in {{event.metadata.repo}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.msg).toBe('PR #42 in org/repo');
    });

    it('recursively resolves nested objects', () => {
        const params = {
            outer: {
                inner: '{{event.metadata.repo}}',
            },
        };
        const result = interpolateParams(params, baseContext);
        expect((result.outer as Record<string, unknown>).inner).toBe('org/repo');
    });

    it('passes non-string values through unchanged', () => {
        const params = { count: 42, flag: true, items: [1, 2, 3] };
        const result = interpolateParams(params, baseContext);
        expect(result.count).toBe(42);
        expect(result.flag).toBe(true);
        expect(result.items).toEqual([1, 2, 3]);
    });
});

// ─── executeWorkflow ────────────────────────────────────────────────────────

describe('executeWorkflow', () => {
    it('executes steps in order and passes results forward', async () => {
        const order: string[] = [];
        const actionA: ActionHandler = async () => {
            order.push('a');
            return { result: 'from-a' };
        };
        const actionB: ActionHandler = async (_params, ctx) => {
            order.push('b');
            return { result: 'from-b', prev: ctx.results[0] };
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('action-a', actionA);
        registry.set('action-b', actionB);

        const wf = makeWorkflow({
            steps: [
                { action: 'action-a', params: {} },
                { action: 'action-b', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['a', 'b']);
    });

    it('skips unknown actions', async () => {
        const registry = new Map<string, ActionHandler>();
        const wf = makeWorkflow({
            steps: [{ action: 'does-not-exist', params: {} }],
        });

        // Should not throw
        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(noopLogger.warn).toHaveBeenCalled();
    });

    it('stores results by step id', async () => {
        let capturedCtx: ActionContext | null = null;
        const actionA: ActionHandler = async () => ({ value: 'hello' });
        const actionB: ActionHandler = async (_params, ctx) => {
            capturedCtx = ctx;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('action-a', actionA);
        registry.set('action-b', actionB);

        const wf = makeWorkflow({
            steps: [
                { action: 'action-a', id: 'greet', params: {} },
                { action: 'action-b', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(capturedCtx!.steps.greet).toEqual({ value: 'hello' });
    });

    it('on_error=continue skips failed steps', async () => {
        const order: string[] = [];
        const failAction: ActionHandler = async () => {
            order.push('fail');
            throw new Error('boom');
        };
        const okAction: ActionHandler = async () => {
            order.push('ok');
            return 'success';
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);
        registry.set('ok-action', okAction);

        const wf = makeWorkflow({
            steps: [
                { action: 'fail-action', params: {}, on_error: 'continue' },
                { action: 'ok-action', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['fail', 'ok']);
    });

    it('on_error=stop (default) throws on failure', async () => {
        const failAction: ActionHandler = async () => {
            throw new Error('boom');
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);

        const wf = makeWorkflow({
            steps: [{ action: 'fail-action', params: {} }],
        });

        await expect(
            executeWorkflow(wf, makeEvent(), registry, noopLogger),
        ).rejects.toThrow('boom');
    });

    it('evaluates conditions — skips step when condition is falsy', async () => {
        const order: string[] = [];
        const action: ActionHandler = async () => {
            order.push('ran');
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: {}, condition: '{{event.payload.nonexistent}}' },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual([]); // Step was skipped
    });

    it('evaluates conditions — runs step when condition is truthy', async () => {
        const order: string[] = [];
        const action: ActionHandler = async () => {
            order.push('ran');
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: {}, condition: '{{event.source}}' },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['ran']);
    });

    it('interpolates step params before passing to handler', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: { repo: '{{event.metadata.repo}}' } },
            ],
        });

        await executeWorkflow(
            wf,
            makeEvent({ metadata: { repo: 'org/my-repo' } }),
            registry,
            noopLogger,
        );
        expect(receivedParams.repo).toBe('org/my-repo');
    });
});
