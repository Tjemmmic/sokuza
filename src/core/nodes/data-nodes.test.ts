import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { executeGraph } from './runtime.js';
import { NodeRegistry } from './registry.js';
import { registerBuiltinNodes } from './builtins.js';
import type { ActionHandler, EventPayload } from '../types.js';
import type { NodeGraph } from './types.js';

const noopLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function evt(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: '2026-05-04T12:00:00Z',
        payload: {},
        metadata: {},
        ...overrides,
    };
}

let registry: NodeRegistry;
let actions: Map<string, ActionHandler>;

beforeEach(() => {
    registry = new NodeRegistry();
    registerBuiltinNodes(registry);
    actions = new Map();
});

/** Build a single-data-node graph: trigger fed into one extractor. */
function dataGraph(nodeType: string, config: Record<string, unknown> = {}): NodeGraph {
    return {
        nodes: [
            { id: 'trig', type: 'trigger.github' },
            { id: 'x', type: nodeType, config },
        ],
        edges: [],
    };
}

describe('data.json-pluck', () => {
    it('reads a nested dot-path out of an object', async () => {
        const graph = dataGraph('data.json-pluck', { path: 'pull_request.head.ref' });
        graph.edges.push({ from: { node: 'trig', port: 'payload' }, to: { node: 'x', port: 'from' } });
        const event = evt({ payload: { pull_request: { head: { ref: 'feature-x' } } } });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.x.value).toBe('feature-x');
        expect(result.nodeOutputs.x.valueText).toBe('feature-x');
        expect(result.nodeOutputs.x.exists).toBe(true);
    });

    it('indexes into arrays with numeric segments', async () => {
        const graph = dataGraph('data.json-pluck', { path: 'commits.0.message' });
        graph.edges.push({ from: { node: 'trig', port: 'payload' }, to: { node: 'x', port: 'from' } });
        const event = evt({ payload: { commits: [{ message: 'first' }, { message: 'second' }] } });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.x.value).toBe('first');
    });

    it('reports exists=false on a missing path', async () => {
        const graph = dataGraph('data.json-pluck', { path: 'nope.nada' });
        graph.edges.push({ from: { node: 'trig', port: 'payload' }, to: { node: 'x', port: 'from' } });
        const result = await executeGraph(graph, evt({ payload: {} }), actions, registry, noopLogger);
        expect(result.nodeOutputs.x.value).toBeUndefined();
        expect(result.nodeOutputs.x.exists).toBe(false);
        expect(result.nodeOutputs.x.valueText).toBe('');
    });

    it('stringifies non-scalar values into valueText', async () => {
        const graph = dataGraph('data.json-pluck', { path: 'thing' });
        graph.edges.push({ from: { node: 'trig', port: 'payload' }, to: { node: 'x', port: 'from' } });
        const event = evt({ payload: { thing: { a: 1 } } });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.x.valueText).toBe('{"a":1}');
    });
});

describe('data.pr-fields', () => {
    it('extracts every documented scalar from a github PR payload', async () => {
        const graph = dataGraph('data.pr-fields');
        graph.edges.push({ from: { node: 'trig', port: 'pr' }, to: { node: 'x', port: 'pr' } });
        const event = evt({
            payload: {
                pull_request: {
                    number: 42,
                    title: 'Add foo',
                    body: 'Description',
                    state: 'open',
                    draft: false,
                    html_url: 'https://github.com/octo/r/pull/42',
                    head: { ref: 'feature-x', sha: 'abc123' },
                    base: { ref: 'main', sha: 'def456', repo: { full_name: 'octo/r' } },
                    user: { login: 'octocat' },
                    labels: [{ name: 'bug' }, { name: 'p1' }],
                },
            },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out).toMatchObject({
            number: 42,
            repo: 'octo/r',
            branch: 'feature-x',
            baseBranch: 'main',
            headSha: 'abc123',
            baseSha: 'def456',
            author: 'octocat',
            title: 'Add foo',
            body: 'Description',
            state: 'open',
            draft: false,
            url: 'https://github.com/octo/r/pull/42',
        });
        expect(out.labels).toEqual(['bug', 'p1']);
    });

    it('falls back to URL parsing for repo when base.repo missing', async () => {
        const graph = dataGraph('data.pr-fields');
        graph.edges.push({ from: { node: 'trig', port: 'pr' }, to: { node: 'x', port: 'pr' } });
        const event = evt({
            payload: { pull_request: { number: 1, html_url: 'https://github.com/foo/bar/pull/1' } },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.x.repo).toBe('foo/bar');
    });

    it('produces empty strings (not undefined) for missing scalar fields', async () => {
        const graph = dataGraph('data.pr-fields');
        graph.edges.push({ from: { node: 'trig', port: 'pr' }, to: { node: 'x', port: 'pr' } });
        const event = evt({ payload: { pull_request: { number: 1 } } });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.branch).toBe('');
        expect(out.author).toBe('');
        expect(out.title).toBe('');
        expect(out.labels).toEqual([]);
    });
});

describe('data.issue-fields', () => {
    it('extracts every documented scalar from a github issue payload', async () => {
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github', config: { events: ['issues.opened'] } },
                { id: 'x', type: 'data.issue-fields' },
            ],
            edges: [{ from: { node: 'trig', port: 'issue' }, to: { node: 'x', port: 'issue' } }],
        };
        const event = evt({
            event: 'issues.opened',
            payload: {
                issue: {
                    number: 7,
                    title: 'Bug',
                    body: 'It broke',
                    state: 'open',
                    html_url: 'https://github.com/octo/r/issues/7',
                    user: { login: 'reporter' },
                    labels: ['bug', { name: 'priority/high' }],
                },
            },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out).toMatchObject({
            number: 7,
            repo: 'octo/r',
            author: 'reporter',
            title: 'Bug',
            body: 'It broke',
            state: 'open',
            url: 'https://github.com/octo/r/issues/7',
        });
        expect(out.labels).toEqual(['bug', 'priority/high']);
    });
});

describe('data.review-fields', () => {
    it('counts blocking vs non-blocking issues by priority', async () => {
        const graph = dataGraph('data.review-fields');
        graph.edges.push({ from: { node: 'trig', port: 'event' }, to: { node: 'x', port: '__seq' } });
        // Configure the review inline since there's no review-emitting trigger here.
        graph.nodes[1].config = {
            review: {
                summary: 'LGTM with nits',
                mergeReady: true,
                issues: [
                    { priority: 'P0', title: 'Crash' },
                    { priority: 'P1', title: 'Race' },
                    { priority: 'P2', title: 'Style nit' },
                    { priority: 'P3', title: 'Doc typo' },
                ],
            },
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.summary).toBe('LGTM with nits');
        expect(out.mergeReady).toBe(true);
        expect(out.totalCount).toBe(4);
        expect(out.blockingCount).toBe(2);
        expect(out.nonBlockingCount).toBe(2);
    });

    it('handles an empty/absent review gracefully', async () => {
        const graph = dataGraph('data.review-fields');
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.summary).toBe('');
        expect(out.mergeReady).toBe(false);
        expect(out.totalCount).toBe(0);
        expect(out.blockingCount).toBe(0);
    });
});

describe('data.commits-fields', () => {
    it('returns latest commit, total count, and full lists', async () => {
        const graph = dataGraph('data.commits-fields');
        graph.nodes[1].config = {
            commits: [
                { id: 'sha1', message: 'first', author: { username: 'a' } },
                { id: 'sha2', message: 'second', author: { username: 'b' } },
                { id: 'sha3', message: 'third', author: { name: 'Third Author' } },
            ],
        };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.count).toBe(3);
        expect(out.latestSha).toBe('sha3');
        expect(out.latestMessage).toBe('third');
        expect(out.latestAuthor).toBe('Third Author');
        expect(out.messages).toEqual(['first', 'second', 'third']);
        expect(out.shas).toEqual(['sha1', 'sha2', 'sha3']);
    });

    it('returns zero/empty defaults for an empty commit list', async () => {
        const graph = dataGraph('data.commits-fields');
        graph.nodes[1].config = { commits: [] };
        const result = await executeGraph(graph, evt(), actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.count).toBe(0);
        expect(out.latestSha).toBe('');
        expect(out.messages).toEqual([]);
    });
});

describe('data.event-fields', () => {
    it('splits the canonical event envelope', async () => {
        const graph = dataGraph('data.event-fields');
        graph.edges.push({ from: { node: 'trig', port: 'event' }, to: { node: 'x', port: 'event' } });
        const event = evt({
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T12:00:00Z',
            payload: { pull_request: { number: 1 } },
            metadata: { repo: 'org/r' },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        const out = result.nodeOutputs.x;
        expect(out.source).toBe('github');
        expect(out.eventName).toBe('pull_request.opened');
        expect(out.timestamp).toBe('2026-05-04T12:00:00Z');
        expect(out.payload).toEqual({ pull_request: { number: 1 } });
        expect(out.metadata).toEqual({ repo: 'org/r' });
    });
});

describe('data.template', () => {
    it('returns the interpolated template body', async () => {
        // The runtime interpolates {{nodes.x.y}} during config resolution,
        // so by the time execute() runs, inputs.template is already filled in.
        const graph: NodeGraph = {
            nodes: [
                { id: 'trig', type: 'trigger.github' },
                { id: 'fields', type: 'data.pr-fields' },
                { id: 'tpl', type: 'data.template', config: {
                    template: 'PR #{{nodes.fields.number}} by {{nodes.fields.author}}',
                } },
            ],
            edges: [
                { from: { node: 'trig', port: 'pr' }, to: { node: 'fields', port: 'pr' } },
                { from: { node: 'fields', port: 'number' }, to: { node: 'tpl', port: '__seq' } },
            ],
        };
        const event = evt({
            payload: { pull_request: { number: 99, user: { login: 'octocat' } } },
        });
        const result = await executeGraph(graph, event, actions, registry, noopLogger);
        expect(result.nodeOutputs.tpl.text).toBe('PR #99 by octocat');
    });
});

describe('builtin port-type contract', () => {
    it('every wire-able input carries an explicit type (no silent any-fallback)', () => {
        const def = registry.get('ai.review');
        if (!def) throw new Error('ai.review not registered');
        for (const port of def.ports) {
            if (port.role === 'input' && port.wire === true) {
                expect(port.type, `port ${port.name} on ai.review`).toBeDefined();
            }
        }
    });

    it('clone-repo and create-pr re-emit construction-time fields', () => {
        const clone = registry.get('github.clone-repo');
        const createPr = registry.get('github.create-pr');
        const cloneOuts = clone!.ports.filter((p) => p.role === 'output').map((p) => p.name);
        const prOuts = createPr!.ports.filter((p) => p.role === 'output').map((p) => p.name);
        expect(cloneOuts).toContain('repo');
        expect(cloneOuts).toContain('branch');
        expect(prOuts).toContain('repo');
        expect(prOuts).toContain('branch');
    });

    it('label nodes expose typed success outputs', () => {
        const add = registry.get('github.add-label');
        const remove = registry.get('github.remove-label');
        expect(add!.ports.find((p) => p.name === 'success')?.type).toBe('boolean');
        expect(add!.ports.find((p) => p.name === 'appliedLabels')?.type).toBe('json');
        expect(remove!.ports.find((p) => p.name === 'success')?.type).toBe('boolean');
        expect(remove!.ports.find((p) => p.name === 'removedLabel')?.type).toBe('string');
    });

    it('slack-send-message emits timestamp (matches slack.react input)', () => {
        const send = registry.get('slack.send-message');
        const react = registry.get('slack.react');
        const sendOut = send!.ports.find((p) => p.role === 'output' && p.name === 'timestamp');
        const reactIn = react!.ports.find((p) => p.role === 'input' && p.name === 'timestamp');
        expect(sendOut?.type).toBe('string');
        expect(reactIn?.type).toBe('string');
    });
});
