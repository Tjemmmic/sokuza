import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeWorkflow, loadTemplates, resetTemplateCache } from './templates.js';
import { join } from 'node:path';

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

    it('resolves single author to a filter', async () => {
        const wf = await normalizeWorkflow(
            minWorkflow({ source: 'github', event: 'push', author: 'dependabot[bot]' }),
        );
        expect(wf.trigger.filters?.['payload.pull_request.user.login']).toBe('dependabot[bot]');
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
    it('expands a template into steps', async () => {
        const wf = await normalizeWorkflow({
            name: 'test-review',
            template: 'ai-pr-review',
            trigger: { event: 'pull_request.opened' },
        });

        expect(wf.steps.length).toBeGreaterThan(0);
        expect(wf.steps[0].action).toBe('github-clone-repo');
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

        expect(wf.steps.length).toBe(1);
        expect(wf.steps[0].action).toBe('log');
    });
});
