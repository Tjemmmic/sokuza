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

    // Real-handler integration: graph templates wire `trigger.repo`
    // (= `event.metadata.repo` = "owner/name") into action ports whose
    // handlers historically read `params.repo` as the bare repo name.
    // Every passing test in this suite used a mock action handler, so
    // the resulting `/repos/<owner>/owner/name/...` URL never surfaced
    // until it 404'd in production. This test exercises the full path
    // — graph → trigger synthesis → real handler → fetch URL — and
    // asserts the URL has exactly two path segments after `/repos/`.
    it('graph template + real github.comment handler produces a well-formed /repos/owner/name URL', async () => {
        let capturedUrl = '';
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: unknown) => {
            capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
            return new Response(JSON.stringify({ id: 1, html_url: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;

        try {
            const actions = new Map<string, ActionHandler>();
            const { githubCommentAction } = await import('../../integrations/github/actions/comment.js');
            actions.set('github-comment', githubCommentAction);

            const wf: WorkflowDefinition = {
                name: 'g',
                trigger: { source: 'github', event: 'pull_request.opened' },
                graph: {
                    nodes: [
                        { id: 'trig', type: 'trigger.github', config: { events: ['pull_request.opened'] } },
                        // Real-world template pattern: wire trigger.repo
                        // (owner/name) and trigger.prNumber into the
                        // comment node's repo / pr_number ports.
                        { id: 'post', type: 'github.comment', config: { body: 'hello' } },
                    ],
                    edges: [
                        { from: { node: 'trig', port: 'repo' }, to: { node: 'post', port: 'repo' } },
                        { from: { node: 'trig', port: 'prNumber' }, to: { node: 'post', port: 'pr_number' } },
                    ],
                },
            };

            await executeWorkflow(
                wf,
                evt({ metadata: { repo: 'octo/r', prNumber: 42 } }),
                actions,
                noopLogger,
                { github: { token: 'gh_test' } },
            );

            // Critical assertion: the URL must be `/repos/octo/r/...`,
            // NOT `/repos/octo/octo/r/...` (which is what the
            // unmigrated handlers produced before resolveRepoTarget).
            // The trigger node synthesizes prNumber from the event
            // payload's `pull_request.number`, so any positive integer
            // there is fine — the bug we're guarding against is in
            // the repo-segment, not the number.
            expect(capturedUrl).toMatch(/^https:\/\/api\.github\.com\/repos\/octo\/r\/issues\/\d+\/comments$/);
        } finally {
            globalThis.fetch = origFetch;
        }
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
