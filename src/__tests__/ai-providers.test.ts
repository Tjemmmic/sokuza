import { describe, it, expect, beforeEach } from 'vitest';
import {
    loadAIProviders,
    resolveProvider,
    buildCliArgs,
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
            model: 'glm-4.6',
            systemPrompt: 'ignored at arg level',
        });
        expect(args).toEqual(['run', '--model', 'glm-4.6']);
    });

    it('builds opencode agent args with --format json when requested', () => {
        const args = buildCliArgs('opencode', {
            mode: 'agent',
            model: 'glm-4.6',
            outputFormat: 'json',
            allowedTools: ['Read'],
        });
        expect(args).toEqual(['run', '--model', 'glm-4.6', '--format', 'json']);
    });
});
