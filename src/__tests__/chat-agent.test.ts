import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { ChatStore } from '../core/chat-store.js';
import { runChatTurn, type ChatEvent } from '../core/chat-agent.js';
import type { SokuzaEngine } from '../core/engine.js';
import { loadAIProviders } from '../core/ai-providers.js';

const silent = pino({ level: 'silent' });

// Mock the Anthropic SDK — we script its behavior per test.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
    class MockAnthropic {
        messages = { create: mockCreate };
        constructor(_opts: unknown) { /* no-op */ }
    }
    // Also export the typed error classes the agent checks instanceof against.
    class APIError extends Error { status = 500; }
    class AuthenticationError extends APIError {}
    class RateLimitError extends APIError {}
    return {
        default: Object.assign(MockAnthropic, { APIError, AuthenticationError, RateLimitError }),
    };
});

// Mock the chat-store import the *chat-tools* module uses for get_diff
// caching — unrelated to the agent, but it'd try to read from the real
// ~/.sokuza path otherwise. We don't invoke get_diff in these tests, so
// this stays a pass-through.
vi.mock('../core/ai-providers.js', async () => {
    const actual = await vi.importActual<typeof import('../core/ai-providers.js')>('../core/ai-providers.js');
    return actual;
});

function makeEngine(baseDir: string): SokuzaEngine {
    const ai = loadAIProviders({
        default_provider: 'zai-glm',
        providers: {
            'zai-glm': {
                kind: 'anthropic-api',
                api_key: 'test-key',
                base_url: 'https://api.z.ai/api/anthropic',
                default_model: 'glm-5.1',
            },
        },
    });
    return {
        getConfig: () => ({ ai, workflows: [] } as any),
        runWorkflowByName: vi.fn(async () => ({ ok: true, runId: 'r1' })),
    } as unknown as SokuzaEngine;
}

describe('runChatTurn', () => {
    let baseDir: string;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'sokuza-chat-agent-'));
        mockCreate.mockReset();
    });

    afterEach(async () => {
        await rm(baseDir, { recursive: true, force: true });
    });

    it('single-turn text reply (no tool use) persists user + assistant messages', async () => {
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: 'Hello!' }],
            stop_reason: 'end_turn',
        });

        const store = new ChatStore(silent, baseDir);
        const session = await store.createSession({
            scope: { kind: 'repo', repo: 'o/r' },
            provider: 'zai-glm',
        });
        const engine = makeEngine(baseDir);

        const events: ChatEvent[] = [];
        await runChatTurn({
            session, userMessage: 'Hi there',
            engine, logger: silent, store,
            emit: (e) => events.push(e),
        });

        // Two event kinds: one assistant_text, one done.
        expect(events.map((e) => e.type)).toEqual(['assistant_text', 'done']);

        const msgs = await store.getMessages(session.id);
        // user → assistant text
        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(msgs[1].content).toBe('Hello!');
    });

    it('dispatches a tool_use then loops with the result', async () => {
        // Turn 1: model asks for get_scope_info.
        // Turn 2: model returns final text using the tool's result.
        mockCreate
            .mockResolvedValueOnce({
                content: [
                    { type: 'tool_use', id: 'tu_1', name: 'get_scope_info', input: {} },
                ],
                stop_reason: 'tool_use',
            })
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: 'Scope is a PR.' }],
                stop_reason: 'end_turn',
            });

        const store = new ChatStore(silent, baseDir);
        const session = await store.createSession({
            scope: { kind: 'pr', repo: 'o/r', ref: 'feat/x', prNumber: 3 },
            provider: 'zai-glm',
        });
        const engine = makeEngine(baseDir);

        const events: ChatEvent[] = [];
        await runChatTurn({
            session, userMessage: 'What is this?',
            engine, logger: silent, store,
            emit: (e) => events.push(e),
        });

        // Expected event stream: tool_call → tool_result → assistant_text → done
        expect(events.map((e) => e.type)).toEqual([
            'tool_call', 'tool_result', 'assistant_text', 'done',
        ]);

        // Persisted log: user → assistant(tool_call) → tool(result) → assistant(text)
        const msgs = await store.getMessages(session.id);
        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(msgs[1].toolCall?.name).toBe('get_scope_info');
        expect(msgs[2].toolResult?.callId).toBe('tu_1');
        expect(msgs[3].content).toBe('Scope is a PR.');

        // Second API call must have received the first assistant turn + the tool_result.
        const secondCall = mockCreate.mock.calls[1]![0];
        const messages = secondCall.messages as any[];
        expect(messages[messages.length - 1].role).toBe('user');
        expect(messages[messages.length - 1].content[0].type).toBe('tool_result');
        expect(messages[messages.length - 1].content[0].tool_use_id).toBe('tu_1');
    });

    it('emits error and done when the session provider is not anthropic-api', async () => {
        const store = new ChatStore(silent, baseDir);
        const session = await store.createSession({
            scope: { kind: 'repo', repo: 'o/r' },
            provider: 'opencode',
        });

        const ai = loadAIProviders({
            providers: {
                opencode: {
                    kind: 'cli',
                    command: 'opencode',
                    args_style: 'opencode',
                    default_model: 'zai-coding-plan/glm-5.1',
                },
            },
        });
        const engine = {
            getConfig: () => ({ ai, workflows: [] } as any),
            runWorkflowByName: async () => ({ ok: true }),
        } as unknown as SokuzaEngine;

        const events: ChatEvent[] = [];
        await runChatTurn({
            session, userMessage: 'hi',
            engine, logger: silent, store,
            emit: (e) => events.push(e),
        });

        expect(events.map((e) => e.type)).toEqual(['error', 'done']);
        const errorEvent = events[0] as Extract<ChatEvent, { type: 'error' }>;
        expect(errorEvent.error).toMatch(/anthropic-api/);
    });

    it('stops after MAX_TOOL_ITERATIONS when the model keeps asking for tools', async () => {
        // Always respond with a tool_use — the agent should bail after 10.
        mockCreate.mockResolvedValue({
            content: [{ type: 'tool_use', id: 'tu_x', name: 'get_scope_info', input: {} }],
            stop_reason: 'tool_use',
        });

        const store = new ChatStore(silent, baseDir);
        const session = await store.createSession({
            scope: { kind: 'repo', repo: 'o/r' },
            provider: 'zai-glm',
        });
        const engine = makeEngine(baseDir);

        const events: ChatEvent[] = [];
        await runChatTurn({
            session, userMessage: 'loop forever',
            engine, logger: silent, store,
            emit: (e) => events.push(e),
        });

        // Ended with an assistant_text explaining the cap, then done.
        const types = events.map((e) => e.type);
        expect(types[types.length - 2]).toBe('assistant_text');
        expect(types[types.length - 1]).toBe('done');
        const finalText = (events[events.length - 2] as Extract<ChatEvent, { type: 'assistant_text' }>).message.content;
        expect(finalText).toMatch(/10-tool-iteration cap/);
        // Exactly 10 API calls.
        expect(mockCreate).toHaveBeenCalledTimes(10);
    });
});
