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
import { statSync, accessSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { abortErrorFromSignal } from './abort-error.js';
import { ARGS_STYLES, type ArgsStyle } from './args-styles.js';

/**
 * Quick non-blocking check that a CLI binary is on PATH.
 * Used by the dashboard to show "installed" / "not installed" badges
 * against CLI-kind providers (claude, opencode).
 */
export function isCliInstalled(command: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise<boolean>((resolveResult) => {
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolveResult(ok);
        };
        try {
            const child = spawn(command, ['--version'], { stdio: 'ignore' });
            child.on('error', () => done(false));
            child.on('close', (code) => done(code === 0));
            setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
                done(false);
            }, timeoutMs);
        } catch {
            done(false);
        }
    });
}

/**
 * Suggested model IDs per provider flavor. The dashboard uses these to
 * populate a datalist so users pick a valid string by default, but any
 * free-text value still works — new models ship all the time and we
 * don't want a stale allow-list blocking legitimate use.
 *
 * Organized by *endpoint flavor* rather than strictly by `kind`, because
 * the valid model-ID format depends on what's behind the endpoint:
 *
 *  - Anthropic direct  → "claude-sonnet-4-6", short aliases (sonnet/opus/haiku) work for CLI only
 *  - ZAI's Anthropic-compatible endpoint → plain "glm-4.6", "glm-5.1"
 *  - ZAI via opencode  → "zai-coding-plan/glm-4.6" (opencode's provider/model format)
 *  - OpenAI direct     → "gpt-4o-mini", etc.
 */

// Current Claude generation (Claude 4.x family) — both CLI short aliases
// and the full API model IDs are accepted by Claude Code; the API needs
// the full ID form.
const CLAUDE_API_MODELS = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
];

const CLAUDE_CLI_MODELS = [
    'sonnet',
    'opus',
    'haiku',
    ...CLAUDE_API_MODELS,
];

// ZAI GLM models, plain form — used by ZAI's Anthropic-compatible endpoint
// (`https://api.z.ai/api/anthropic`) and its OpenAI-compatible endpoint
// (`https://api.z.ai/api/paas/v4`).
const ZAI_GLM_MODELS = [
    'glm-5.1',
    'glm-5',
    'glm-5-turbo',
    'glm-4.7',
    'glm-4.6',
    'glm-4.5',
];

// Same GLM models under the opencode `zai-coding-plan/` provider prefix.
// Used as the fallback when `opencode models` can't run (e.g. binary
// missing). When the live probe succeeds its output supersedes this.
const OPENCODE_ZAI_FALLBACK = ZAI_GLM_MODELS.map((m) => `zai-coding-plan/${m}`);

const OPENAI_FALLBACK_MODELS = [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4-turbo',
];

// Best-effort suggestion lists for the Gemini / Codex CLIs. The model
// field is free-text, so these only seed the datalist — leave the field
// blank to use whichever model the CLI defaults to.
// Current Gemini 3.x first (verified resolvable via the CLI), then 2.5.
// Note: there is no `gemini-3.x-flash` / `gemini-3.5-flash` — the 3.x
// Flash tier is the `-lite` id below.
const GEMINI_MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-3-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
];

const CODEX_MODELS = [
    'gpt-5-codex',
    'gpt-5',
    'o4-mini',
    'o3',
];

function isZaiEndpoint(url: string | undefined): boolean {
    return !!url && /(?:^|\.)z\.ai(?:$|\/|:)/.test(url);
}

/**
 * Return model suggestions for a tentative provider configuration.
 *
 * For CLI providers we probe the binary when it's cheap and reliable
 * (`opencode models`). For API providers we hit the OpenAI-standard
 * `/v1/models` endpoint when credentials are supplied. Failures fall
 * back to the hardcoded lists so the UI always shows something useful.
 */
export async function listModelSuggestions(
    config: {
        kind: ProviderKind;
        command?: string;
        base_url?: string;
        api_key?: string;
        /** For CLI providers — env bag (ANTHROPIC_BASE_URL etc.). Detects ZAI redirect. */
        env?: Record<string, string>;
    },
): Promise<{ models: string[]; source: 'live' | 'hardcoded' | 'none'; note?: string }> {
    if (config.kind === 'cli') {
        if (config.command === 'opencode') {
            const live = await runOpencodeModelsCommand().catch(() => null);
            if (live && live.length > 0) {
                return { models: live, source: 'live' };
            }
            return {
                models: OPENCODE_ZAI_FALLBACK,
                source: 'hardcoded',
                note: 'Could not reach `opencode models` — install opencode and run `opencode providers` to configure credentials.',
            };
        }
        if (config.command === 'claude' || !config.command) {
            // If the CLI is being env-redirected at ZAI (e.g. the
            // zai-glm-agent preset), the valid model IDs are the GLM ones
            // served by ZAI's Anthropic-compatible endpoint — not Claude
            // IDs. Detect that by looking at the provider env bag.
            const envBaseUrl = config.env?.ANTHROPIC_BASE_URL;
            const zaiRedirect = isZaiEndpoint(envBaseUrl);
            return {
                models: zaiRedirect ? ZAI_GLM_MODELS : CLAUDE_CLI_MODELS,
                source: 'hardcoded',
            };
        }
        if (config.command === 'gemini') {
            return {
                models: GEMINI_MODELS,
                source: 'hardcoded',
                note: 'Best-effort list — leave blank for the CLI default, or type any Gemini model.',
            };
        }
        if (config.command === 'codex') {
            return {
                models: CODEX_MODELS,
                source: 'hardcoded',
                note: 'Best-effort list — leave blank for the CLI default, or type any model your Codex CLI supports.',
            };
        }
        return { models: [], source: 'none' };
    }

    if (config.kind === 'anthropic-api') {
        return {
            models: isZaiEndpoint(config.base_url) ? ZAI_GLM_MODELS : CLAUDE_API_MODELS,
            source: 'hardcoded',
        };
    }

    // openai-compatible-api — try live /v1/models if we have creds.
    if (config.base_url && config.api_key) {
        const live = await fetchOpenAICompatibleModels(config.base_url, config.api_key).catch(() => null);
        if (live && live.length > 0) {
            return { models: live, source: 'live' };
        }
    }
    return {
        models: isZaiEndpoint(config.base_url) ? ZAI_GLM_MODELS : OPENAI_FALLBACK_MODELS,
        source: 'hardcoded',
        note: config.base_url && config.api_key
            ? 'Could not fetch /v1/models from the endpoint — using common fallbacks.'
            : 'Enter base_url + api_key to load a live model list.',
    };
}

function runOpencodeModelsCommand(): Promise<string[]> {
    return new Promise((resolveResult, rejectResult) => {
        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        child.on('error', rejectResult);
        child.on('close', (code) => {
            if (code !== 0) {
                rejectResult(new Error(`opencode models exited ${code}: ${Buffer.concat(stderrChunks).toString('utf-8').slice(0, 200)}`));
                return;
            }
            const lines = Buffer.concat(chunks)
                .toString('utf-8')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l && l.includes('/'));
            resolveResult(lines);
        });
        setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            rejectResult(new Error('opencode models timed out'));
        }, 5000);
    });
}

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids;
}

/**
 * Mask a secret for UI display. `${VAR}` references are returned as-is
 * so the UI can render them with an "env var" badge; plaintext values
 * are truncated to `<prefix>…` so no full key ever reaches the browser.
 */
export function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.startsWith('${') && value.endsWith('}')) return value;
    if (value.length <= 8) return '••••';
    return `${value.slice(0, 6)}…${value.slice(-2)}`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProviderKind = 'anthropic-api' | 'openai-compatible-api' | 'cli';

/**
 * How CLI args are laid out for a given binary. Each style is a distinct
 * function in `buildCliArgs()` — add a new value here when adding a CLI.
 */
// `ArgsStyle` / `ARGS_STYLES` now live in the dependency-free `args-styles`
// module (so the API server can validate against them without importing
// this Anthropic-SDK-loading module). Re-exported here for back-compat
// with existing `from './ai-providers.js'` imports.
export { ARGS_STYLES };
export type { ArgsStyle };

export interface AIProvider {
    name: string;
    kind: ProviderKind;
    defaultModel?: string;
    apiKey?: string;
    baseUrl?: string;
    command?: string;
    env?: Record<string, string>;
    argsStyle?: ArgsStyle;
    _client?: Anthropic;
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

// ─── Auto-detected CLI providers ────────────────────────────────────────────

/**
 * Known CLI providers that should "just show up" when their binary is on
 * PATH, with no config required. Detected synchronously at registry-load
 * time (and surfaced in the dashboard provider list). A user-declared
 * provider with the same name always wins.
 *
 * `claude-code` and `anthropic` are registered unconditionally elsewhere
 * (they're the historical defaults), so they're not repeated here.
 */
const AUTODETECT_CLI_PROVIDERS: ReadonlyArray<{ name: string; command: string; argsStyle: ArgsStyle }> = [
    { name: 'gemini', command: 'gemini', argsStyle: 'gemini' },
    { name: 'codex', command: 'codex', argsStyle: 'codex' },
    { name: 'opencode', command: 'opencode', argsStyle: 'opencode' },
];

/**
 * Synchronous "is this command on PATH" check. Unlike `isCliInstalled`
 * (which spawns `cmd --version`), this just scans `PATH` for an executable
 * file, so it's safe to call from the synchronous `loadAIProviders`.
 */
// Short-TTL cache so `listImplicitProviders` (called per
// `GET /api/ai/providers`) doesn't re-stat the whole PATH on every
// request, while still picking up a newly-installed CLI within the TTL —
// unlike a permanent cache, which would need a restart.
const cmdExistsCache = new Map<string, { result: boolean; checkedAt: number }>();
const CMD_EXISTS_TTL_MS = 30_000;
// In practice this only ever holds a handful of provider command names, but
// bound it so a pathological caller can't grow it without limit.
const CMD_EXISTS_CACHE_MAX = 256;

export function commandExistsOnPath(command: string): boolean {
    if (!command) return false;
    const now = Date.now();
    const cached = cmdExistsCache.get(command);
    if (cached && now - cached.checkedAt < CMD_EXISTS_TTL_MS) return cached.result;
    const result = scanPathForCommand(command);
    // Cheap bound: the entries are TTL'd anyway, so on overflow just clear
    // and let it repopulate rather than maintaining an LRU.
    if (cmdExistsCache.size >= CMD_EXISTS_CACHE_MAX) cmdExistsCache.clear();
    cmdExistsCache.set(command, { result, checkedAt: now });
    return result;
}

/** A regular file that is also executable on POSIX (so a non-executable
 *  file sitting on PATH isn't reported as an installed CLI). On Windows,
 *  executability is encoded in the extension (PATHEXT), so isFile suffices. */
function isExecutableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        if (process.platform !== 'win32') accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function scanPathForCommand(command: string): boolean {
    const isWin = process.platform === 'win32';
    // An explicit path was given — check it directly.
    if (command.includes('/') || (isWin && command.includes('\\'))) {
        return isExecutableFile(command);
    }
    const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
    const dirs = (process.env.PATH ?? '').split(isWin ? ';' : ':');
    for (const rawDir of dirs) {
        const dir = rawDir.trim();
        if (!dir) continue; // skip empty and whitespace-only PATH entries
        for (const ext of exts) {
            if (isExecutableFile(join(dir, command + ext))) return true;
        }
    }
    return false;
}

/**
 * Built-in + auto-detected providers that should appear in the dashboard
 * even without an explicit `ai.providers` config entry: the two always-on
 * defaults plus any known CLI found on PATH. The dashboard merges these
 * with config-declared providers (config wins on name collision).
 */
export function listImplicitProviders(): Array<{ name: string; entry: Record<string, unknown> }> {
    const out: Array<{ name: string; entry: Record<string, unknown> }> = [
        { name: 'claude-code', entry: { kind: 'cli', command: 'claude', args_style: 'claude-code', default_model: 'sonnet' } },
        { name: 'anthropic', entry: { kind: 'anthropic-api', default_model: 'claude-sonnet-4-6' } },
    ];
    for (const p of AUTODETECT_CLI_PROVIDERS) {
        if (commandExistsOnPath(p.command)) {
            out.push({ name: p.name, entry: { kind: 'cli', command: p.command, args_style: p.argsStyle } });
        }
    }
    return out;
}

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
        defaultModel: 'claude-sonnet-4-6',
    });

    // ─── Auto-register known CLIs found on PATH ─────────────────────────
    // So `gemini`, `codex`, `opencode` "just work" as providers when
    // installed, without a config entry. User-declared providers (below)
    // override these by name.
    for (const known of AUTODETECT_CLI_PROVIDERS) {
        if (providers.has(known.name)) continue;
        if (commandExistsOnPath(known.command)) {
            providers.set(known.name, {
                name: known.name,
                kind: 'cli',
                command: known.command,
                argsStyle: known.argsStyle,
            });
        }
    }

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
        if (!ARGS_STYLES.includes(provider.argsStyle)) {
            throw new Error(
                `ai.providers.${name}.args_style must be one of: ${ARGS_STYLES.join(', ')}`,
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
    /** Sampling temperature (API providers). When undefined the provider's
     *  own default is used — we don't send the field at all. Higher values
     *  give more variation, which is what makes running the *same* provider
     *  twice in an ensemble produce genuinely different reviews. */
    temperature?: number;
    /** Working directory for CLI providers. */
    workdir?: string;
    logger: Logger;
    /** Workflow-level abort signal. When it fires:
     *   - API providers: the in-flight HTTP request is aborted via the
     *     SDK's / fetch's native AbortSignal plumbing.
     *   - CLI providers: the child process tree receives SIGTERM, then
     *     SIGKILL after a 1.5s grace.
     *  Required to honor `queue.defaults.timeout` and user-driven
     *  `POST /api/queue/jobs/:id/cancel` — without it, a workflow
     *  timeout / cancel leaves the underlying request running and the
     *  user keeps burning tokens or holding a CLI subprocess open. */
    signal?: AbortSignal;
}

export interface CompletionResult {
    text: string;
    model: string;
    provider: string;
    usage?: { input_tokens: number; output_tokens: number };
    /** True when the model stopped because it hit the max-output-token cap
     *  (Anthropic stop_reason `max_tokens` / OpenAI finish_reason `length`)
     *  rather than finishing naturally. The output is very likely cut off —
     *  for structured-JSON callers (ai.review, ensemble synthesis) that means
     *  a parse failure, so callers surface this instead of silently
     *  attributing it to a "bad model". Undefined for CLI providers, which
     *  don't report a stop reason. */
    truncated?: boolean;
}

/**
 * Run a one-shot text completion against the given provider.
 * Dispatches on `provider.kind` to the appropriate backend.
 */
/**
 * CLI styles whose binary selects a sensible default model when `-m` is
 * omitted (gemini, codex). For these we don't require an explicit model —
 * a blank model just lets the CLI pick. claude-code / opencode always need
 * an explicit model (`--model` / `-m` is mandatory).
 */
function cliStyleCanDefaultModel(provider: AIProvider): boolean {
    return provider.kind === 'cli'
        && (provider.argsStyle === 'gemini' || provider.argsStyle === 'codex');
}

export async function runCompletion(
    provider: AIProvider,
    request: CompletionRequest,
): Promise<CompletionResult> {
    // `|| ''` makes `model` a definite string. The guard below then
    // guarantees a NON-empty model for every kind except the gemini/codex
    // CLIs (which pick their own default when `-m` is omitted), so the
    // branches can pass `model` straight through — no non-null assertions.
    const model = request.model || provider.defaultModel || '';
    if (!model && !cliStyleCanDefaultModel(provider)) {
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
        // Abort check between providers — without this a workflow
        // timeout that fires while the primary's fetch is in flight
        // would still trigger the fallback chain, multiplying wall-clock
        // cost by the fan-out (e.g. claude → opencode → anthropic =
        // up to 3× the budget). Each provider's underlying call also
        // re-checks; this is the early-exit before the next attempt.
        if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
        const provider = registry.providers.get(name)!;
        try {
            return await runCompletion(provider, request);
        } catch (err: any) {
            // If the workflow was aborted during this provider's call,
            // surface the abort directly rather than logging "failed,
            // trying next fallback" and retrying — that would burn
            // through every remaining provider AFTER the user told us
            // to stop.
            if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
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
        if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
        const provider = registry.providers.get(name)!;
        if (provider.kind !== 'cli') continue;
        try {
            return await runAgent(provider, request);
        } catch (err: any) {
            if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
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

    if (!provider._client) {
        provider._client = new Anthropic({
            apiKey: provider.apiKey,
            ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
        });
    }

    // Honor the workflow signal — the Anthropic SDK accepts `signal` via
    // its second-arg request options. Without this, a workflow timeout
    // would unblock the runtime but the in-flight HTTP request would
    // still complete (or hang) in the background, burning the user's
    // API quota for output they'll never see.
    if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
    const response = await provider._client.messages.create(
        {
            model: request.model,
            max_tokens: request.maxTokens ?? 4096,
            // Only send temperature when the caller set one — otherwise let
            // the model keep its own default.
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            system: request.systemPrompt,
            messages: [{ role: 'user', content: request.userMessage }],
        },
        request.signal ? { signal: request.signal } : undefined,
    );

    const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');

    const truncated = response.stop_reason === 'max_tokens';
    if (truncated) {
        request.logger.warn(
            { provider: provider.name, model: response.model, maxTokens: request.maxTokens ?? 4096 },
            'AI completion hit the max_tokens cap — output is likely truncated; raise max_tokens on the node',
        );
    }

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
        truncated,
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

    // Honor the workflow signal — fetch supports it natively. Without
    // this, the HTTP socket would stay open until the OpenAI-compatible
    // provider responds even though the workflow has already been killed.
    if (request.signal?.aborted) throw abortErrorFromSignal(request.signal);
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
            // Only send temperature when set — otherwise the provider default.
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            messages: [
                { role: 'system', content: request.systemPrompt },
                { role: 'user', content: request.userMessage },
            ],
        }),
        signal: request.signal,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
            `OpenAI-compatible API ${provider.name} returned ${response.status}: ${body.slice(0, 500)}`,
        );
    }

    const data = (await response.json()) as {
        model?: string;
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage
        ? {
              input_tokens: data.usage.prompt_tokens ?? 0,
              output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;

    const truncated = data.choices?.[0]?.finish_reason === 'length';
    if (truncated) {
        request.logger.warn(
            { provider: provider.name, model: data.model ?? request.model, maxTokens: request.maxTokens ?? 4096 },
            'AI completion hit the max_tokens cap — output is likely truncated; raise max_tokens on the node',
        );
    }

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
        truncated,
    };
}

/**
 * An empty, throwaway directory used as the cwd for CLI completions that
 * have no workdir of their own. The CLI providers (gemini, codex, …) are
 * agentic and we pass directory-trust bypass flags; running them in an
 * isolated empty dir — instead of inheriting the daemon's cwd (which may
 * be a real project / repo) — means a prompt-injected model that tries a
 * file/shell tool finds nothing sensitive and has nowhere to write. We're
 * using these providers purely for inference, so they need no real cwd.
 * Best-effort: if the dir can't be created we fall back to no cwd.
 */
let _cliSandboxDir: string | undefined;
function cliSandboxDir(): string | undefined {
    if (_cliSandboxDir) return _cliSandboxDir;
    try {
        const dir = join(homedir(), '.sokuza', 'cli-sandbox');
        mkdirSync(dir, { recursive: true });
        _cliSandboxDir = dir;
        return dir;
    } catch {
        return undefined;
    }
}

async function runCliCompletion(
    provider: AIProvider,
    request: CompletionRequest & { model: string },
): Promise<CompletionResult> {
    const fullPrompt = provider.argsStyle === 'claude-code'
        // Claude Code takes the system prompt via `--system-prompt`. Every
        // other CLI (opencode, gemini, codex) has no such flag, so we fold
        // the instructions into the user message so review-template prompts
        // still take effect.
        ? request.userMessage
        : `System instructions:\n${request.systemPrompt}\n\n---\n\n${request.userMessage}`;

    const invocation = buildCliInvocation(provider.argsStyle!, {
        mode: 'completion',
        model: request.model,
        systemPrompt: request.systemPrompt,
    }, fullPrompt);

    const stdout = await spawnCli({
        command: provider.command!,
        args: invocation.args,
        env: provider.env,
        // Inference-only: run in an isolated empty sandbox unless a real
        // workdir (e.g. a PR clone) was wired in.
        cwd: request.workdir || cliSandboxDir(),
        stdin: invocation.stdin,
        logger: request.logger,
        providerName: provider.name,
        signal: request.signal,
    });

    const text = extractCliText(provider.argsStyle!, stdout);

    request.logger.info(
        { provider: provider.name, model: request.model, outputLength: text.length },
        'AI completion done (cli)',
    );

    return {
        text,
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
    /** See `CompletionRequest.signal`. The CLI subprocess receives
     *  SIGTERM then SIGKILL after a 1.5s grace when this fires. */
    signal?: AbortSignal;
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

    const model = request.model || provider.defaultModel || '';
    if (!model && !cliStyleCanDefaultModel(provider)) {
        throw new Error(
            `AI provider "${provider.name}" has no model (pass params.model or set default_model)`,
        );
    }

    const outputFormat = request.outputFormat ?? 'text';
    const invocation = buildCliInvocation(provider.argsStyle!, {
        mode: 'agent',
        model,
        outputFormat,
        allowedTools: request.allowedTools ?? ['Read', 'Grep', 'Glob', 'LS'],
    }, request.prompt);

    const stdout = await spawnCli({
        command: provider.command!,
        args: invocation.args,
        env: provider.env,
        cwd: request.workdir,
        stdin: invocation.stdin,
        logger: request.logger,
        providerName: provider.name,
        signal: request.signal,
    });

    const text = extractCliText(provider.argsStyle!, stdout);

    request.logger.info(
        { provider: provider.name, model, outputLength: text.length },
        'AI agent done (cli)',
    );

    let parsedJson: unknown;
    if (outputFormat === 'json') {
        // For claude-code we asked the CLI itself for JSON output, so
        // `text` IS the JSON. For opencode we always run in JSONL event
        // mode and extracted the model's text above — if the user asked
        // for JSON, the model's text should itself be parseable JSON.
        try {
            parsedJson = JSON.parse(text);
        } catch {
            request.logger.warn(
                { provider: provider.name },
                'Failed to parse agent output as JSON, returning raw text',
            );
        }
    }

    return {
        output: text.trim(),
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
 * Full CLI invocation: argv plus whatever should go to stdin (or `null`
 * when the prompt rides as a positional arg instead). Callers use this
 * to spawn the process with both bits lined up correctly.
 *
 * Exported so unit tests can verify the invocation without spawning
 * real processes.
 */
export interface CliInvocation {
    args: string[];
    /** Payload to pipe to stdin, or null when the prompt is in argv. */
    stdin: string | null;
}

export function buildCliInvocation(
    style: ArgsStyle,
    input: CliArgsInput,
    prompt: string,
): CliInvocation {
    switch (style) {
        case 'claude-code':
            // Claude Code reads the user message from stdin regardless of
            // completion vs agent mode — no arg-size concerns.
            return { args: buildClaudeCodeArgs(input), stdin: prompt };
        case 'opencode': {
            // Opencode `run` takes the message as a positional argument;
            // stdin is ignored. Large diffs are already truncated to
            // ~100KB by DEFAULT_MAX_CHARS so ARG_MAX (typically 2MB) is
            // not a concern.
            const args = buildOpencodeArgs(input);
            args.push(prompt);
            return { args, stdin: null };
        }
        case 'gemini': {
            // Gemini CLI headless mode: the prompt is the value of `-p`.
            const args = buildGeminiArgs(input);
            args.push('-p', prompt);
            return { args, stdin: null };
        }
        case 'codex': {
            // Codex `exec` takes the message as a positional argument.
            const args = buildCodexArgs(input);
            args.push(prompt);
            return { args, stdin: null };
        }
    }
}

/**
 * Legacy entry point retained so the existing unit tests in
 * `ai-providers.test.ts` keep passing without modification. New callers
 * should use `buildCliInvocation` since it also handles stdin vs positional
 * prompt delivery, which differs per CLI.
 */
export function buildCliArgs(style: ArgsStyle, input: CliArgsInput): string[] {
    switch (style) {
        case 'claude-code':
            return buildClaudeCodeArgs(input);
        case 'opencode':
            return buildOpencodeArgs(input);
        case 'gemini':
            return buildGeminiArgs(input);
        case 'codex':
            return buildCodexArgs(input);
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
 * Opencode `run` subcommand.
 *
 * - Prompt is a positional arg (caller appends it in `buildCliInvocation`).
 * - `-m provider/model` is required (e.g. `zai-coding-plan/glm-5.1`). The
 *   provider name comes from opencode's own `opencode providers` config,
 *   not from sokuza.
 * - We always use `--format json` because opencode's default "pretty"
 *   output writes the whole TUI experience (headers, ANSI) to stdout,
 *   which is unusable for programmatic capture. `extractCliText`
 *   re-assembles the model's text from the JSONL event stream.
 * - `--dangerously-skip-permissions` is required for non-interactive
 *   tool use in agent mode; otherwise opencode blocks on permission
 *   prompts it can't render without a TTY.
 */
function buildOpencodeArgs(input: CliArgsInput): string[] {
    const args = ['run', '--model', input.model, '--format', 'json'];
    if (input.mode === 'agent') {
        args.push('--dangerously-skip-permissions');
    }
    return args;
}

/**
 * Gemini CLI headless completion.
 *
 * - `-o text` → the model's answer verbatim on stdout (the "256-color"
 *   hint and other chatter go to stderr, which we don't capture).
 * - `-m <model>` only when a model is set; otherwise the CLI uses its own
 *   default (auto-detected providers ship with no `default_model`).
 * - No `--system-prompt` flag and no separate agent mode — the caller
 *   folds the system prompt into the user message, and the prompt rides as
 *   the value of `-p` (appended in `buildCliInvocation`).
 * - `--skip-trust`: newer Gemini CLIs refuse to run in a directory they
 *   haven't "trusted" (a headless-safety gate) and exit non-zero. We run
 *   non-interactively in the daemon's cwd (or a clone we made), so trust
 *   it for the session — otherwise reviews fail with "not running in a
 *   trusted directory".
 */
function buildGeminiArgs(input: CliArgsInput): string[] {
    const args = ['-o', 'text', '--skip-trust'];
    if (input.model) args.push('-m', input.model);
    return args;
}

/**
 * Codex `exec` headless completion.
 *
 * - `exec --json` → a JSONL event stream re-assembled by `extractCliText`.
 * - `-m <model>` only when set.
 * - `--skip-git-repo-check`: newer Codex CLIs refuse `exec` outside a
 *   trusted git repo ("Not inside a trusted directory and
 *   --skip-git-repo-check was not specified") and exit non-zero. We run
 *   non-interactively for a completion, so skip that gate.
 * - Agent mode adds `--dangerously-bypass-approvals-and-sandbox` so tool
 *   use isn't blocked on approval prompts Codex can't render without a TTY
 *   (mirrors opencode's `--dangerously-skip-permissions`).
 */
function buildCodexArgs(input: CliArgsInput): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (input.model) args.push('-m', input.model);
    if (input.mode === 'agent') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
        // Completion is inference-only: restrict any command the model
        // issues to a read-only sandbox (no writes, no network).
        args.push('--sandbox', 'read-only');
    }
    return args;
}

/**
 * Turn raw CLI stdout into the model's plain-text response.
 *
 * - Claude Code's `--output-format text` already gives us the answer
 *   verbatim — we just trim it.
 * - Opencode emits JSONL events: `step_start`, `text`, `reasoning`,
 *   `tool_use`, `step_finish`, `error`. The model's reply is the
 *   concatenation of all `{type: "text"}` event parts. Non-JSON lines
 *   are ignored so any stray log lines don't poison the output.
 *
 * Fallback for the "no text events" case: opencode can exit 0 but emit
 * only `error` events (provider hiccup mid-stream, model gave up before
 * producing text). Without surfacing those, the caller sees `""` and
 * the workflow silently posts an empty review comment. When no `text`
 * events exist but `error` events do, return their messages prefixed
 * so the user sees what actually went wrong.
 */
export function extractCliText(style: ArgsStyle, raw: string): string {
    // Plain-text styles: Claude Code's `--output-format text` and Gemini's
    // `-o text` both print the answer verbatim on stdout.
    if (style === 'claude-code' || style === 'gemini') {
        return raw.trim();
    }
    if (style === 'codex') {
        return extractCodexText(raw);
    }
    // opencode
    const textParts: string[] = [];
    const errorMessages: string[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const evt = JSON.parse(trimmed) as Record<string, unknown>;
            if (evt.type === 'text') {
                const part = evt.part as { text?: unknown } | undefined;
                if (part && typeof part.text === 'string') {
                    textParts.push(part.text);
                }
            } else if (evt.type === 'error') {
                // Shape: { type: "error", error: { name, data: { message } } }
                const err = evt.error as { name?: unknown; data?: { message?: unknown } } | undefined;
                const msg = err?.data && typeof err.data.message === 'string'
                    ? err.data.message
                    : typeof err?.name === 'string' ? err.name
                    : 'unknown error';
                errorMessages.push(msg);
            }
        } catch {
            // Not JSON — ignore (could be a prelude log line).
        }
    }
    if (textParts.length > 0) {
        return textParts.join('').trim();
    }
    if (errorMessages.length > 0) {
        // Sentinel-tagged so downstream parsers (ai-review's structured-
        // review parser, the empty-output guard) can recognise this as
        // a CLI-surfaced error rather than free-form model text.
        return `[opencode-error] ${errorMessages.join('; ')}`;
    }
    return '';
}

/**
 * Codex `exec --json` event stream → model text. Codex emits JSONL:
 * `thread.started`, `turn.started`, `text` (the assistant's text, carried
 * directly on `.text`), `item.completed` (whose `item.text` holds an
 * assistant message), `error` (`.message`), and `turn.failed`
 * (`.error.message`). The reply is the concatenation of the text events;
 * if there's no text but errors exist, surface them with a sentinel so the
 * empty-output guard recognises a CLI-surfaced failure.
 */
function extractCodexText(raw: string): string {
    const textParts: string[] = [];
    const errorMessages: string[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const evt = JSON.parse(trimmed) as Record<string, unknown>;
            if (evt.type === 'text' && typeof evt.text === 'string') {
                textParts.push(evt.text);
            } else if (evt.type === 'item.completed') {
                const item = evt.item as { type?: unknown; text?: unknown } | undefined;
                if (item && typeof item.text === 'string'
                    && (item.type === 'assistant_message' || item.type === 'agent_message')) {
                    textParts.push(item.text);
                }
            } else if (evt.type === 'error' && typeof evt.message === 'string') {
                errorMessages.push(evt.message);
            } else if (evt.type === 'turn.failed') {
                const err = evt.error as { message?: unknown } | undefined;
                if (err && typeof err.message === 'string') errorMessages.push(err.message);
            }
        } catch {
            // Not JSON — ignore.
        }
    }
    if (textParts.length > 0) return textParts.join('').trim();
    if (errorMessages.length > 0) return `[codex-error] ${errorMessages.join('; ')}`;
    return '';
}

// ─── Subprocess helper ──────────────────────────────────────────────────────

interface SpawnCliOptions {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Payload for stdin. `null` closes stdin without writing (prompt rides in argv). */
    stdin: string | null;
    logger: Logger;
    providerName: string;
    /** When this fires (workflow timeout / dashboard cancel), the child
     *  process tree is SIGTERM'd immediately and SIGKILL'd after
     *  `SIGKILL_BACKSTOP_MS`. The spawnCli promise rejects with
     *  `abortErrorFromSignal(signal)` so callers see a "Workflow timed
     *  out / cancelled" message rather than a confusing "exited with
     *  code null" trail. */
    signal?: AbortSignal;
}

/** Grace period between SIGTERM and the fallback SIGKILL. Mirrors the
 *  shell-exec backstop. AI CLIs (claude, opencode) exit cleanly on
 *  SIGTERM within ~100ms; 1.5s is plenty for the well-behaved case while
 *  still keeping a misbehaving child from outliving the workflow. */
const SIGKILL_BACKSTOP_MS = 1500;

/** Exported for the abort/SIGTERM-escalation regression test. Production
 *  callers go through `runCompletion` / `runAgent`. */
export function spawnCli(opts: SpawnCliOptions): Promise<string> {
    const { command, args, env, cwd, stdin, logger, providerName, signal } = opts;

    // Pre-abort guard: caller already aborted before we even tried to
    // spawn. Reject without launching anything.
    if (signal?.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }

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

    const isWindows = process.platform === 'win32';

    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            env: mergedEnv,
            cwd: cwd || undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
            // POSIX: become process-group leader so we can SIGTERM the
            // whole tree on abort, not just the direct child. Necessary
            // when the CLI exec()s helpers (claude → claude-helper, etc.)
            // — without this, killing only the parent leaves grandchildren
            // running until they finish their own work. Mirrors the
            // pattern used by shell-exec.ts.
            detached: !isWindows,
            windowsHide: true,
        });

        let killTimer: NodeJS.Timeout | null = null;
        let settled = false;

        // Kill the entire process tree. Best-effort: ESRCH means the
        // target is already gone (clean), EPERM means the kernel
        // dropped the right and there's nothing useful we can do.
        const killTree = (sig: 'SIGTERM' | 'SIGKILL'): void => {
            if (!child.pid) return;
            try {
                if (isWindows) {
                    // Windows has no process groups; best-effort
                    // terminate the parent. Same trade-off as
                    // shell-exec: a more complete fix would shell out
                    // to taskkill /F /T, but the AI CLIs we wrap don't
                    // commonly grandchild on Windows.
                    process.kill(child.pid, sig);
                } else {
                    process.kill(-child.pid, sig);
                }
            } catch {
                // ESRCH / EPERM — child is gone or we don't have the
                // right. Either way the caller still gets the rejection
                // below.
            }
        };

        const onAbort = () => {
            if (settled) return;
            settled = true;
            killTree('SIGTERM');
            // Schedule SIGKILL as a backstop. Without this a CLI that
            // ignores SIGTERM (rare but possible — buggy wrapper script,
            // forked daemon) would keep running and the user would
            // continue paying for it.
            killTimer = setTimeout(() => killTree('SIGKILL'), SIGKILL_BACKSTOP_MS);
            signal?.removeEventListener('abort', onAbort);
            reject(abortErrorFromSignal(signal!));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err: Error) => {
            if (settled) {
                // We already rejected via abort and scheduled the
                // SIGKILL backstop; the child errored out before the
                // backstop window. Cancel the timer now to free the
                // event loop, matching the `close` handler's behavior.
                // Without this, an aborted-then-errored spawn would
                // leave a ~1.5s pending setTimeout hanging onto the
                // event loop trying to SIGKILL an already-exited PID
                // — harmless but wasteful.
                if (killTimer) clearTimeout(killTimer);
                return;
            }
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener('abort', onAbort);
            logger.error(
                { provider: providerName, command, err: err.message },
                'AI CLI spawn error',
            );
            reject(new Error(
                `AI provider "${providerName}" failed to spawn "${command}": ${err.message}`,
            ));
        });

        child.on('close', (code: number | null) => {
            if (settled) {
                // We already rejected via abort. Free the SIGKILL timer
                // now that the child has exited so the event loop can
                // drain — otherwise it lingers until SIGKILL_BACKSTOP_MS.
                if (killTimer) clearTimeout(killTimer);
                return;
            }
            settled = true;
            signal?.removeEventListener('abort', onAbort);

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

        child.stdin.on('error', (err) => {
            logger.debug({ provider: providerName, err: err.message }, 'stdin write error (child may have exited early)');
        });
        if (stdin !== null) {
            child.stdin.write(stdin);
        }
        child.stdin.end();
    });
}
