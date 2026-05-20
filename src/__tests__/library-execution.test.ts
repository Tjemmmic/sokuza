import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Logger } from 'pino';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { executeGraph, toposortLayers } from '../core/nodes/runtime.js';
import { getNodeRegistry, resetNodeRegistry } from '../core/nodes/registry.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';
import type { ActionHandler, EventPayload } from '../core/types.js';
import type { NodeGraph, GraphNode } from '../core/nodes/types.js';

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

    // Per-action mocks whose return shape matches each action's REAL
    // return value. The previous kitchen-sink mock returned every
    // possible key at once — templates that referenced an undeclared
    // port still passed because the mock had it, masking the kind of
    // node-port/action-return mismatch that broke ai-pr-review in
    // production. Keeping each mock honest means a template wired
    // against a phantom port (e.g. `{{nodes.review.totally_fake}}`)
    // surfaces as an empty interpolation in this test, not just at
    // runtime.
    //
    // Source of truth for each shape:
    //   - ai-review.ts:       lines 349-382 (id/review/...; markdown/structured/summary/issues/mergeReady/runId)
    //   - ai-agent.ts:        lines 60-87  (output/transcript/review/model/provider + parsedJson spread)
    //   - address-review.ts:  lines 158-170 (halted) + 352-365 (record + iterationsRun/finalState)
    //   - github actions:     each action's return statement
    function buildActionRegistry(): Map<string, ActionHandler> {
        const actions = new Map<string, ActionHandler>();

        // AI actions
        actions.set('ai-review', async () => ({
            id: 'r-1', review: 'mocked review',
            model: 'sonnet', provider: 'claude-code',
            usage: { input_tokens: 100, output_tokens: 20 },
            parsed: { summary: 'ok', issues: [], decision: 'APPROVE', justification: 'fine' },
            truncation: undefined,
            // Node-contract ports (ai.review):
            markdown: 'mocked review',
            structured: { summary: 'ok', issues: [], decision: 'APPROVE', justification: 'fine' },
            summary: 'ok', issues: [], mergeReady: true,
            runId: 'r-1',
        }));
        actions.set('ai-agent', async () => ({
            output: 'mocked agent output', review: 'mocked agent output',
            transcript: undefined,
            model: 'sonnet', provider: 'claude-code',
        }));
        actions.set('address-review', async () => ({
            id: 'ar-1', action: 'address-review', createdAt: '2026-05-04T00:00:00Z',
            durationMs: 10, iteration: 1, iterationCap: 5,
            sourceReviewRunId: 'r-1', mode: 'suggest',
            provider: 'claude-code', model: 'sonnet',
            issues: { addressed: [], rejected: [], deferred: [] },
            workdir: { path: '/tmp/wd', reused: false },
            issueFingerprint: 'abc',
            // Node-contract ports (ai.address-review):
            iterationsRun: 1, finalState: 'completed',
        }));

        // GitHub actions — match each handler's real return
        actions.set('github-fetch-diff', async () => ({
            diff: '--- a\n+++ b\n', files: [], fileCount: 0,
            owner: 'org', repo: 'repo', pr_number: 42,
            diff_source: 'bulk', incomplete_files: [], truncation: undefined,
        }));
        actions.set('github-comment', async () => ({
            commentId: 'c-1', url: 'https://github.com/org/repo/issues/42#c-1',
            comment_id: 'c-1', html_url: 'https://github.com/org/repo/issues/42#c-1',
        }));
        actions.set('github-clone-repo', async () => ({
            path: '/tmp/wd', repo: 'org/repo', branch: 'main', ref: 'main', sha: 'aaaa1111',
        }));
        actions.set('github-create-pr', async () => ({
            has_changes: true, pr_number: 100, number: 100,
            pr_url: 'https://github.com/org/repo/pull/100',
            url: 'https://github.com/org/repo/pull/100',
            branch: 'feature/x', repo: 'org/repo',
        }));
        actions.set('github-create-review', async () => ({
            event: 'COMMENT', html_url: 'https://github.com/org/repo/pull/42',
            review_id: 'rv-1', inline_comments: 0, fallback_used: false,
        }));
        actions.set('github-fetch-reviews', async () => ({
            reviews: [], comments: [], summary: '', owner: 'org', repo: 'repo', prNumber: 42,
        }));
        actions.set('github-fetch-pr', async () => ({
            pr: { number: 42, title: 'mock PR', state: 'open' },
            number: 42, repo: 'org/repo', state: 'open',
        }));
        actions.set('github-fetch-issue', async () => ({
            issue: { number: 7, title: 'mock issue', state: 'open' },
            number: 7, repo: 'org/repo', state: 'open',
        }));
        actions.set('github-merge-pr', async () => ({
            merged: true, message: 'merged', sha: 'aaaa1111',
        }));
        actions.set('github-update-pr', async () => ({
            number: 42, state: 'open', title: 'mock', body: 'body', base: 'main',
        }));
        actions.set('github-wait-for-checks', async () => ({
            success: true, failedChecks: [], totalChecks: 0,
            state: 'success', sha: 'aaaa1111', timedOut: false,
        }));
        actions.set('github-add-label', async () => ({
            success: true, appliedLabels: ['bug'],
        }));
        actions.set('github-remove-label', async () => ({
            success: true, removedLabel: 'wip',
        }));
        actions.set('git-commit-and-push', async () => ({
            pushed: true, hasChanges: true, sha: 'aaaa1111', branch: 'feature/x',
        }));
        actions.set('shell-exec', async () => ({
            stdout: 'mock stdout\n', stderr: '', exitCode: 0,
            success: true, timedOut: false, truncated: false, durationMs: 12,
        }));

        // Slack actions
        actions.set('slack-send-message', async () => ({
            ok: true, timestamp: '1700000000.000100', channel: 'C123',
        }));
        actions.set('slack-react', async () => ({
            ok: true,
        }));

        // Generic catch-all for log / webhook / utility nodes — these
        // are widely-used and just need to not crash; their return
        // shape is captured in the few keys downstream templates touch.
        const generic: ActionHandler = async () => ({
            logged: true, status: 200,
        });
        actions.set('log', generic);
        actions.set('webhook', generic);

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

    // For every node whose config or condition references {{nodes.X.Y}},
    // toposort must place that node strictly after X. The previous
    // execution test only checked that the runtime didn't throw — but
    // the generic mock returned hardcoded outputs regardless of input,
    // so a consumer running before its producer (with the producer's
    // {{...}} ref interpolating to '') would still "succeed". This
    // assertion catches the missing-edge bug class regardless of mock
    // behaviour, by inspecting the actual layer ordering.
    it.each(templates)('$name resolves every config/condition node-ref before the consumer runs', (tmpl) => {
        const layers = toposortLayers(tmpl.graph);
        const layerOf = new Map<string, number>();
        layers.forEach((layer, i) => layer.forEach((n) => layerOf.set(n.id, i)));

        const refsByConsumer = collectRefsByConsumer(tmpl.graph.nodes);
        const violations: string[] = [];
        for (const [consumerId, refs] of refsByConsumer) {
            const consumerLayer = layerOf.get(consumerId);
            if (consumerLayer === undefined) continue; // unreachable / skipped node
            for (const ref of refs) {
                if (ref === consumerId) continue;
                const refLayer = layerOf.get(ref);
                if (refLayer === undefined) continue; // ref points at a non-existent node
                if (refLayer >= consumerLayer) {
                    violations.push(
                        `node "${consumerId}" references {{nodes.${ref}.…}} but ${ref} is in layer ${refLayer} >= ${consumerLayer}`,
                    );
                }
            }
        }
        expect(violations, `Template ${tmpl.name} has out-of-order config refs:\n  ${violations.join('\n  ')}`).toEqual([]);
    });
});

/** For each node, collect every other node id it references via
 *  `{{nodes.<id>.…}}` or `{{steps.<id>.…}}` in its config or condition.
 *  Mirrors collectNodeRefs in runtime.ts but scoped to a per-consumer
 *  map so the test can pin who depends on whom. */
function collectRefsByConsumer(nodes: GraphNode[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const node of nodes) {
        const refs = new Set<string>();
        scan(node.condition, refs);
        if (node.config) for (const v of Object.values(node.config)) scan(v, refs);
        if (refs.size > 0) out.set(node.id, refs);
    }
    return out;
}

function scan(value: unknown, out: Set<string>): void {
    if (typeof value === 'string') {
        for (const m of value.matchAll(/\{\{\s*(?:nodes|steps)\.([A-Za-z0-9_-]+)\b/g)) out.add(m[1]);
    } else if (Array.isArray(value)) {
        for (const v of value) scan(v, out);
    } else if (value && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) scan(v, out);
    }
}
