import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiAgentAction } from './ai-agent.js';
import pino from 'pino';

vi.mock('../core/ai-providers.js', () => ({
    runAgentWithFallback: vi.fn(),
}));

import { runAgentWithFallback } from '../core/ai-providers.js';

const mockedRunAgent = vi.mocked(runAgentWithFallback);

const logger = pino({ level: 'silent' });

function makeContext() {
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
    } as import('../core/types.js').ActionContext;
}

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

    it('spreads parsed JSON fields into result alongside model and provider', async () => {
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
        );

        expect(result).toEqual({
            summary: 'LGTM',
            approved: true,
            model: 'sonnet',
            provider: 'claude-code',
        });
    });

    it('returns { review, model, provider } when output has no parsedJson', async () => {
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
            review: 'The code looks good overall.',
            model: 'opus',
            provider: 'claude-code',
        });
    });
});
