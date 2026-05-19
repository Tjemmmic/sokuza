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
});
