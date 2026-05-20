import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiAgentAction } from './ai-agent.js';
import pino from 'pino';

vi.mock('../core/ai-providers.js', () => ({
    runAgentWithFallback: vi.fn(),
}));

import { runAgentWithFallback } from '../core/ai-providers.js';
import type { AiReviewRunRecord } from '../core/run-store.js';

const mockedRunAgent = vi.mocked(runAgentWithFallback);

const logger = pino({ level: 'silent' });

// Isolate run-record writes so the parse_as_review tests never touch
// the real ~/.sokuza/runs/ directory.
const RUNS_ENV = 'SOKUZA_RUNS_DIR';
const previousRunsDir = process.env[RUNS_ENV];
let runsRoot = '';

function makeContext(overrides: Partial<import('../core/types.js').ActionContext> = {}) {
    return {
        event: {
            source: 'github',
            event: 'push',
            action: 'opened',
            timestamp: '2025-01-01T00:00:00Z',
            payload: {},
            metadata: {},
        },
        results: {},
        steps: {},
        integrationConfigs: {},
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        ...overrides,
    } as import('../core/types.js').ActionContext;
}

const STRUCTURED_REVIEW_OUTPUT = JSON.stringify({
    summary: 'One blocking lock contention bug; otherwise solid.',
    issues: [
        {
            priority: 'P1',
            title: 'Race condition in queue dedup',
            file: 'src/core/queue.ts',
            lineStart: 142,
            lineEnd: 158,
            problem: 'Two workers can read the dedup key concurrently.',
            fix: 'Hold the lock across read+write.',
        },
    ],
    decision: 'CHANGES_REQUESTED',
    justification: 'P1 race condition must be addressed before merge.',
});

describe('aiAgentAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws when workdir is missing', async () => {
        const ctx = makeContext();
        await expect(
            aiAgentAction({ prompt: 'do something' }, ctx),
        ).rejects.toThrow('ai-agent: workdir is required');
    });

    it('throws when prompt is missing', async () => {
        const ctx = makeContext();
        await expect(
            aiAgentAction({ workdir: '/tmp/repo' }, ctx),
        ).rejects.toThrow('ai-agent: prompt is required');
    });

    it('spreads parsed JSON fields into result alongside the declared output ports', async () => {
        mockedRunAgent.mockResolvedValue({
            output: '{"summary":"LGTM","approved":true}',
            parsedJson: { summary: 'LGTM', approved: true },
            model: 'sonnet',
            provider: 'claude-code',
        });

        const ctx = makeContext();
        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review this', output_format: 'json' },
            ctx,
        ) as Record<string, unknown>;

        // Parsed JSON fields are spread for convenience…
        expect(result.summary).toBe('LGTM');
        expect(result.approved).toBe(true);
        // …and the node-contract ports are populated:
        //   - `output` (declared as "Agent Output" on ai.agent)
        //   - `transcript` (declared as "Transcript")
        expect(result.output).toBe('{"summary":"LGTM","approved":true}');
        expect(result.transcript).toEqual({ summary: 'LGTM', approved: true });
        // `review` stays for back-compat with templates wired before the
        // contract was tightened.
        expect(result.review).toBe('{"summary":"LGTM","approved":true}');
        expect(result.model).toBe('sonnet');
        expect(result.provider).toBe('claude-code');
    });

    it('returns { output, review, model, provider, transcript=undefined } when there is no parsedJson', async () => {
        mockedRunAgent.mockResolvedValue({
            output: 'The code looks good overall.',
            parsedJson: undefined,
            model: 'opus',
            provider: 'claude-code',
        });

        const ctx = makeContext();
        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review this' },
            ctx,
        );

        expect(result).toEqual({
            // Both `output` (node contract) and `review` (legacy) carry
            // the same text so old templates and the editor's wiring
            // hints agree on what's available.
            output: 'The code looks good overall.',
            review: 'The code looks good overall.',
            model: 'opus',
            provider: 'claude-code',
            // Text-mode → no structured transcript. Explicit undefined
            // keeps the key on the result object so consumers can rely
            // on `'transcript' in result` (the runtime checks this when
            // resolving wires).
            transcript: undefined,
        });
    });

    it('declares review-shape output keys as undefined when parse_as_review is omitted', async () => {
        // The node declares `runId` / `markdown` / `structured` / `summary`
        // / `issues` / `mergeReady` as output ports unconditionally — so a
        // user can wire them at design time. At runtime the keys must
        // still be present on the return value (as undefined) when the
        // flag is off, otherwise the graph runtime's "missing key" path
        // silently shadows wires with config defaults. Pinned by
        // ai-nodes-output-contract.test.ts.
        mockedRunAgent.mockResolvedValue({
            output: 'Some agent output.',
            parsedJson: undefined,
            model: 'opus',
            provider: 'claude-code',
        });

        const ctx = makeContext();
        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review this' },
            ctx,
        ) as Record<string, unknown>;

        for (const port of ['runId', 'markdown', 'structured', 'summary', 'issues', 'mergeReady']) {
            expect(port in result, `${port} key must be present`).toBe(true);
            expect(result[port], `${port} must be undefined when parse_as_review is off`).toBeUndefined();
        }
        // And the legacy keys still carry their real values.
        expect(result.output).toBe('Some agent output.');
        expect(result.provider).toBe('claude-code');
    });
});

// ─── parse_as_review path ───────────────────────────────────────────────────
// This is the loop-compatibility surface: ai-agent must produce a runId,
// rendered markdown, and a recorded run that `address-review` can later
// load via getAiReviewRunById. Without these tests, a refactor that
// silently drops the record write would only surface as a confusing
// "review run not found" error inside the auto-fix loop.

describe('aiAgentAction — parse_as_review', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        runsRoot = await mkdtemp(join(tmpdir(), 'sokuza-agent-runs-'));
        process.env[RUNS_ENV] = runsRoot;
    });

    afterEach(async () => {
        if (runsRoot) await rm(runsRoot, { recursive: true, force: true });
    });

    afterAll(() => {
        if (previousRunsDir === undefined) delete process.env[RUNS_ENV];
        else process.env[RUNS_ENV] = previousRunsDir;
    });

    it('parses structured review output, emits runId + markdown + parsed fields', async () => {
        mockedRunAgent.mockResolvedValue({
            output: STRUCTURED_REVIEW_OUTPUT,
            parsedJson: undefined,
            model: 'glm-4.6',
            provider: 'opencode',
        });

        const ctx = makeContext({
            event: {
                source: 'github',
                event: 'pull_request.opened',
                timestamp: '2026-05-20T00:00:00Z',
                payload: { pull_request: { number: 42, head: { ref: 'feature/x' } } },
                metadata: { repo: 'org/repo', prNumber: 42 },
            },
        });

        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review this', parse_as_review: true },
            ctx,
        ) as Record<string, unknown>;

        // Same-named outputs as ai.review so downstream nodes can wire
        // identically: github.create-review's body interpolates
        // {{nodes.X.markdown}} and {{nodes.X.runId}}.
        expect(typeof result.runId).toBe('string');
        expect((result.runId as string).length).toBeGreaterThan(0);
        expect(result.id).toBe(result.runId);
        expect(typeof result.markdown).toBe('string');
        expect(result.markdown).toMatch(/Race condition in queue dedup/);
        expect(result.summary).toMatch(/lock contention bug/);
        expect(result.mergeReady).toBe(false); // CHANGES_REQUESTED → not merge-ready
        expect(Array.isArray(result.issues)).toBe(true);
        expect((result.issues as unknown[]).length).toBe(1);
        // Legacy outputs preserved alongside the new ones.
        expect(result.output).toBe(STRUCTURED_REVIEW_OUTPUT);
        expect(result.review).toBe(STRUCTURED_REVIEW_OUTPUT);
        expect(result.model).toBe('glm-4.6');
    });

    it('writes a run record under ai-review/ that address-review can load', async () => {
        // Pin the on-disk contract: the auto-fix loop's getAiReviewRunById
        // reads from <runs>/ai-review/<date>/<id>.json, and reads
        // `output.parseSucceeded` + `output.issues` to drive its work.
        // If the agentic record isn't written here, the loop fails with
        // a confusing "review run not found" error.
        mockedRunAgent.mockResolvedValue({
            output: STRUCTURED_REVIEW_OUTPUT,
            parsedJson: undefined,
            model: 'glm-4.6',
            provider: 'opencode',
        });

        const ctx = makeContext();
        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review', parse_as_review: true },
            ctx,
        ) as Record<string, unknown>;

        const reviewDir = join(runsRoot, 'ai-review');
        const dateDirs = await readdir(reviewDir);
        expect(dateDirs.length).toBe(1);
        const files = await readdir(join(reviewDir, dateDirs[0]));
        expect(files).toContain(`${result.runId}.json`);

        const record = JSON.parse(
            await readFile(join(reviewDir, dateDirs[0], `${result.runId}.json`), 'utf-8'),
        ) as AiReviewRunRecord;

        // Recorded under the ai-review action key so the loop's existing
        // lookup path (getAiReviewRunById) finds it without changes.
        expect(record.action).toBe('ai-review');
        // strategy='agentic' distinguishes it in the dashboard from a
        // diff-truncate review without breaking the shared schema.
        expect(record.strategy).toBe('agentic');
        expect(record.output.parseSucceeded).toBe(true);
        expect(record.output.issues?.length).toBe(1);
        expect(record.output.issues?.[0].priority).toBe('P1');
        expect(record.output.decision).toBe('CHANGES_REQUESTED');
        // Truncation block is zeroed (agent reads files directly).
        expect(record.truncation.triggered).toBe(false);
        expect(record.truncation.originalChars).toBe(0);
        expect(record.input.diffBytes).toBe(0);
        // promptChars is the agentic analog of diffBytes: it must
        // actually land in the record. A previous iteration of the
        // helper accepted the param but silently dropped it on the
        // floor; this assertion pins the fix so it can't regress.
        expect(record.input.promptChars).toBe('review'.length);
    });

    it('falls back to raw output when parsing fails but still records a run', async () => {
        // Failure mode: agent gave up before producing JSON. We must
        // still record (so the dashboard surfaces the bad run) and
        // surface the raw text in `markdown` so any downstream
        // github.comment posts *something* rather than empty string.
        // The auto-fix loop will then bail with a clear "no parseable
        // issues" error — that's correct behavior; silently dropping
        // the record would hide the real failure.
        mockedRunAgent.mockResolvedValue({
            output: 'I explored the repo but could not converge on a review.',
            parsedJson: undefined,
            model: 'glm-4.6',
            provider: 'opencode',
        });

        const ctx = makeContext();
        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review', parse_as_review: true },
            ctx,
        ) as Record<string, unknown>;

        expect(result.runId).toBeDefined();
        expect(result.markdown).toBe('I explored the repo but could not converge on a review.');
        expect(result.structured).toBeUndefined();
        expect(result.summary).toBeUndefined();
        expect(result.mergeReady).toBeUndefined();

        const reviewDir = join(runsRoot, 'ai-review');
        const dateDirs = await readdir(reviewDir);
        const record = JSON.parse(
            await readFile(join(reviewDir, dateDirs[0], `${result.runId}.json`), 'utf-8'),
        ) as AiReviewRunRecord;
        expect(record.output.parseSucceeded).toBe(false);
        expect(record.output.parseFailureKind).toBeDefined();
        expect(record.output.rawSample).toMatch(/explored the repo/);
    });

    it('captures repo/prNumber/branch from the event in the recorded run', async () => {
        // address-review reads `record.event.branch` to know which ref
        // to operate on. If we drop this on the floor, the auto-fix
        // loop reaches for an undefined branch and the push leg of
        // the workflow points at the wrong place.
        mockedRunAgent.mockResolvedValue({
            output: STRUCTURED_REVIEW_OUTPUT,
            parsedJson: undefined,
            model: 'glm-4.6',
            provider: 'opencode',
        });

        const ctx = makeContext({
            event: {
                source: 'github',
                event: 'pull_request.opened',
                timestamp: '2026-05-20T00:00:00Z',
                payload: {
                    pull_request: {
                        number: 99,
                        head: { ref: 'feat/fix-stuff' },
                    },
                },
                metadata: { repo: 'me/proj', prNumber: 99 },
            },
            workflowName: 'agentic-review-wf',
        });

        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'review', parse_as_review: true },
            ctx,
        ) as Record<string, unknown>;

        const reviewDir = join(runsRoot, 'ai-review');
        const dateDirs = await readdir(reviewDir);
        const record = JSON.parse(
            await readFile(join(reviewDir, dateDirs[0], `${result.runId}.json`), 'utf-8'),
        ) as AiReviewRunRecord;

        expect(record.event.repo).toBe('me/proj');
        expect(record.event.prNumber).toBe(99);
        expect(record.event.branch).toBe('feat/fix-stuff');
        expect(record.workflowName).toBe('agentic-review-wf');
    });
});
