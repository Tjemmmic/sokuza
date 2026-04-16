/**
 * Pluggable AI provider system.
 *
 * Actions (`ai-review`, `ai-agent`) do not talk to vendor SDKs or CLIs
 * directly — they resolve a named provider from this registry and call
 * either `runCompletion` (simple text completion) or `runAgent` (CLI
 * tool-use / agentic mode).
 *
 * Providers are declared in `sokuza.config.yaml` under the `ai:` block.
 * Three provider kinds are supported:
 *
 * 1. **anthropic-api** — Anthropic SDK. Supports custom `base_url`, so
 *    providers that expose an Anthropic-compatible endpoint (ZAI GLM,
 *    Moonshot, etc.) work without extra code.
 * 2. **openai-compatible-api** — Any OpenAI-style `/v1/chat/completions`
 *    endpoint (OpenAI, ZAI, OpenRouter, Groq, LM Studio, Ollama, …).
 * 3. **cli** — Spawn a CLI binary (`claude`, `opencode`, …) with its
 *    argument layout selected by `args_style`. Extra env vars can be
 *    injected, which is how we point Claude Code at ZAI GLM's Anthropic-
 *    compatible endpoint without changing anything else.
 *
 * Adding support for a new CLI (e.g. `codex`) is a single new case in
 * `buildCliArgs()` plus a new string literal in `ArgsStyle`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProviderKind = 'anthropic-api' | 'openai-compatible-api' | 'cli';

/**
 * How CLI args are laid out for a given binary. Each style is a distinct
 * function in `buildCliArgs()` — add a new value here when adding a CLI.
 */
export type ArgsStyle = 'claude-code' | 'opencode';

export interface AIProvider {
    /** Registry key, e.g. "zai-glm", "anthropic", "opencode". */
    name: string;
    kind: ProviderKind;
    /** Default model used when an action does not specify one. */
    defaultModel?: string;

    // ─── API provider fields ────────────────────────────────────────────
    /** Resolved API key (after env var interpolation). */
    apiKey?: string;
    /** Override the SDK's default base URL. */
    baseUrl?: string;

    // ─── CLI provider fields ────────────────────────────────────────────
    /** Binary to spawn, e.g. "claude", "opencode". */
    command?: string;
    /** Extra env vars merged into the spawned process (e.g. ANTHROPIC_BASE_URL). */
    env?: Record<string, string>;
    /** Which arg-building strategy to use. */
    argsStyle?: ArgsStyle;
}

export interface AIProviderRegistry {
    providers: Map<string, AIProvider>;
    defaultProvider: string;
    /** Ordered list of provider names to try on failure. */
    fallbackChain: string[];
}

// ─── Legacy aliases ─────────────────────────────────────────────────────────

/**
 * Maps legacy `provider` param values (pre-registry) to their equivalent
 * registered provider name. Keeps existing templates working unchanged.
 */
const LEGACY_ALIASES: Record<string, string> = {
    api: 'anthropic',
    // 'claude-code' is also a default registry key, no alias needed
};

// ─── Registry loading ───────────────────────────────────────────────────────

/**
 * Build a provider registry from the parsed `ai:` block of the config.
 *
 * If the block is missing or empty, we still register sensible defaults
 * (`claude-code` CLI and `anthropic` API) so existing workflows continue
 * to work with no config changes.
 */
export function loadAIProviders(
    raw: Record<string, unknown> | undefined,
): AIProviderRegistry {
    const providers = new Map<string, AIProvider>();

    // ─── Always register built-in defaults ──────────────────────────────
    providers.set('claude-code', {
        name: 'claude-code',
        kind: 'cli',
        command: 'claude',
        argsStyle: 'claude-code',
        defaultModel: 'sonnet',
    });
    providers.set('anthropic', {
        name: 'anthropic',
        kind: 'anthropic-api',
        apiKey: process.env.ANTHROPIC_API_KEY,
        defaultModel: 'claude-sonnet-4-20250514',
    });

    // ─── Merge user-declared providers ──────────────────────────────────
    const userProviders = (raw?.providers ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(userProviders)) {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`ai.providers.${name}: entry must be an object`);
        }
        providers.set(name, parseProvider(name, entry as Record<string, unknown>));
    }

    // ─── Determine the default provider ─────────────────────────────────
    let defaultProvider = (raw?.default_provider as string | undefined)?.trim();
    if (!defaultProvider) {
        // Back-compat: prefer anthropic if a key is present, else claude-code CLI
        defaultProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'claude-code';
    }
    if (!providers.has(defaultProvider)) {
        throw new Error(
            `ai.default_provider "${defaultProvider}" is not a registered provider. ` +
            `Known: ${[...providers.keys()].join(', ')}`,
        );
    }

    // ─── Parse fallback chain ────────────────────────────────────────────
    const fallbackChain: string[] = [];
    const rawFallbacks = raw?.fallback_providers;
    if (Array.isArray(rawFallbacks)) {
        for (const name of rawFallbacks) {
            if (typeof name !== 'string') continue;
            if (!providers.has(name)) {
                throw new Error(
                    `ai.fallback_providers: "${name}" is not a registered provider. ` +
                    `Known: ${[...providers.keys()].join(', ')}`,
                );
            }
            fallbackChain.push(name);
        }
    }

    return { providers, defaultProvider, fallbackChain };
}

function parseProvider(name: string, raw: Record<string, unknown>): AIProvider {
    const kind = raw.kind as ProviderKind | undefined;
    if (kind !== 'anthropic-api' && kind !== 'openai-compatible-api' && kind !== 'cli') {
        throw new Error(
            `ai.providers.${name}.kind must be "anthropic-api", "openai-compatible-api", or "cli"`,
        );
    }

    const provider: AIProvider = {
        name,
        kind,
        defaultModel: raw.default_model as string | undefined,
    };

    if (kind === 'anthropic-api' || kind === 'openai-compatible-api') {
        provider.apiKey = (raw.api_key as string | undefined) || undefined;
        provider.baseUrl = (raw.base_url as string | undefined) || undefined;

        // For OpenAI-compatible, baseUrl is required (no default endpoint)
        if (kind === 'openai-compatible-api' && !provider.baseUrl) {
            throw new Error(
                `ai.providers.${name}.base_url is required for openai-compatible-api providers`,
            );
        }
    }

    if (kind === 'cli') {
        provider.command = (raw.command as string | undefined) ?? 'claude';
        provider.argsStyle = (raw.args_style as ArgsStyle | undefined) ?? 'claude-code';
        if (provider.argsStyle !== 'claude-code' && provider.argsStyle !== 'opencode') {
            throw new Error(
                `ai.providers.${name}.args_style must be "claude-code" or "opencode"`,
            );
        }
        if (raw.env && typeof raw.env === 'object') {
            provider.env = raw.env as Record<string, string>;
        }
    }

    return provider;
}

// ─── Provider resolution ────────────────────────────────────────────────────

/**
 * Look up a provider by name, applying legacy-alias fallback and the
 * registry's default. Throws if the name is unknown.
 */
export function resolveProvider(
    registry: AIProviderRegistry,
    requested: string | undefined,
): AIProvider {
    const name = requested?.trim() || registry.defaultProvider;
    const canonical = LEGACY_ALIASES[name] ?? name;
    const provider = registry.providers.get(canonical);
    if (!provider) {
        throw new Error(
            `AI provider "${name}" is not registered. ` +
            `Known providers: ${[...registry.providers.keys()].join(', ')}`,
        );
    }
    return provider;
}

// ─── Completion (simple text request) ───────────────────────────────────────

export interface CompletionRequest {
    systemPrompt: string;
    userMessage: string;
    /** Override the provider's default model. */
    model?: string;
    /** Max output tokens (API providers). */
    maxTokens?: number;
    /** Working directory for CLI providers. */
    workdir?: string;
    logger: Logger;
}

export interface CompletionResult {
    text: string;
    model: string;
    provider: string;
    usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Run a one-shot text completion against the given provider.
 * Dispatches on `provider.kind` to the appropriate backend.
 */
export async function runCompletion(
    provider: AIProvider,
    request: CompletionRequest,
): Promise<CompletionResult> {
    const model = request.model || provider.defaultModel;
    if (!model) {
        throw new Error(
            `AI provider "${provider.name}" has no model (pass params.model or set default_model)`,
        );
    }

    switch (provider.kind) {
        case 'anthropic-api':
            return runAnthropicCompletion(provider, { ...request, model });
        case 'openai-compatible-api':
            return runOpenAICompletion(provider, { ...request, model });
        case 'cli':
            return runCliCompletion(provider, { ...request, model });
    }
}

/**
 * Run a completion with automatic fallback to alternative providers.
 * Tries the primary provider first, then each fallback in order.
 */
export async function runCompletionWithFallback(
    registry: AIProviderRegistry,
    providerName: string | undefined,
    request: CompletionRequest,
): Promise<CompletionResult> {
    const primary = resolveProvider(registry, providerName);
    const chain = [primary.name, ...registry.fallbackChain.filter(n => n !== primary.name)];

    let lastError: Error | undefined;
    for (const name of chain) {
        const provider = registry.providers.get(name)!;
        try {
            return await runCompletion(provider, request);
        } catch (err: any) {
            lastError = err;
            request.logger.warn(
                { provider: name, error: err.message },
                'AI provider failed, trying next fallback',
            );
        }
    }
    throw lastError ?? new Error('All AI providers failed');
}

/**
 * Run an agentic session with automatic fallback to alternative CLI providers.
 */
export async function runAgentWithFallback(
    registry: AIProviderRegistry,
    providerName: string | undefined,
    request: AgentRequest,
): Promise<AgentResult> {
    const primary = resolveProvider(registry, providerName);
    const chain = [primary.name, ...registry.fallbackChain.filter(n => n !== primary.name)];

    let lastError: Error | undefined;
    for (const name of chain) {
        const provider = registry.providers.get(name)!;
        if (provider.kind !== 'cli') continue;
        try {
            return await runAgent(provider, request);
        } catch (err: any) {
            lastError = err;
            request.logger.warn(
                { provider: name, error: err.message },
                'AI agent provider failed, trying next fallback',
            );
        }
    }
    throw lastError ?? new Error('All AI agent providers failed');
}

async function runAnthropicCompletion(
    provider: AIProvider,
    request: CompletionRequest & { model: string },
): Promise<CompletionResult> {
    if (!provider.apiKey) {
        throw new Error(
            `AI provider "${provider.name}" is missing api_key (set it in config or env var)`,
        );
    }

    const client = new Anthropic({
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });

    const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userMessage }],
    });

    const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');

    request.logger.info(
        {
            provider: provider.name,
            model: response.model,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        },
        'AI completion done (anthropic-api)',
    );

    return {
        text,
        model: response.model,
        provider: provider.name,
        usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
        },
    };
}

async function runOpenAICompletion(
    provider: AIProvider,
    request: CompletionRequest & { model: string },
): Promise<CompletionResult> {
    if (!provider.apiKey) {
        throw new Error(
            `AI provider "${provider.name}" is missing api_key (set it in config or env var)`,
        );
    }
    if (!provider.baseUrl) {
        // parseProvider guarantees this, but be defensive.
        throw new Error(`AI provider "${provider.name}" is missing base_url`);
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens ?? 4096,
            messages: [
                { role: 'system', content: request.systemPrompt },
                { role: 'user', content: request.userMessage },
            ],
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
            `OpenAI-compatible API ${provider.name} returned ${response.status}: ${body.slice(0, 500)}`,
        );
    }

    const data = (await response.json()) as {
        model?: string;
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage
        ? {
              input_tokens: data.usage.prompt_tokens ?? 0,
              output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;

    request.logger.info(
        {
            provider: provider.name,
            model: data.model ?? request.model,
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
        },
        'AI completion done (openai-compatible)',
    );

    return {
        text,
        model: data.model ?? request.model,
        provider: provider.name,
        usage,
    };
}

async function runCliCompletion(
    provider: AIProvider,
    request: CompletionRequest & { model: string },
): Promise<CompletionResult> {
    const args = buildCliArgs(provider.argsStyle!, {
        mode: 'completion',
        model: request.model,
        systemPrompt: request.systemPrompt,
    });

    // For opencode the system prompt isn't a flag — embed it in the user
    // message so review-template prompts still take effect.
    const stdinPayload = provider.argsStyle === 'opencode'
        ? `System instructions:\n${request.systemPrompt}\n\n---\n\n${request.userMessage}`
        : request.userMessage;

    const stdout = await spawnCli({
        command: provider.command!,
        args,
        env: provider.env,
        cwd: request.workdir,
        stdin: stdinPayload,
        logger: request.logger,
        providerName: provider.name,
    });

    request.logger.info(
        { provider: provider.name, model: request.model, outputLength: stdout.length },
        'AI completion done (cli)',
    );

    return {
        text: stdout.trim(),
        model: request.model,
        provider: provider.name,
    };
}

// ─── Agent (CLI tool-use / agentic mode) ────────────────────────────────────

export interface AgentRequest {
    prompt: string;
    /** Absolute path of the working directory the agent should run in. */
    workdir: string;
    /** Override the provider's default model. */
    model?: string;
    /** Tools the agent is allowed to use (CLI-specific semantics). */
    allowedTools?: string[];
    /** Output format hint ("text" or "json"). */
    outputFormat?: 'text' | 'json';
    logger: Logger;
}

export interface AgentResult {
    /** Raw stdout text from the CLI. */
    output: string;
    /** Parsed JSON if `outputFormat: 'json'` was set and parsing succeeded. */
    parsedJson?: unknown;
    model: string;
    provider: string;
}

/**
 * Run an agentic (tool-using) CLI session. Only `kind: 'cli'` providers
 * are supported — API-only providers would require us to implement the
 * whole tool-use loop ourselves, which is out of scope.
 */
export async function runAgent(
    provider: AIProvider,
    request: AgentRequest,
): Promise<AgentResult> {
    if (provider.kind !== 'cli') {
        throw new Error(
            `AI provider "${provider.name}" (kind="${provider.kind}") does not support agentic mode. ` +
            `Use a kind="cli" provider (claude-code, opencode, …) for ai-agent.`,
        );
    }

    const model = request.model || provider.defaultModel;
    if (!model) {
        throw new Error(
            `AI provider "${provider.name}" has no model (pass params.model or set default_model)`,
        );
    }

    const outputFormat = request.outputFormat ?? 'text';
    const args = buildCliArgs(provider.argsStyle!, {
        mode: 'agent',
        model,
        outputFormat,
        allowedTools: request.allowedTools ?? ['Read', 'Grep', 'Glob', 'LS'],
    });

    const stdout = await spawnCli({
        command: provider.command!,
        args,
        env: provider.env,
        cwd: request.workdir,
        stdin: request.prompt,
        logger: request.logger,
        providerName: provider.name,
    });

    request.logger.info(
        { provider: provider.name, model, outputLength: stdout.length },
        'AI agent done (cli)',
    );

    let parsedJson: unknown;
    if (outputFormat === 'json') {
        try {
            parsedJson = JSON.parse(stdout);
        } catch {
            request.logger.warn(
                { provider: provider.name },
                'Failed to parse agent output as JSON, returning raw text',
            );
        }
    }

    return {
        output: stdout.trim(),
        parsedJson,
        model,
        provider: provider.name,
    };
}

// ─── CLI arg builders ───────────────────────────────────────────────────────

interface CompletionArgsInput {
    mode: 'completion';
    model: string;
    systemPrompt: string;
}

interface AgentArgsInput {
    mode: 'agent';
    model: string;
    outputFormat: 'text' | 'json';
    allowedTools: string[];
}

type CliArgsInput = CompletionArgsInput | AgentArgsInput;

/**
 * Build argv for the given CLI style. Exported so unit tests can verify
 * the argument layout without spawning real processes.
 */
export function buildCliArgs(style: ArgsStyle, input: CliArgsInput): string[] {
    switch (style) {
        case 'claude-code':
            return buildClaudeCodeArgs(input);
        case 'opencode':
            return buildOpencodeArgs(input);
    }
}

function buildClaudeCodeArgs(input: CliArgsInput): string[] {
    if (input.mode === 'completion') {
        return [
            '--print',
            '--model', input.model,
            '--output-format', 'text',
            '--no-session-persistence',
            '--system-prompt', input.systemPrompt,
        ];
    }
    // agent
    return [
        '--print',
        '--model', input.model,
        '--output-format', input.outputFormat,
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        '--allowedTools', input.allowedTools.join(','),
    ];
}

/**
 * Opencode `run` subcommand. Opencode reads the prompt from stdin when no
 * positional argument is given. The `-m/--model` flag selects the model;
 * the exact model string is provider-configured (e.g. "glm-4.6", "anthropic/claude-sonnet-4").
 *
 * Note: opencode does not have a first-class `--system-prompt` flag
 * equivalent; we embed the system prompt into the user message in
 * `runCliCompletion`. Tool allowlisting also differs from Claude Code;
 * we do not pass an explicit allowlist and rely on opencode's own
 * config/permissions model.
 */
function buildOpencodeArgs(input: CliArgsInput): string[] {
    const args = ['run', '--model', input.model];
    if (input.mode === 'agent' && input.outputFormat === 'json') {
        args.push('--format', 'json');
    }
    return args;
}

// ─── Subprocess helper ──────────────────────────────────────────────────────

interface SpawnCliOptions {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin: string;
    logger: Logger;
    providerName: string;
}

function spawnCli(opts: SpawnCliOptions): Promise<string> {
    const { command, args, env, cwd, stdin, logger, providerName } = opts;

    // Merge provider-injected env on top of the current process env.
    // Provider env wins (that's the whole point — e.g. ANTHROPIC_BASE_URL).
    const mergedEnv = { ...process.env, ...(env ?? {}) };

    logger.debug(
        {
            provider: providerName,
            command,
            argsPreview: args.slice(0, 6),
            injectedEnvKeys: env ? Object.keys(env) : [],
            cwd: cwd ?? '(none)',
        },
        'Spawning AI CLI',
    );

    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            env: mergedEnv,
            cwd: cwd || undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err: Error) => {
            logger.error(
                { provider: providerName, command, err: err.message },
                'AI CLI spawn error',
            );
            reject(new Error(
                `AI provider "${providerName}" failed to spawn "${command}": ${err.message}`,
            ));
        });

        child.on('close', (code: number | null) => {
            const stdout = Buffer.concat(chunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');

            if (stderr) {
                logger.debug(
                    { provider: providerName, stderr: stderr.slice(0, 1000) },
                    'AI CLI stderr',
                );
            }

            if (code !== 0) {
                logger.error(
                    {
                        provider: providerName,
                        code,
                        stderr: stderr.slice(0, 500),
                        stdout: stdout.slice(0, 500),
                    },
                    'AI CLI exited with error',
                );
                reject(new Error(
                    `AI provider "${providerName}" (${command}) exited with code ${code}` +
                    (stderr ? `\nstderr: ${stderr.slice(0, 500)}` : '') +
                    (stdout ? `\nstdout: ${stdout.slice(0, 500)}` : ''),
                ));
                return;
            }

            resolve(stdout);
        });

        // Write payload via stdin (no arg size limit, no escaping headaches).
        child.stdin.on('error', (err) => {
            logger.debug({ provider: providerName, err: err.message }, 'stdin write error (child may have exited early)');
        });
        child.stdin.write(stdin);
        child.stdin.end();
    });
}
