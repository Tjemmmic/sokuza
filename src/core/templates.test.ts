import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeWorkflow, loadTemplates, resetTemplateCache } from './templates.js';
import { matchesTrigger } from './workflow.js';
import { join } from 'node:path';
import type { EventPayload } from './types.js';

const TEMPLATES_DIR = join(import.meta.dirname, '..', '..', 'templates');

beforeEach(() => {
    resetTemplateCache();
});

// ─── resolveShorthands (tested via normalizeWorkflow) ───────────────────────

describe('normalizeWorkflow — shorthand resolution', () => {
    const minWorkflow = (trigger: Record<string, unknown>) => ({
        name: 'test-wf',
        trigger,
        steps: [{ action: 'log', params: { message: 'test' } }],
    });

    it('defaults source to github when not specified', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ event: 'push' }),
        );
        expect(wf.trigger.source).toBe('github');
    });

    it('passes source through as-is for single value', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'slack', event: 'message' }),
        );
        expect(wf.trigger.source).toBe('slack');
    });

    it('passes source through as array for multi-value', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: ['github', 'github-poll'], event: 'push' }),
        );
        expect(wf.trigger.source).toEqual(['github', 'github-poll']);
    });

    it('passes event through as-is for single value', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'pull_request.opened' }),
        );
        expect(wf.trigger.event).toBe('pull_request.opened');
    });

    it('passes event through as array for multi-value', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: ['pull_request.opened', 'push'] }),
        );
        expect(wf.trigger.event).toEqual(['pull_request.opened', 'push']);
    });

    it('resolves single repo to a filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', repo: 'org/repo' }),
        );
        expect(wf.trigger.filters?.['metadata.repo']).toBe('org/repo');
    });

    it('resolves single branch to a filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', branch: 'main' }),
        );
        expect(wf.trigger.filters?.['payload.pull_request.base.ref']).toBe('main');
    });

    it('resolves single author to an OR-path filter spanning PR and issue shapes', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', author: 'dependabot[bot]' }),
        );
        // OR-path so `author:` matches issue events too, not only PRs.
        expect(wf.trigger.filters?.['payload.pull_request.user.login|payload.issue.user.login'])
            .toBe('dependabot[bot]');
    });

    it('single-value author matches both PR and issue events end-to-end', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: ['pull_request.opened', 'issues.opened'], author: 'alice' }),
        );
        const base = { source: 'github', timestamp: '', metadata: {} };
        expect(matchesTrigger(wf, { ...base, event: 'pull_request.opened',
            payload: { pull_request: { user: { login: 'alice' } } } } as EventPayload)).toBe(true);
        expect(matchesTrigger(wf, { ...base, event: 'issues.opened',
            payload: { issue: { user: { login: 'alice' } } } } as EventPayload)).toBe(true);
        expect(matchesTrigger(wf, { ...base, event: 'issues.opened',
            payload: { issue: { user: { login: 'bob' } } } } as EventPayload)).toBe(false);
    });

    it('keeps multi-value repo on trigger without converting to filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', repo: ['org/a', 'org/b'] }),
        );
        expect(wf.trigger.repo).toEqual(['org/a', 'org/b']);
        // Should NOT have a filter for metadata.repo
        expect(wf.trigger.filters?.['metadata.repo']).toBeUndefined();
    });

    it('keeps multi-value branch on trigger without converting to filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', branch: ['main', 'develop'] }),
        );
        expect(wf.trigger.branch).toEqual(['main', 'develop']);
        expect(wf.trigger.filters?.['payload.pull_request.base.ref']).toBeUndefined();
    });

    it('keeps multi-value author on trigger without converting to filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', author: ['user-a', 'user-b'] }),
        );
        expect(wf.trigger.author).toEqual(['user-a', 'user-b']);
        expect(wf.trigger.filters?.['payload.pull_request.user.login']).toBeUndefined();
    });

    it('resolves single label to array-contains filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({
                source: 'github',
                event: 'push',
                labels: ['bug'],
            }),
        );
        expect(wf.trigger.filters?.['payload.pull_request.labels[].name']).toBe('bug');
    });

    it('keeps multi-value labels on trigger for multi-match resolution', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({
                source: 'github',
                event: 'push',
                labels: ['bug', 'urgent'],
            }),
        );
        expect(wf.trigger.labels).toEqual(['bug', 'urgent']);
        expect(wf.trigger.filters?.['payload.pull_request.labels[].name']).toBeUndefined();
    });

    it('preserves explicit filters alongside shorthands', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({
                source: 'github',
                event: 'push',
                repo: 'org/repo',
                filters: { 'payload.custom.field': 'value' },
            }),
        );
        expect(wf.trigger.filters?.['metadata.repo']).toBe('org/repo');
        expect(wf.trigger.filters?.['payload.custom.field']).toBe('value');
    });

    it('returns no filters when none are specified', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push' }),
        );
        expect(wf.trigger.filters).toBeUndefined();
    });

    it('passes the exclude block through unchanged', async () => {
        // Engine consumes exclude directly off the trigger — resolveShorthands
        // must not lose it. This pins the contract for YAML-authored workflows
        // (graph workflows go through extractTriggerFromGraph instead).
        const wf = await normalizeWorkflow(
            minWorkflow({
                source: 'github',
                event: 'pull_request.opened',
                exclude: {
                    author: ['dependabot[bot]'],
                    labels: ['wip'],
                    branch: 'releases/*',
                },
            }),
        );
        expect(wf.trigger.exclude).toEqual({
            author: ['dependabot[bot]'],
            labels: ['wip'],
            branch: 'releases/*',
        });
    });
});

// ─── normalizeWorkflow — metadata passthrough ───────────────────────────────

describe('normalizeWorkflow — metadata', () => {
    const base = {
        name: 'test-wf',
        trigger: { source: 'github', event: 'push' },
        steps: [{ action: 'log', params: { message: 'hi' } }],
    };

    it('passes through description', async () => {
        const wf = await normalizeWorkflow({ ...base, description: 'My workflow' });
        expect(wf.description).toBe('My workflow');
    });

    it('passes through enabled=false', async () => {
        const wf = await normalizeWorkflow({ ...base, enabled: false });
        expect(wf.enabled).toBe(false);
    });

    it('passes through enabled=true', async () => {
        const wf = await normalizeWorkflow({ ...base, enabled: true });
        expect(wf.enabled).toBe(true);
    });

    it('leaves enabled as undefined when not set', async () => {
        const wf = await normalizeWorkflow(base);
        expect(wf.enabled).toBeUndefined();
    });

    it('passes through inputs', async () => {
        const inputs = [
            { name: 'pr_url', label: 'PR URL', type: 'text' as const, required: true },
        ];
        const wf = await normalizeWorkflow({ ...base, inputs });
        expect(wf.inputs).toEqual(inputs);
    });
});

// ─── normalizeWorkflow — validation ─────────────────────────────────────────

describe('normalizeWorkflow — validation', () => {
    it('throws when trigger is missing', async () => {
        await expect(
            normalizeWorkflow({ name: 'bad', steps: [{ action: 'log', params: {} }] }),
        ).rejects.toThrow('must have a trigger');
    });

    it('throws when steps are missing and no template', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                trigger: { source: 'github', event: 'push' },
            }),
        ).rejects.toThrow('must have steps');
    });

    it('throws when steps are empty and no template', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                trigger: { source: 'github', event: 'push' },
                steps: [],
            }),
        ).rejects.toThrow('must have steps');
    });

    it('throws for unknown template', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                template: 'nonexistent-template',
                trigger: { source: 'github', event: 'push' },
            }),
        ).rejects.toThrow('Unknown workflow template');
    });
});

// ─── loadTemplates ───────────────────────────────────────────────────────────

describe('loadTemplates', () => {
    it('loads YAML templates from disk', async () => {
        const templates = await loadTemplates(TEMPLATES_DIR);

        expect(templates['ai-pr-review']).toBeDefined();
        expect(templates['log-events']).toBeDefined();
        expect(templates['enforce-rules']).toBeDefined();
    });

    it('returns empty if directory does not exist', async () => {
        const templates = await loadTemplates('/tmp/nonexistent-dir-999');
        expect(Object.keys(templates).length).toBe(0);
    });
});

// ─── normalizeWorkflow — template expansion ──────────────────────────────────

describe('normalizeWorkflow — template expansion', () => {
    it('expands a template — produces steps or graph', async () => {
        const wf = await normalizeWorkflow({
            name: 'test-review',
            template: 'ai-pr-review',
            trigger: { event: 'pull_request.opened' },
        });

        // Templates may be authored as either steps or graph form. We
        // accept either so this test stays green across the conversion
        // of templates from steps→graph in the library overhaul.
        const hasSteps = (wf.steps?.length ?? 0) > 0;
        const hasGraph = !!wf.graph && wf.graph.nodes.length > 0;
        expect(hasSteps || hasGraph).toBe(true);
        expect(wf.trigger.source).toBe('github');
    });

    it('allows user steps to override template steps', async () => {
        const customSteps = [{ action: 'log', params: { message: 'hi' } }];
        const wf = await normalizeWorkflow({
            name: 'custom',
            template: 'ai-pr-review',
            trigger: { event: 'push' },
            steps: customSteps,
        });

        expect(wf.steps?.length).toBe(1);
        expect(wf.steps?.[0].action).toBe('log');
    });

    it('inherits graph from template when workflow has no graph of its own', async () => {
        const wf = await normalizeWorkflow({
            name: 'graph-from-template',
            template: 'log-events',
            trigger: { event: 'push' },
        });

        // log-events is one of the conversion targets; once it's graph-form
        // the workflow should inherit the graph. Until then it stays in
        // steps form. Either is acceptable for this test — we just want to
        // prove inheritance works when the template provides a graph.
        if (wf.graph) {
            expect(wf.graph.nodes.length).toBeGreaterThan(0);
        } else {
            expect(wf.steps?.length).toBeGreaterThan(0);
        }
    });

    it('does not inherit template graph when user provided their own steps', async () => {
        // Regression: log-events used to be steps-form; now graph-form.
        // A user that overrides with custom steps must NOT also receive
        // the template's graph — graph wins at runtime, which would
        // silently make the user's steps dead code.
        const customSteps = [{ action: 'log', params: { message: 'mine' } }];
        const wf = await normalizeWorkflow({
            name: 'mine',
            template: 'log-events',
            trigger: { event: 'push' },
            steps: customSteps,
        });
        expect(wf.steps?.length).toBe(1);
        expect(wf.graph).toBeUndefined();
    });

    it('lets workflow graph win over template graph', async () => {
        const customGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.manual', config: {} },
                { id: 'log', type: 'utility.log', config: { message: 'override' } },
            ],
            edges: [{ from: { node: 'trig', port: 'event' }, to: { node: 'log', port: '__seq' } }],
        };
        const wf = await normalizeWorkflow({
            name: 'override',
            template: 'log-events',
            trigger: { event: 'push' },
            graph: customGraph,
        });

        expect(wf.graph?.nodes).toEqual(customGraph.nodes);
    });
});

// ─── normalizeWorkflow → matchesTrigger pipeline ──────────────────────────────
// Regression: the user-reported `auto-pr-review` workflow had
// `template: ai-pr-review` (graph form) and a YAML override
// `trigger.source: [github, github-poll, gh-cli]`. The graph's
// `trigger.github` node used to overwrite that source, so the workflow
// silently stopped matching github-poll events. These tests pin the
// full load → match pipeline so the regression can't reappear at the
// integration boundary.

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

describe('normalizeWorkflow → matchesTrigger (graph + YAML source override)', () => {
    it('YAML source override on the ai-pr-review template matches all listed sources', async () => {
        const wf = await normalizeWorkflow({
            name: 'auto-pr-review',
            template: 'ai-pr-review',
            trigger: {
                source: ['github', 'github-poll', 'gh-cli'],
                event: ['pull_request.opened', 'pull_request.synchronize'],
            },
        });

        // Source override survives the merge with the template's graph
        // trigger node (which alone would force source back to 'github').
        expect(wf.trigger.source).toEqual(['github', 'github-poll', 'gh-cli']);

        expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'pull_request.opened' }))).toBe(true);
        expect(matchesTrigger(wf, makeEvent({ source: 'github-poll', event: 'pull_request.opened' }))).toBe(true);
        expect(matchesTrigger(wf, makeEvent({ source: 'gh-cli', event: 'pull_request.opened' }))).toBe(true);
    });

    it('preserves YAML filters/labels through the graph merge', async () => {
        const wf = await normalizeWorkflow({
            name: 'filtered-review',
            template: 'ai-pr-review',
            trigger: {
                source: 'gh-cli',
                event: 'pull_request.opened',
                repo: 'my-org/my-repo',
            },
        });

        // Single-value repo shorthand is resolved to a filter by
        // resolveShorthands; that filter must survive the graph merge.
        expect(wf.trigger.filters?.['metadata.repo']).toBe('my-org/my-repo');

        expect(matchesTrigger(wf, makeEvent({
            source: 'gh-cli',
            event: 'pull_request.opened',
            metadata: { repo: 'my-org/my-repo' },
        }))).toBe(true);

        expect(matchesTrigger(wf, makeEvent({
            source: 'gh-cli',
            event: 'pull_request.opened',
            metadata: { repo: 'other/repo' },
        }))).toBe(false);
    });
});
