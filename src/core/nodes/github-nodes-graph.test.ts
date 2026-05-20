import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { executeGraph } from './runtime.js';
import { getNodeRegistry, resetNodeRegistry } from './registry.js';
import { registerBuiltinNodes } from './builtins.js';
import type { ActionHandler, EventPayload } from '../types.js';
import type { NodeGraph } from './types.js';

// The GitHub-mutating built-in nodes (merge-pr, update-pr, wait-for-checks)
// have thorough action-level unit tests, but those bypass the actionNode()
// wrapper that the graph runtime puts in front of every handler. The wrapper
// (a) assembles params from resolved ports, (b) drops undefined/'' inputs,
// and (c) wraps the return via wrapResult. These tests pin that composed
// path for the highest-risk (state-mutating) nodes, so a regression in the
// wrapper can't silently drop a needed param or reshape outputs.

const noopLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function evt(): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: new Date().toISOString(),
        payload: { pull_request: { number: 7 } },
        metadata: { repo: 'org/r' },
    };
}

let actions: Map<string, ActionHandler>;

beforeEach(() => {
    resetNodeRegistry();
    registerBuiltinNodes(getNodeRegistry());
    actions = new Map();
});

/** Sequence a single action node after the trigger and run the graph. */
async function runNode(type: string, config: Record<string, unknown>) {
    const graph: NodeGraph = {
        nodes: [
            { id: 'trig', type: 'trigger.github', config: { events: ['pull_request.opened'] } },
            { id: 'n', type, config },
        ],
        edges: [{ from: { node: 'trig', port: 'event' }, to: { node: 'n', port: '__seq' } }],
    };
    const result = await executeGraph(graph, evt(), actions, getNodeRegistry(), noopLogger);
    return result.nodeOutputs.n;
}

describe('GitHub-mutating nodes through the actionNode wrapper', () => {
    it('github.merge-pr: assembles params and wraps the result', async () => {
        let received: Record<string, unknown> | undefined;
        actions.set('github-merge-pr', async (params) => {
            received = params;
            return { merged: true, mergeSha: 'abc123', message: 'Pull Request successfully merged' };
        });

        const out = await runNode('github.merge-pr', {
            pr_number: 7, repo: 'org/r', method: 'squash',
            commit_title: '', // empty optional must be dropped, not forwarded
        });

        expect(received).toEqual({ pr_number: 7, repo: 'org/r', method: 'squash' });
        expect(received).not.toHaveProperty('commit_title');
        // wrapResult: handler keys become ports + synthetic `result`.
        expect(out).toMatchObject({ merged: true, mergeSha: 'abc123', message: 'Pull Request successfully merged' });
        expect(out.result).toEqual({ merged: true, mergeSha: 'abc123', message: 'Pull Request successfully merged' });
    });

    it('github.update-pr: drops the empty-string state ("no change") but keeps real fields', async () => {
        let received: Record<string, unknown> | undefined;
        actions.set('github-update-pr', async (params) => {
            received = params;
            return { url: 'https://github.com/org/r/pull/7', newState: 'open', number: 7 };
        });

        const out = await runNode('github.update-pr', {
            pr_number: 7, repo: 'org/r', title: 'New title',
            state: '',   // the "(no change)" option — must not reach the handler
            body: '',    // unset optional — must not reach the handler
        });

        expect(received).toEqual({ pr_number: 7, repo: 'org/r', title: 'New title' });
        expect(received).not.toHaveProperty('state');
        expect(received).not.toHaveProperty('body');
        expect(out).toMatchObject({ url: 'https://github.com/org/r/pull/7', newState: 'open', number: 7 });
    });

    it('github.wait-for-checks: forwards config + interpolated params and wraps output', async () => {
        let received: Record<string, unknown> | undefined;
        actions.set('github-wait-for-checks', async (params) => {
            received = params;
            return { success: true, failedChecks: [], totalChecks: 3, sha: 'deadbeef', timedOut: false };
        });

        const out = await runNode('github.wait-for-checks', { sha: 'deadbeef', repo: 'org/r' });

        // Ports with a `default` flow through the wrapper even when unset —
        // the handler sees the configured values plus the port defaults.
        expect(received).toEqual({ sha: 'deadbeef', repo: 'org/r', timeout: 600, interval: 15 });
        expect(out).toMatchObject({ success: true, totalChecks: 3, sha: 'deadbeef', timedOut: false });
        expect(out.failedChecks).toEqual([]);
        expect(out.result).toEqual({ success: true, failedChecks: [], totalChecks: 3, sha: 'deadbeef', timedOut: false });
    });
});
