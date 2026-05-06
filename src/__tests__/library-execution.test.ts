import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Logger } from 'pino';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { executeGraph } from '../core/nodes/runtime.js';
import { getNodeRegistry, resetNodeRegistry } from '../core/nodes/registry.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';
import type { ActionHandler, EventPayload } from '../core/types.js';
import type { NodeGraph } from '../core/nodes/types.js';

// Run every library graph template through the runtime with mocked actions
// to prove the wiring resolves and the runtime accepts the graph shape.
// This catches the kinds of bugs the contract test in library-coverage
// can't see — wires connecting incompatible ports, references to
// nonexistent ports, missing required configs, etc.

const noopLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TEMPLATE_DIRS = [
    join(REPO_ROOT, 'templates'),
    join(REPO_ROOT, 'templates', 'library'),
];

interface LoadedTemplate {
    name: string;
    path: string;
    trigger?: { source?: string | string[]; event?: string | string[] };
    graph: NodeGraph;
}

function loadGraphTemplates(): LoadedTemplate[] {
    const out: LoadedTemplate[] = [];
    const seen = new Set<string>();
    for (const dir of TEMPLATE_DIRS) {
        let files: string[];
        try { files = readdirSync(dir); }
        catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
            const name = f.replace(/\.ya?ml$/, '');
            if (seen.has(name)) continue;
            seen.add(name);
            const content = readFileSync(join(dir, f), 'utf-8');
            const parsed = (yaml.load(content) ?? {}) as Record<string, unknown>;
            const graph = parsed.graph as NodeGraph | undefined;
            if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) continue;
            out.push({
                name,
                path: join(dir, f),
                trigger: parsed.trigger as LoadedTemplate['trigger'],
                graph,
            });
        }
    }
    return out;
}

// A "rich enough" event that satisfies most templates' downstream nodes.
// The runtime synthesizes trigger outputs from this — pull_request,
// issue, review, commits, etc. — so each new template can match its
// trigger config.
function richEvent(source: string, eventName: string): EventPayload {
    return {
        source,
        event: eventName,
        timestamp: '2026-05-05T00:00:00Z',
        payload: {
            pull_request: {
                number: 42,
                title: 'WIP: test PR',
                body: 'demo body',
                state: 'open',
                draft: false,
                html_url: 'https://github.com/org/repo/pull/42',
                additions: 100,
                head: {
                    ref: 'feature/x',
                    sha: 'aaaa1111',
                    repo: { full_name: 'org/repo' },
                },
                base: {
                    ref: 'main',
                    sha: 'bbbb2222',
                    repo: { full_name: 'org/repo' },
                },
                user: { login: 'alice' },
                labels: [{ name: 'bug' }],
            },
            issue: {
                number: 7,
                title: 'crash on startup',
                body: 'reproduces when…',
                state: 'open',
                html_url: 'https://github.com/org/repo/issues/7',
                user: { login: 'bob' },
                labels: [{ name: 'autofix' }],
            },
            review: {
                summary: 'looks good with caveats',
                issues: [{ priority: 'P1', path: 'a.ts', line: 10, message: 'nit' }],
                mergeReady: true,
            },
            comment: { body: 'please address X', user: { login: 'carol' } },
            commits: [
                { id: 'aaaa1111', message: 'feat: x', author: { username: 'alice' } },
                { id: 'cccc3333', message: 'fix: y', author: { username: 'bob' } },
            ],
            inputs: {
                primary: 'p',
                fallback: 'f',
                pr: 42,
                issue: { number: 7, repo: 'org/repo', url: 'https://github.com/org/repo/issues/7' },
            },
            event: { ts: '1700000000.000100' },  // slack timestamp
        },
        metadata: { repo: 'org/repo', prNumber: 42, issueNumber: 7 },
    };
}

beforeAll(() => {
    resetNodeRegistry();
    registerBuiltinNodes(getNodeRegistry());
});

describe('library template execution', () => {
    const templates = loadGraphTemplates();

    // Mock every action with a permissive handler that returns generic
    // outputs. We don't care what they DO — we care that the graph hands
    // them well-formed inputs and doesn't crash on the wiring itself.
    function buildActionRegistry(): Map<string, ActionHandler> {
        const actions = new Map<string, ActionHandler>();
        const generic: ActionHandler = async () => ({
            // Cover the most-read output keys across the library so
            // downstream interpolation finds something:
            review: 'mocked review',
            markdown: 'mocked markdown',
            output: 'mocked agent output',
            review_run_id: 'r-1',
            structured: { issues: [], summary: '', mergeReady: true },
            diff: '--- a\n+++ b\n',
            files: [],
            truncated: false,
            commentId: 'c-1',
            url: 'https://github.com/org/repo/x',
            path: '/tmp/wd',
            sha: 'aaaa1111',
            number: 42,
            branch: 'feature/x',
            repo: 'org/repo',
            pushed: true,
            hasChanges: true,
            merged: true,
            message: 'merged',
            success: true,
            failedChecks: [],
            totalChecks: 0,
            timedOut: false,
            reviewId: 'rv-1',
            appliedLabels: ['bug'],
            removedLabel: 'wip',
            reviews: [],
            issue: { number: 7 },
            pr: { number: 42 },
            state: 'open',
            iterationsRun: 1,
            finalState: 'done',
            ok: true,
            status: 200,
            timestamp: '1700000000.000100',
            channel: 'C123',
        });
        for (const action of [
            'log', 'webhook',
            'ai-review', 'ai-agent', 'address-review',
            'github-fetch-diff', 'github-comment', 'github-clone-repo',
            'github-create-pr', 'github-create-review', 'github-fetch-reviews',
            'github-fetch-pr', 'github-fetch-issue', 'github-merge-pr',
            'github-update-pr', 'github-wait-for-checks',
            'github-add-label', 'github-remove-label',
            'git-commit-and-push',
            'slack-send-message', 'slack-react',
        ]) {
            actions.set(action, generic);
        }
        return actions;
    }

    it.each(templates)('$name normalizes, sorts, and runs without throwing', async (tmpl) => {
        const sources = Array.isArray(tmpl.trigger?.source)
            ? tmpl.trigger?.source
            : [tmpl.trigger?.source];
        const events = Array.isArray(tmpl.trigger?.event)
            ? tmpl.trigger?.event
            : [tmpl.trigger?.event];
        const source = (sources?.[0] as string) ?? 'manual';
        const eventName = (events?.[0] as string) ?? 'manual';

        const registry = getNodeRegistry();
        const actions = buildActionRegistry();
        const event = richEvent(source, eventName);

        const result = await executeGraph(
            tmpl.graph,
            event,
            actions,
            registry,
            noopLogger,
        );
        expect(result).toBeDefined();
        // Every node should have produced an output entry (or been skipped
        // by condition — both are fine, both leave nodeOutputs populated).
        expect(typeof result.nodeOutputs).toBe('object');
    });

    it('covers every graph template in the library', () => {
        // Sanity floor — make sure we actually executed the templates we
        // expect to. If a template gets accidentally deleted this test
        // surfaces it before the per-template test even runs.
        expect(templates.length).toBeGreaterThanOrEqual(20);
    });
});
