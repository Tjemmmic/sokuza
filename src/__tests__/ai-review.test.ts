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

        const result = (await aiReviewAction({}, context)) as Record<string, unknown>;
        expect(result.provider).toBe('anthropic');
        expect(result.review).toContain('looks good overall');
    });

    it('should accept legacy "api" provider alias', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const context = makeContext({
            ai: loadAIProviders(undefined),
            steps: { fetch_diff: { diff: '+added\n-removed' } },
        });

        const result = (await aiReviewAction({ provider: 'api' }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('anthropic');
    });

    it('should throw when anthropic provider forced but no key', async () => {
        const context = makeContext({ steps: { fd: { diff: 'x' } } });
        await expect(aiReviewAction({ provider: 'anthropic' }, context)).rejects.toThrow('missing api_key');
    });

    it('should auto-detect claude-code when no key is set', async () => {
        mockSpawn.mockReturnValue(createMockChild('CLI review output'));
        const context = makeContext({ steps: { fd: { diff: 'some diff' } } });

        const result = (await aiReviewAction({}, context)) as Record<string, unknown>;
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

        const result = (await aiReviewAction({ provider: 'claude-code' }, context)) as Record<string, unknown>;
        expect(result.provider).toBe('claude-code');
    });

    it('should pipe prompt via stdin, not as CLI arg', async () => {
        const mockChild = createMockChild('review');
        mockSpawn.mockReturnValue(mockChild);
        const context = makeContext({ steps: { fd: { diff: 'big diff' } } });

        await aiReviewAction({}, context);

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

        await aiReviewAction({}, context);

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
