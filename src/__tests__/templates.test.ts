import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeWorkflow, loadTemplates, resetTemplateCache } from '../core/templates.js';
import { join } from 'node:path';

// Templates dir is at project root
const TEMPLATES_DIR = join(import.meta.dirname, '..', '..', 'templates');

describe('loadTemplates', () => {
    beforeEach(() => resetTemplateCache());

    it('should load YAML templates from disk', async () => {
        const templates = await loadTemplates(TEMPLATES_DIR);

        expect(templates['ai-pr-review']).toBeDefined();
        expect(templates['log-events']).toBeDefined();
        expect(templates['enforce-rules']).toBeDefined();
    });

    it('should have correct steps in ai-pr-review template', async () => {
        const templates = await loadTemplates(TEMPLATES_DIR);
        const t = templates['ai-pr-review'];

        expect(t.steps.length).toBe(4);
        expect(t.steps[0].action).toBe('github-clone-repo');
        expect(t.steps[1].action).toBe('github-fetch-diff');
        expect(t.steps[2].action).toBe('ai-review');
        expect(t.steps[3].action).toBe('github-comment');
    });

    it('should have correct steps in enforce-rules template', async () => {
        const templates = await loadTemplates(TEMPLATES_DIR);
        const t = templates['enforce-rules'];

        expect(t.steps.length).toBe(5);
        expect(t.steps[0].action).toBe('github-clone-repo');
        expect(t.steps[1].action).toBe('ai-agent');
        expect(t.steps[2].action).toBe('ai-agent');
        expect(t.steps[3].action).toBe('github-create-pr');
        expect(t.steps[4].action).toBe('github-comment');
    });

    it('should return empty if directory does not exist', async () => {
        const templates = await loadTemplates('/tmp/nonexistent-dir-999');
        expect(Object.keys(templates).length).toBe(0);
    });
});

describe('normalizeWorkflow', () => {
    beforeEach(() => resetTemplateCache());

    it('should expand a template into steps', async () => {
        const wf = await normalizeWorkflow({
            name: 'test-review',
            template: 'ai-pr-review',
            trigger: { event: 'pull_request.opened' },
        });

        expect(wf.steps.length).toBe(4);
        expect(wf.steps[0].action).toBe('github-clone-repo');
        expect(wf.trigger.source).toBe('github');
    });

    it('should error on unknown template', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                template: 'nonexistent-template',
                trigger: { event: 'push' },
            }),
        ).rejects.toThrow('Unknown workflow template');
    });

    it('should allow user steps to override template steps', async () => {
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

    it('should resolve shorthand triggers', async () => {
        const wf = await normalizeWorkflow({
            name: 'test',
            trigger: {
                event: 'pull_request.opened',
                repo: 'my/repo',
                branch: 'main',
                author: 'octocat',
            },
            steps: [{ action: 'log', params: {} }],
        });

        expect(wf.trigger.filters?.['metadata.repo']).toBe('my/repo');
        expect(wf.trigger.filters?.['payload.pull_request.base.ref']).toBe('main');
        expect(wf.trigger.filters?.['payload.pull_request.user.login']).toBe('octocat');
    });

    it('should resolve labels shorthand', async () => {
        const wf = await normalizeWorkflow({
            name: 'test',
            trigger: {
                event: 'pull_request.opened',
                labels: ['bug', 'urgent'],
            },
            steps: [{ action: 'log', params: {} }],
        });

        expect(wf.trigger.filters?.['payload.pull_request.labels[].name']).toBeDefined();
    });

    it('should error if no trigger', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                steps: [{ action: 'log', params: {} }],
            }),
        ).rejects.toThrow('must have a trigger');
    });

    it('should error if no steps and no template', async () => {
        await expect(
            normalizeWorkflow({
                name: 'bad',
                trigger: { event: 'push' },
            }),
        ).rejects.toThrow('must have steps');
    });
});
