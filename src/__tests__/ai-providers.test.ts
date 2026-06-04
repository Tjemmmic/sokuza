import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import {
    loadAIProviders,
    resolveProvider,
    buildCliArgs,
    buildCliInvocation,
    extractCliText,
    spawnCli,
    commandExistsOnPath,
    listImplicitProviders,
} from '../core/ai-providers.js';

const TEST_LOGGER = pino({ level: 'silent' });

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

    it('gemini: prompt rides after -p, text output, stdin null', () => {
        const inv = buildCliInvocation(
            'gemini',
            { mode: 'completion', model: 'gemini-2.5-pro', systemPrompt: 'sys' },
            'the prompt',
        );
        expect(inv.stdin).toBeNull();
        expect(inv.args).toEqual(['-o', 'text', '-m', 'gemini-2.5-pro', '-p', 'the prompt']);
    });

    it('gemini: omits -m when no model is given (CLI default)', () => {
        const inv = buildCliInvocation(
            'gemini',
            { mode: 'completion', model: '', systemPrompt: 'sys' },
            'p',
        );
        expect(inv.args).toEqual(['-o', 'text', '-p', 'p']);
    });

    it('codex: exec --json with positional prompt, stdin null', () => {
        const inv = buildCliInvocation(
            'codex',
            { mode: 'completion', model: 'gpt-5', systemPrompt: 'sys' },
            'the prompt',
        );
        expect(inv.stdin).toBeNull();
        expect(inv.args).toEqual(['exec', '--json', '-m', 'gpt-5', 'the prompt']);
    });

    it('codex: agent mode adds the bypass flag', () => {
        const args = buildCliArgs('codex', {
            mode: 'agent', model: 'gpt-5', outputFormat: 'json', allowedTools: [],
        });
        expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
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

    it('gemini: returns trimmed raw text (like claude-code)', () => {
        expect(extractCliText('gemini', '  {"ok":true}\n\n')).toBe('{"ok":true}');
    });

    it('codex: concatenates text events from the JSONL stream', () => {
        const jsonl = [
            '{"type":"thread.started","thread_id":"t1"}',
            '{"type":"turn.started"}',
            '{"type":"text","text":"hello "}',
            '{"type":"text","text":"world"}',
            '{"type":"turn.completed"}',
        ].join('\n');
        expect(extractCliText('codex', jsonl)).toBe('hello world');
    });

    it('codex: reads an assistant message from item.completed', () => {
        const jsonl = '{"type":"item.completed","item":{"type":"assistant_message","text":"answer"}}';
        expect(extractCliText('codex', jsonl)).toBe('answer');
    });

    it('codex: surfaces turn.failed errors with a sentinel when no text', () => {
        const jsonl = '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}';
        expect(extractCliText('codex', jsonl)).toBe('[codex-error] 401 Unauthorized');
    });
});

describe('CLI provider auto-detection', () => {
    it('commandExistsOnPath finds a real binary and rejects a fake one', () => {
        expect(commandExistsOnPath('node')).toBe(true);
        expect(commandExistsOnPath('definitely-not-a-real-binary-xyz123')).toBe(false);
    });

    it('listImplicitProviders always includes the always-on defaults', () => {
        const names = listImplicitProviders().map((p) => p.name);
        expect(names).toContain('claude-code');
        expect(names).toContain('anthropic');
    });

    it('accepts gemini/codex args_style in config', () => {
        const reg = loadAIProviders({
            providers: {
                g: { kind: 'cli', command: 'gemini', args_style: 'gemini' },
                c: { kind: 'cli', command: 'codex', args_style: 'codex' },
            },
        });
        expect(reg.providers.get('g')?.argsStyle).toBe('gemini');
        expect(reg.providers.get('c')?.argsStyle).toBe('codex');
    });

    it('rejects an unknown args_style', () => {
        expect(() => loadAIProviders({
            providers: { x: { kind: 'cli', command: 'foo', args_style: 'bogus' } },
        })).toThrow(/args_style must be one of/);
    });
});

// ─── spawnCli abort behavior ────────────────────────────────────────────────
//
// Before the signal plumbing in this PR, hitting `queue.defaults.timeout`
// would reject the workflow promise but the AI CLI subprocess (claude,
// opencode, …) would keep running — eating tokens for output the user
// would never see, and on a busy box piling up zombie processes across
// repeated timeouts. spawnCli now wires the workflow's AbortSignal to
// SIGTERM the child, with a 1.5s SIGKILL backstop for processes that
// ignore SIGTERM.

describe('spawnCli — abort signal propagation', () => {
    it('SIGTERMs a long-running child within ~100ms of abort', async () => {
        // Surrogate "AI CLI": a Node subprocess that sleeps 30s and
        // then prints. If our signal plumbing works, this should die
        // well before the 30s.
        const ac = new AbortController();
        const startedAt = Date.now();
        const promise = spawnCli({
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.stdout.write("done"), 30_000);'],
            stdin: null,
            logger: TEST_LOGGER,
            providerName: 'test-cli',
            signal: ac.signal,
        });
        // Abort shortly after spawn — gives the child a moment to
        // actually start. Without the plumbing this rejection never
        // fires; the test would time out after vitest's default 5s.
        setTimeout(() => ac.abort({ kind: 'timeout', timeoutSec: 30 }), 50);
        await expect(promise).rejects.toThrow(/timed out/i);
        const elapsed = Date.now() - startedAt;
        // 2s budget = abort delay (50ms) + SIGTERM kill (~10ms) +
        // event-loop overhead. The 30s setTimeout would push us past
        // this only if SIGTERM never reached the child.
        expect(elapsed).toBeLessThan(2000);
    });

    it('rejects immediately if signal is already aborted before spawn', async () => {
        const ac = new AbortController();
        ac.abort({ kind: 'cancelled' });
        await expect(spawnCli({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("should-not-run")'],
            stdin: null,
            logger: TEST_LOGGER,
            providerName: 'test-cli',
            signal: ac.signal,
        })).rejects.toThrow();
    });

    it('lets a normal (non-aborted) completion succeed', async () => {
        const stdout = await spawnCli({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("hello")'],
            stdin: null,
            logger: TEST_LOGGER,
            providerName: 'test-cli',
        });
        expect(stdout).toBe('hello');
    });
});
