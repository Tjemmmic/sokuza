import { describe, it, expect, beforeEach } from 'vitest';
import {
    loadAIProviders,
    resolveProvider,
    buildCliArgs,
    buildCliInvocation,
    extractCliText,
} from '../core/ai-providers.js';

describe('loadAIProviders', () => {
    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
    });

    it('registers claude-code and anthropic defaults when ai block is missing', () => {
        const reg = loadAIProviders(undefined);
        expect(reg.providers.has('claude-code')).toBe(true);
        expect(reg.providers.has('anthropic')).toBe(true);
    });

    it('defaults to claude-code when no ANTHROPIC_API_KEY', () => {
        const reg = loadAIProviders(undefined);
        expect(reg.defaultProvider).toBe('claude-code');
    });

    it('defaults to anthropic when ANTHROPIC_API_KEY is set', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        const reg = loadAIProviders(undefined);
        expect(reg.defaultProvider).toBe('anthropic');
    });

    it('loads a user-declared zai-glm provider', () => {
        const reg = loadAIProviders({
            providers: {
                'zai-glm': {
                    kind: 'anthropic-api',
                    base_url: 'https://api.z.ai/api/anthropic',
                    api_key: 'zai-key-123',
                    default_model: 'glm-4.6',
                },
            },
        });
        const p = reg.providers.get('zai-glm')!;
        expect(p.kind).toBe('anthropic-api');
        expect(p.baseUrl).toBe('https://api.z.ai/api/anthropic');
        expect(p.apiKey).toBe('zai-key-123');
        expect(p.defaultModel).toBe('glm-4.6');
    });

    it('loads a CLI provider with env injection', () => {
        const reg = loadAIProviders({
            providers: {
                'zai-glm-agent': {
                    kind: 'cli',
                    command: 'claude',
                    args_style: 'claude-code',
                    default_model: 'glm-4.6',
                    env: {
                        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
                        ANTHROPIC_AUTH_TOKEN: 'zai-key-123',
                    },
                },
            },
        });
        const p = reg.providers.get('zai-glm-agent')!;
        expect(p.kind).toBe('cli');
        expect(p.command).toBe('claude');
        expect(p.argsStyle).toBe('claude-code');
        expect(p.env?.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    });

    it('honors explicit default_provider', () => {
        const reg = loadAIProviders({
            default_provider: 'zai-glm',
            providers: {
                'zai-glm': {
                    kind: 'anthropic-api',
                    api_key: 'x',
                    base_url: 'https://api.z.ai/api/anthropic',
                },
            },
        });
        expect(reg.defaultProvider).toBe('zai-glm');
    });

    it('throws on unknown default_provider', () => {
        expect(() =>
            loadAIProviders({ default_provider: 'nonexistent' }),
        ).toThrow('not a registered provider');
    });

    it('throws on invalid kind', () => {
        expect(() =>
            loadAIProviders({
                providers: { bad: { kind: 'nonsense' } },
            }),
        ).toThrow('kind must be');
    });

    it('requires base_url for openai-compatible-api', () => {
        expect(() =>
            loadAIProviders({
                providers: { oi: { kind: 'openai-compatible-api', api_key: 'k' } },
            }),
        ).toThrow('base_url is required');
    });

    it('rejects unknown args_style', () => {
        expect(() =>
            loadAIProviders({
                providers: { weird: { kind: 'cli', args_style: 'aider' } },
            }),
        ).toThrow('args_style must be');
    });
});

describe('resolveProvider', () => {
    it('returns the default when no name is passed', () => {
        const reg = loadAIProviders(undefined);
        const p = resolveProvider(reg, undefined);
        expect(p.name).toBe(reg.defaultProvider);
    });

    it('maps legacy "api" alias to anthropic', () => {
        const reg = loadAIProviders(undefined);
        const p = resolveProvider(reg, 'api');
        expect(p.name).toBe('anthropic');
    });

    it('returns claude-code directly (no alias needed)', () => {
        const reg = loadAIProviders(undefined);
        const p = resolveProvider(reg, 'claude-code');
        expect(p.name).toBe('claude-code');
    });

    it('throws on unknown provider name', () => {
        const reg = loadAIProviders(undefined);
        expect(() => resolveProvider(reg, 'gpt-99')).toThrow('is not registered');
    });
});

describe('buildCliArgs', () => {
    it('builds claude-code completion args with --system-prompt', () => {
        const args = buildCliArgs('claude-code', {
            mode: 'completion',
            model: 'sonnet',
            systemPrompt: 'be nice',
        });
        expect(args).toEqual([
            '--print',
            '--model', 'sonnet',
            '--output-format', 'text',
            '--no-session-persistence',
            '--system-prompt', 'be nice',
        ]);
    });

    it('builds claude-code agent args with --allowedTools', () => {
        const args = buildCliArgs('claude-code', {
            mode: 'agent',
            model: 'opus',
            outputFormat: 'json',
            allowedTools: ['Read', 'Grep'],
        });
        expect(args).toContain('--dangerously-skip-permissions');
        expect(args).toContain('--allowedTools');
        const idx = args.indexOf('--allowedTools');
        expect(args[idx + 1]).toBe('Read,Grep');
        expect(args).toContain('--output-format');
        expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    });

    it('builds opencode completion args (model flag, no system-prompt flag)', () => {
        const args = buildCliArgs('opencode', {
            mode: 'completion',
            model: 'zai-coding-plan/glm-5.1',
            systemPrompt: 'ignored at arg level',
        });
        // Always --format json because the default output is a TUI stream;
        // extractCliText re-assembles the model's text from the JSONL events.
        expect(args).toEqual(['run', '--model', 'zai-coding-plan/glm-5.1', '--format', 'json']);
    });

    it('builds opencode agent args with --dangerously-skip-permissions', () => {
        const args = buildCliArgs('opencode', {
            mode: 'agent',
            model: 'zai-coding-plan/glm-5.1',
            outputFormat: 'json',
            allowedTools: ['Read'],
        });
        expect(args).toEqual([
            'run', '--model', 'zai-coding-plan/glm-5.1',
            '--format', 'json',
            '--dangerously-skip-permissions',
        ]);
    });

    it('parses fallback_providers from config', () => {
        const reg = loadAIProviders({
            providers: {
                'zai-glm': {
                    kind: 'anthropic-api',
                    base_url: 'https://api.z.ai/api/anthropic',
                    api_key: 'zai-key',
                    default_model: 'glm-4.6',
                },
            },
            default_provider: 'anthropic',
            fallback_providers: ['claude-code', 'zai-glm'],
        });
        expect(reg.fallbackChain).toEqual(['claude-code', 'zai-glm']);
    });

    it('rejects unknown provider in fallback chain', () => {
        expect(() =>
            loadAIProviders({
                fallback_providers: ['nonexistent'],
            }),
        ).toThrow(/not a registered provider/);
    });

    it('returns empty fallback chain when not configured', () => {
        const reg = loadAIProviders(undefined);
        expect(reg.fallbackChain).toEqual([]);
    });
});

describe('buildCliInvocation', () => {
    it('claude-code: prompt rides on stdin, not argv', () => {
        const inv = buildCliInvocation(
            'claude-code',
            { mode: 'completion', model: 'sonnet', systemPrompt: 'sys' },
            'user prompt here',
        );
        expect(inv.stdin).toBe('user prompt here');
        expect(inv.args).not.toContain('user prompt here');
    });

    it('opencode: prompt is appended as a positional arg, stdin is null', () => {
        const inv = buildCliInvocation(
            'opencode',
            { mode: 'completion', model: 'zai-coding-plan/glm-5.1', systemPrompt: 'sys' },
            'user prompt here',
        );
        expect(inv.stdin).toBeNull();
        expect(inv.args[inv.args.length - 1]).toBe('user prompt here');
    });
});

describe('extractCliText', () => {
    it('claude-code: returns trimmed raw output', () => {
        expect(extractCliText('claude-code', '  hello world\n\n')).toBe('hello world');
    });

    it('opencode: concatenates all text event parts, ignores other events', () => {
        const jsonl = [
            '{"type":"step_start","timestamp":1,"part":{"id":"p1"}}',
            '{"type":"text","timestamp":2,"part":{"id":"p2","type":"text","text":"hello "}}',
            '{"type":"tool_use","timestamp":3,"part":{"id":"p3"}}',
            '{"type":"text","timestamp":4,"part":{"id":"p4","type":"text","text":"world"}}',
            '{"type":"step_finish","timestamp":5,"part":{"id":"p5"}}',
        ].join('\n');
        expect(extractCliText('opencode', jsonl)).toBe('hello world');
    });

    it('opencode: tolerates non-JSON prelude lines', () => {
        const raw = [
            'info: starting session abc',
            '{"type":"text","part":{"type":"text","text":"PONG"}}',
        ].join('\n');
        expect(extractCliText('opencode', raw)).toBe('PONG');
    });

    it('opencode: empty result when stream has no text or error events', () => {
        // No text + no error → empty (caller treats as silent failure
        // via the ai-review empty-output guard).
        expect(extractCliText('opencode', '{"type":"step_start","part":{}}')).toBe('');
    });

    it('opencode: surfaces error event messages when no text events were emitted', () => {
        // Previously a real failure mode: opencode exits 0 but the
        // stream contains only `error` events (provider hiccup,
        // model rejected). Without this, the parser returns `""` and
        // the workflow posts an empty review comment.
        const jsonl = [
            '{"type":"step_start","part":{}}',
            '{"type":"error","error":{"name":"ProviderError","data":{"message":"upstream API 503"}}}',
            '{"type":"step_finish","part":{}}',
        ].join('\n');
        const got = extractCliText('opencode', jsonl);
        expect(got).toMatch(/^\[opencode-error\]/);
        expect(got).toContain('upstream API 503');
    });

    it('opencode: text events win over coincident error events', () => {
        // When the model produced SOMETHING usable, surface that
        // instead of the error tail. The error events are still in the
        // record stream for debugging, but the user-visible output is
        // the model's actual text.
        const jsonl = [
            '{"type":"text","part":{"text":"partial answer"}}',
            '{"type":"error","error":{"data":{"message":"some upstream warning"}}}',
        ].join('\n');
        expect(extractCliText('opencode', jsonl)).toBe('partial answer');
    });

    it('opencode: error event with no data.message falls back to error.name', () => {
        // Newer opencode error shapes vary; tolerate both `data.message`
        // and `name` so a future schema bump doesn't silently swallow
        // the diagnostic.
        const jsonl = '{"type":"error","error":{"name":"UnknownError"}}';
        expect(extractCliText('opencode', jsonl)).toBe('[opencode-error] UnknownError');
    });
});
