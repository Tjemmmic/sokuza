import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { executeWorkflow, matchesTrigger } from '../workflow.js';
import { getNodeRegistry, resetNodeRegistry } from './registry.js';
import { registerBuiltinNodes } from './builtins.js';
import type { ActionHandler, EventPayload, WorkflowDefinition } from '../types.js';

const noopLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function evt(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: new Date().toISOString(),
        payload: { pull_request: { number: 7, title: 'WIP' } },
        metadata: { repo: 'org/r' },
        ...overrides,
    };
}

beforeEach(() => {
    resetNodeRegistry();
    registerBuiltinNodes(getNodeRegistry());
});

describe('graph workflow end-to-end', () => {
    it('executeWorkflow dispatches to the graph runtime when graph is set', async () => {
        const messages: string[] = [];
        const actions = new Map<string, ActionHandler>();
        actions.set('log', async (params) => {
            messages.push(String(params.message));
            return { logged: true };
        });

        const wf: WorkflowDefinition = {
            name: 'g',
            trigger: { source: 'github', event: 'pull_request.opened' },
            graph: {
                nodes: [
                    { id: 'trig', type: 'trigger.github', config: { events: ['pull_request.opened'] } },
                    { id: 'log1', type: 'utility.log', config: { message: 'PR #{{nodes.trig.pr.number}} opened' } },
                ],
                edges: [
                    { from: { node: 'trig', port: 'event' }, to: { node: 'log1', port: '__seq' } },
                ],
            },
        };

        const result = await executeWorkflow(wf, evt(), actions, noopLogger);
        expect(messages).toEqual(['PR #7 opened']);
        expect(result.steps.log1).toBeDefined();
    });

    it('matchesTrigger uses the graph trigger node when graph is set', () => {
        const wf: WorkflowDefinition = {
            name: 'g',
            // intentionally weak/empty legacy trigger; the graph wins
            trigger: { source: 'github', event: '' },
            graph: {
                nodes: [{ id: 'trig', type: 'trigger.github', config: { events: ['issues.opened'], repos: 'org/r' } }],
                edges: [],
            },
        };
        expect(matchesTrigger(wf, evt({ event: 'issues.opened', metadata: { repo: 'org/r' } }))).toBe(true);
        expect(matchesTrigger(wf, evt({ event: 'pull_request.opened' }))).toBe(false);
    });
});
