import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { aiReviewAction } from '../actions/ai-review.js';
import { loadAIProviders } from '../core/ai-providers.js';
import type { ActionContext } from '../core/types.js';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate run-record writes so tests never touch the real ~/.sokuza/runs/.
const RUNS_ENV = 'SOKUZA_RUNS_DIR';
const previousRunsDir = process.env[RUNS_ENV];
let runsRoot = '';

const mockLogger = pino({ level: 'silent' });

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: new Date().toISOString(),
            payload: {},
            metadata: {},
        },
        results: {},
        steps: {},
        integrationConfigs: {},
        ai: loadAIProviders(undefined),
        logger: mockLogger,
        ...overrides,
    };
}

// ─── Anthropic SDK mock ─────────────────────────────────────────────────────

const { mockCreate } = vi.hoisted(() => {
    const mockCreate = vi.fn().mockResolvedValue({
        content: [
            { type: 'text', text: 'This code looks good overall. Minor suggestion: add error handling for edge cases.' },
        ],
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 500, output_tokens: 100 },
    });
    return { mockCreate };
});

vi.mock('@anthropic-ai/sdk', () => ({
    default: class MockAnthropic {
        messages = { create: mockCreate };
        constructor(_opts: any) { }
    },
}));

// ─── spawn mock ─────────────────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => {
    const mockSpawn = vi.fn();
    return { mockSpawn };
});

vi.mock('node:child_process', () => ({
    spawn: mockSpawn,
}));

function createMockChild(stdout: string, code = 0) {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new PassThrough();

    // Emit data and close async so stdin.write() has time to complete
    setTimeout(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
    }, 10);

    return child;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('aiReviewAction', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        delete process.env.ANTHROPIC_API_KEY;
        runsRoot = await mkdtemp(join(tmpdir(), 'sokuza-ai-review-'));
        process.env[RUNS_ENV] = runsRoot;
    });

    afterEach(async () => {
        if (runsRoot) await rm(runsRoot, { recursive: true, force: true });
    });

    afterAll(() => {
        if (previousRunsDir === undefined) delete process.env[RUNS_ENV];
        else process.env[RUNS_ENV] = previousRunsDir;
    });

    it('should throw when no diff is available', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const context = makeContext();
        await expect(aiReviewAction({}, context)).rejects.toThrow('no diff provided');
    });

    it('should use anthropic provider when ANTHROPIC_API_KEY is set', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const context = makeContext({
            ai: loadAIProviders(undefined), // re-load so env var is picked up
            steps: { fetch_diff: { diff: '+added\n-removed', files: ['a.ts'] } },
        });

        // parse_repair_retries: 0 — the default mock returns non-JSON
        // prose; with the PR #13 fix, exhausting the repair loop on
        // no-json now throws. This test pins provider-routing behavior,
        // not the raw-text fallback, so opt out of the repair loop.
        const result = (await aiReviewAction({ parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('anthropic');
        expect(result.review).toContain('looks good overall');
    });

    // The ai.review node (core/nodes/builtins.ts) advertises six output
    // ports: markdown, structured, summary, issues, mergeReady, runId.
    // The action's return object must produce ALL of them, otherwise a
    // graph wire like `{{nodes.review.summary}}` silently resolves to
    // undefined and downstream actions (github.comment with `body`
    // required) fail with confusing errors. Pin every port name.
    it('returns every output port the ai.review node declares', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        // Force a parseable structured JSON response so the derived
        // ports (summary/issues/mergeReady) populate.
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                summary: 'Looks fine, no issues',
                issues: [],
                decision: 'APPROVE',
                justification: 'No problems found',
            }) }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 20 },
        });
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+a\n-b' } },
        });
        const result = (await aiReviewAction({}, context)) as Record<string, unknown>;
        expect(typeof result.markdown).toBe('string');
        expect(result.markdown).toBeTruthy();
        expect(typeof result.runId).toBe('string');
        expect(result.summary).toBe('Looks fine, no issues');
        expect(Array.isArray(result.issues)).toBe(true);
        expect(result.mergeReady).toBe(true);
        expect(result.structured).toMatchObject({ decision: 'APPROVE' });
    });

    // Real failure mode previously observed with opencode + glm-5.1:
    // the CLI exits 0 but the JSONL stream contains no `text` events,
    // so extractCliText returns `""`. The fallback at the end of the
    // action would then propagate empty review markdown into the
    // workflow, which posted a comment with just the template's
    // header and footer ("## 🤖 AI Code Review … _Reviewed by Sokuza
    // AI_"). The empty-output guard throws instead so the failure
    // shows up in the dashboard run viewer.
    it('throws when the model returns no usable content (silent empty case)', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        // Completion returns empty text — analogous to opencode emitting
        // a JSONL stream with no `text` events.
        mockCreate.mockResolvedValue({
            content: [{ type: 'text', text: '' }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 0 },
        });
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+a' } },
        });
        await expect(
            aiReviewAction({ parse_repair_retries: 0 }, context),
        ).rejects.toThrow(/returned no usable content/);
    });

    // PR #13's exact timeline (from the user's log):
    //   completion #1 → 1221 chars of "Now let me check the spawnCli
    //   function..." opencode exploration narration. failureKind=no-json.
    //   completion #2 (repair) → outputLength=0.
    //
    // The pre-fix fallback expression `review = attemptText || completion.text`
    // resurrected the original exploration text when `attemptText` (the
    // empty repair output) was falsy, and the empty-output guard saw a
    // 1221-char non-empty string and let it through. The action then
    // returned that exploration prose as `markdown` and downstream
    // github.comment posted it as the user-facing review. Pin the fix.
    it('throws on no-json after at least one repair attempt instead of resurrecting incoherent text', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const explorationText =
            'Now let me check one more thing about the spawnCli function — whether the ' +
            'detached: true combined with the process not being unref()\'d could cause the ' +
            'event loop to hang. Let me grep for child.unref() calls...';
        mockCreate
            // First completion: exploration prose, no JSON.
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: explorationText }],
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 100, output_tokens: 200 },
            })
            // Repair completion: empty (model gave up).
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: '' }],
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 100, output_tokens: 0 },
            });
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+a' } },
        });
        await expect(
            aiReviewAction({ parse_repair_retries: 1 }, context),
        ).rejects.toThrow(/produced no JSON/);
        // Both completions should have been called — repair runs first
        // before the new throw triggers.
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    // Belt-and-suspenders sister test: when only `parse_repair_retries: 0`
    // is set, the user opted out of the repair loop entirely. The
    // no-json throw is gated on `repairAttempts.length > 0` so this
    // path still posts the raw text — preserving the existing
    // "unparseable response" behavior tested above.
    it('still posts raw text when parse_repair_retries=0 (no repair attempted)', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        mockCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'just some prose, no JSON' }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
        });
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+a' } },
        });
        const result = (await aiReviewAction({ parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(typeof result.markdown).toBe('string');
        expect((result.markdown as string)).toContain('just some prose');
    });

    it('returns markdown + undefined structured ports when the response is unparseable', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        // Unparseable response — repair loop will exhaust and the action
        // still returns. The graph contract demands `markdown` is always
        // populated even when structured parsing failed; the derived
        // ports may be undefined.
        mockCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'just some prose, no JSON' }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
        });
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+a' } },
        });
        const result = (await aiReviewAction({ parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(typeof result.markdown).toBe('string');
        expect(result.markdown).toBeTruthy();
        // Parsing failed → these collapse to undefined, which is the
        // documented behavior. The contract is "the port name exists";
        // value semantics are up to the caller to handle.
        expect(result.structured).toBeUndefined();
        expect(result.summary).toBeUndefined();
        expect(result.mergeReady).toBeUndefined();
    });

    it('should accept legacy "api" provider alias', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+added\n-removed' } },
        });

        const result = (await aiReviewAction({ provider: 'api', parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('anthropic');
    });

    it('should throw when anthropic provider forced but no key', async () => {
        const context = makeContext({ steps: { fd: { diff: 'x' } } });
        await expect(aiReviewAction({ provider: 'anthropic' }, context)).rejects.toThrow('missing api_key');
    });

    it('should auto-detect claude-code when no key is set', async () => {
        mockSpawn.mockReturnValue(createMockChild('CLI review output'));
        const context = makeContext({ steps: { fd: { diff: 'some diff' } } });

        // parse_repair_retries: 0 — these tests assert single-spawn
        // behavior, predating the parse-failure repair loop. Without
        // disabling retries, the action would re-spawn the CLI and the
        // shared mockReturnValue child would already be closed.
        const result = (await aiReviewAction({ parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('claude-code');
        expect(result.review).toBe('CLI review output');
    });

    it('should force claude-code even with API key', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        mockSpawn.mockReturnValue(createMockChild('Forced CLI'));
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fd: { diff: 'diff' } },
        });

        const result = (await aiReviewAction({ provider: 'claude-code', parse_repair_retries: 0 }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('claude-code');
    });

    it('should pipe prompt via stdin, not as CLI arg', async () => {
        const mockChild = createMockChild('review');
        mockSpawn.mockReturnValue(mockChild);
        const context = makeContext({ steps: { fd: { diff: 'big diff' } } });

        await aiReviewAction({ parse_repair_retries: 0 }, context);

        // Verify spawn args don't contain the prompt content
        const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
        expect(spawnArgs).toContain('--print');
        expect(spawnArgs).not.toContain('big diff');
    });

    it('should handle CLI exit code 1', async () => {
        mockSpawn.mockReturnValue(createMockChild('', 1));
        const context = makeContext({ steps: { fd: { diff: 'x' } } });

        await expect(
            aiReviewAction({ provider: 'claude-code' }, context),
        ).rejects.toThrow('exited with code 1');
    });

    it('writes a run record capturing truncation and output', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fd: { diff: '+added\n-removed' } },
            event: {
                source: 'github',
                event: 'pull_request.opened',
                timestamp: new Date().toISOString(),
                payload: { pull_request: { number: 7, head: { ref: 'feat/x' } } },
                metadata: { repo: 'org/repo', prNumber: 7 },
            },
            workflowName: 'ai-pr-review',
        });

        await aiReviewAction({ parse_repair_retries: 0 }, context);

        const dateDir = (await readdir(join(runsRoot, 'ai-review')))[0];
        const files = await readdir(join(runsRoot, 'ai-review', dateDir));
        expect(files).toHaveLength(1);

        const record = JSON.parse(
            await readFile(join(runsRoot, 'ai-review', dateDir, files[0]), 'utf-8'),
        );
        expect(record.action).toBe('ai-review');
        expect(record.workflowName).toBe('ai-pr-review');
        expect(record.event).toMatchObject({ repo: 'org/repo', prNumber: 7, branch: 'feat/x' });
        expect(record.provider).toBe('anthropic');
        expect(record.strategy).toBe('truncate');
        expect(record.input.diffBytes).toBeGreaterThan(0);
        expect(record.input.diffSha1).toMatch(/^[a-f0-9]{40}$/);
        expect(record.truncation.triggered).toBe(false);
        expect(Array.isArray(record.truncation.files)).toBe(true);
        expect(record.output.reviewChars).toBeGreaterThan(0);
    });

    it('repairs a non-JSON first attempt by re-querying the provider', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        // First call: chatty exploration text (no JSON) — simulates the
        // opencode/GLM flake mode. Second call: valid JSON via the repair
        // prompt. Action should succeed and tag the record with one repair.
        const exploration = 'Let me look at the diff first. I see the change adds a new field, and I want to verify it. Looking at the imports...';
        const repaired = JSON.stringify({
            summary: 'Recovered',
            issues: [],
            decision: 'APPROVE',
            justification: 'No issues found after recovery',
        });
        mockCreate
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: exploration }],
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 100, output_tokens: 50 },
            })
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: repaired }],
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 80, output_tokens: 40 },
            });

        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fd: { diff: 'diff content' } },
            event: {
                source: 'github', event: 'pull_request.opened',
                timestamp: new Date().toISOString(),
                payload: {}, metadata: { repo: 'org/repo', prNumber: 1 },
            },
        });

        const result = await aiReviewAction({}, context) as Record<string, unknown>;
        expect((result.parsed as Record<string, unknown> | undefined)?.decision).toBe('APPROVE');

        // Both completions called.
        expect(mockCreate).toHaveBeenCalledTimes(2);

        // Record reflects success-after-one-repair.
        const dateDir = (await readdir(join(runsRoot, 'ai-review')))[0];
        const files = await readdir(join(runsRoot, 'ai-review', dateDir));
        const record = JSON.parse(await readFile(join(runsRoot, 'ai-review', dateDir, files[0]), 'utf-8'));
        expect(record.output.parseSucceeded).toBe(true);
        expect(record.output.repairAttempts).toHaveLength(1);
        expect(record.output.repairAttempts[0].kind).toBe('no-json');
        expect(record.output.repairAttempts[0].rawSample).toContain('Let me look');
    });

    it('honors parse_repair_retries=0 to disable the repair loop', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: 'just exploration, no json' }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
        });

        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fd: { diff: 'x' } },
        });
        await aiReviewAction({ parse_repair_retries: 0 }, context);
        // No retry — exactly one call.
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('gives up after the configured retries by throwing (with parseFailureKind recorded)', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        mockCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'still no json after retry' }],
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
        });

        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fd: { diff: 'x' } },
        });
        // PR #13 fix: after `parse_repair_retries` exhausts with the
        // parser still reporting `no-json`, ai-review now throws
        // instead of posting raw exploration text. The run record
        // still captures the failure for the dashboard run viewer.
        await expect(
            aiReviewAction({ parse_repair_retries: 2 }, context),
        ).rejects.toThrow(/produced no JSON/);
        // 1 initial + 2 repairs = 3 total.
        expect(mockCreate).toHaveBeenCalledTimes(3);

        const dateDir = (await readdir(join(runsRoot, 'ai-review')))[0];
        const files = await readdir(join(runsRoot, 'ai-review', dateDir));
        const record = JSON.parse(await readFile(join(runsRoot, 'ai-review', dateDir, files[0]), 'utf-8'));
        expect(record.output.parseSucceeded).toBe(false);
        expect(record.output.parseFailureKind).toBe('no-json');
        expect(record.output.repairAttempts).toHaveLength(2);
    });

    it('writes a run record with error field when the provider fails', async () => {
        const context = makeContext({ steps: { fd: { diff: 'x' } } });

        await expect(
            aiReviewAction({ provider: 'anthropic' }, context),
        ).rejects.toThrow('missing api_key');

        const dateDir = (await readdir(join(runsRoot, 'ai-review')))[0];
        const files = await readdir(join(runsRoot, 'ai-review', dateDir));
        const record = JSON.parse(
            await readFile(join(runsRoot, 'ai-review', dateDir, files[0]), 'utf-8'),
        );
        expect(record.error).toMatch(/missing api_key/);
        expect(record.output.parseSucceeded).toBe(false);
    });
});
