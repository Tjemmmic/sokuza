import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiReviewAction } from '../actions/ai-review.js';
import { aiAgentAction } from '../actions/ai-agent.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';
import { NodeRegistry } from '../core/nodes/registry.js';
import { loadAIProviders } from '../core/ai-providers.js';
import type { ActionContext } from '../core/types.js';

// ai.review and ai.agent declare specific output port NAMES in their node
// definitions. The graph runtime resolves wires like
// `{{nodes.review.markdown}}` by looking up the named key on the action's
// return value (see `wrapResult` + `resolveNodeInputs`). If the action
// returns a different key, the wire silently becomes undefined and any
// downstream action with a required field fails confusingly — exactly the
// "github-comment requires a 'body' param" the user hit when wiring
// `review.summary → post.body`.
//
// This file pins both halves of that contract: the registered node's
// declared output ports, AND the keys the action actually emits.

const TMP = join(tmpdir(), `sokuza-ai-contract-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

const { mockAnthropic } = vi.hoisted(() => {
    const create = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({
            summary: 'looks fine',
            issues: [],
            decision: 'APPROVE',
            justification: 'no problems',
        }) }],
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 50, output_tokens: 10 },
    });
    return { mockAnthropic: { messages: { create } } };
});

vi.mock('@anthropic-ai/sdk', () => ({
    default: vi.fn(() => mockAnthropic),
    APIError: class APIError extends Error {
        status: number;
        constructor(message: string, status: number) { super(message); this.status = status; }
    },
}));

vi.mock('../core/ai-providers.js', async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return {
        ...real,
        runAgentWithFallback: vi.fn().mockResolvedValue({
            output: 'agent ran fine',
            parsedJson: undefined,
            model: 'sonnet',
            provider: 'claude-code',
        }),
    };
});

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: {},
            metadata: {},
        },
        results: {},
        steps: { fetch_diff: { diff: '+a\n-b' } },
        integrationConfigs: {},
        ai: loadAIProviders(undefined),
        logger,
        ...overrides,
    };
}

function declaredOutputPorts(nodeType: string): string[] {
    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);
    const def = registry.serialize().find((n) => n.type === nodeType);
    expect(def, `${nodeType} should be registered`).toBeDefined();
    return def!.ports.filter((p) => p.role === 'output' && p.wire).map((p) => p.name);
}

describe('AI nodes: declared output ports match action return keys', () => {
    let prevRuns: string | undefined;
    let runsDir = '';

    beforeAll(async () => {
        await mkdir(TMP, { recursive: true });
    });

    afterAll(async () => {
        await rm(TMP, { recursive: true, force: true });
    });

    beforeEach(async () => {
        prevRuns = process.env.SOKUZA_RUNS_DIR;
        runsDir = await mkdtemp(join(TMP, 'runs-'));
        process.env.SOKUZA_RUNS_DIR = runsDir;
        process.env.ANTHROPIC_API_KEY = 'test-key';
    });

    afterEach(async () => {
        await rm(runsDir, { recursive: true, force: true });
        if (prevRuns === undefined) delete process.env.SOKUZA_RUNS_DIR;
        else process.env.SOKUZA_RUNS_DIR = prevRuns;
        delete process.env.ANTHROPIC_API_KEY;
        vi.clearAllMocks();
    });

    it('ai.review emits every output port name it advertises', async () => {
        const declared = declaredOutputPorts('ai.review');
        expect(declared.sort()).toEqual(['issues', 'markdown', 'mergeReady', 'runId', 'structured', 'summary']);

        const result = await aiReviewAction({}, makeContext({ ai: loadAIProviders(undefined) })) as Record<string, unknown>;
        for (const port of declared) {
            expect(port in result, `ai.review return must include "${port}" key`).toBe(true);
        }
    });

    it('ai.agent emits every output port name it advertises', async () => {
        const declared = declaredOutputPorts('ai.agent');
        expect(declared.sort()).toEqual(['output', 'transcript']);

        const result = await aiAgentAction(
            { workdir: '/tmp/repo', prompt: 'do the thing' },
            makeContext(),
        ) as Record<string, unknown>;
        for (const port of declared) {
            expect(port in result, `ai.agent return must include "${port}" key`).toBe(true);
        }
    });
});
