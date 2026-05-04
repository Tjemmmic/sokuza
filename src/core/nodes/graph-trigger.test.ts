import { describe, it, expect } from 'vitest';
import { extractTriggerFromGraph, normalizeGraphWorkflow, isGraphWorkflow } from './graph-trigger.js';
import type { WorkflowDefinition } from '../types.js';

describe('isGraphWorkflow', () => {
    it('detects graphs with at least one node', () => {
        expect(isGraphWorkflow({ name: 'x', trigger: { source: 'github', event: 'x' }, graph: { nodes: [{ id: 'a', type: 'trigger.github' }], edges: [] } } as WorkflowDefinition)).toBe(true);
    });
    it('treats empty graph as not a graph workflow', () => {
        expect(isGraphWorkflow({ name: 'x', trigger: { source: 'github', event: 'x' }, graph: { nodes: [], edges: [] } } as WorkflowDefinition)).toBe(false);
    });
});

describe('extractTriggerFromGraph', () => {
    it('builds a TriggerDefinition from a github trigger node', () => {
        const trigger = extractTriggerFromGraph({
            nodes: [
                {
                    id: 'trig',
                    type: 'trigger.github',
                    config: {
                        events: ['pull_request.opened'],
                        repos: 'org/repo-a, org/repo-b',
                        branches: 'main',
                        authors: 'dependabot[bot]',
                        labels: 'sokuza-review',
                    },
                },
            ],
            edges: [],
        });
        expect(trigger).toEqual({
            source: 'github',
            event: ['pull_request.opened'],
            repo: ['org/repo-a', 'org/repo-b'],
            branch: ['main'],
            author: ['dependabot[bot]'],
            labels: ['sokuza-review'],
        });
    });

    it('returns undefined when there is no trigger node', () => {
        const trigger = extractTriggerFromGraph({ nodes: [], edges: [] });
        expect(trigger).toBeUndefined();
    });

    it('maps cron schedule to the legacy event field', () => {
        const trigger = extractTriggerFromGraph({
            nodes: [{ id: 'cron', type: 'trigger.cron', config: { schedule: '0 9 * * *' } }],
            edges: [],
        });
        expect(trigger).toEqual({ source: 'cron', event: ['0 9 * * *'] });
    });
});

describe('normalizeGraphWorkflow', () => {
    it('populates trigger from the graph', () => {
        const wf = {
            name: 'gw',
            trigger: undefined as any,
            graph: {
                nodes: [{ id: 't', type: 'trigger.github', config: { events: ['issues.opened'] } }],
                edges: [],
            },
        } as WorkflowDefinition;
        const normalized = normalizeGraphWorkflow(wf);
        expect(normalized.trigger.source).toBe('github');
        expect(normalized.trigger.event).toEqual(['issues.opened']);
    });
});
