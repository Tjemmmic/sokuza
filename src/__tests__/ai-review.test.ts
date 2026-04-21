import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiReviewAction } from '../actions/ai-review.js';
import { loadAIProviders } from '../core/ai-providers.js';
import type { ActionContext } from '../core/types.js';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.ANTHROPIC_API_KEY;
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
});
