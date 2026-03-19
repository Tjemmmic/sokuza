import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import type { ActionHandler } from '../core/types.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../core/diff-truncator.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_CLI_MODEL = 'opus';
const DEFAULT_MAX_TOKENS = 4096;

const DEFAULT_SYSTEM_PROMPT = `You are a senior staff engineer conducting a thorough, skeptical code review. Your job is to catch real bugs, security issues, and architectural mistakes BEFORE they reach production. Do NOT rubber-stamp this PR.

## What to Check
For every changed file, evaluate:
- **Bugs & logic errors**: Off-by-one, null derefs, wrong conditionals, unreachable code
- **Error handling**: Missing try/catch, unhandled rejections, swallowed errors
- **Security**: Injection, XSS, SSRF, path traversal, secrets in code, insecure defaults
- **Type safety**: Unsafe casts, \`any\` types hiding bugs, non-null assertions
- **Edge cases**: Null, undefined, empty arrays, zero, negative, very large inputs
- **Race conditions**: Concurrent access, TOCTOU, missing atomicity
- **Resource cleanup**: Unclosed handles, missing finally blocks, memory leaks
- **Breaking changes**: Changed API contracts, removed exports, altered return types

## Priority Levels
- **P1** (blocking): Bugs, crashes, security vulns, data loss, broken contracts
- **P2** (should fix): Missing error handling, untested logic, perf issues, validation gaps
- **P3** (nice to have): Readability, naming, minor duplication, docs

## Output Rules
- Each issue: priority emoji + level + title, then file:line, problem, and fix suggestion
- Reference SPECIFIC files and line numbers. No vague advice.
- No praise, no filler, no preamble. Issues only, then the decision.

## Decision (REQUIRED)
- \`✅ APPROVE\`: Zero P1s AND fewer than 3 P2s
- \`❌ CHANGES REQUESTED\`: Any P1, OR 3+ P2s (cumulative risk matters)

Be concrete, be skeptical, be helpful.`;

/**
 * "ai-review" action.
 *
 * Sends a code diff to Claude for review and returns the review text.
 * Supports two providers:
 *
 * 1. **"api"** (default) — direct Anthropic API via SDK
 * 2. **"claude-code"** — uses the `claude` CLI (for small diffs only)
 *
 * Large diffs are automatically truncated to fit within Claude's context.
 *
 * Params:
 *   - provider: "api" | "claude-code" (default: "api" if key available)
 *   - model: Claude model (default: "claude-sonnet-4-20250514" for API, "sonnet" for CLI)
 *   - prompt: System prompt for the review
 *   - diff: The code diff to review (auto-resolved from previous steps)
 *   - context: Optional additional context (PR title, description, etc.)
 *   - max_tokens: Max response tokens (default: 4096, API only)
 *   - max_diff_chars: Max diff characters before truncation (default: 100K)
 *   - api_key: Anthropic API key (API provider only)
 *
 * Returns: { review, model, provider, usage?, truncation? }
 */
export const aiReviewAction: ActionHandler = async (params, context) => {
    // ─── Resolve the diff ───────────────────────────────────────────────
    let diff = params.diff as string | undefined;

    if (!diff) {
        // Look through named step results for a diff field
        for (const result of Object.values(context.steps)) {
            if (result && typeof result === 'object' && 'diff' in (result as Record<string, unknown>)) {
                diff = (result as Record<string, unknown>).diff as string;
                break;
            }
        }
        // Fallback to numbered results
        if (!diff) {
            for (const result of Object.values(context.results)) {
                if (result && typeof result === 'object' && 'diff' in (result as Record<string, unknown>)) {
                    diff = (result as Record<string, unknown>).diff as string;
                    break;
                }
            }
        }
    }

    if (!diff) {
        throw new Error(
            'ai-review: no diff provided. Pass params.diff or run github-fetch-diff in a preceding step.',
        );
    }

    // ─── Truncate large diffs ───────────────────────────────────────────
    const maxDiffChars = (params.max_diff_chars as number) ?? DEFAULT_MAX_CHARS;
    const truncation = truncateDiff(diff, maxDiffChars);

    context.logger.info(
        {
            originalChars: truncation.originalChars,
            finalChars: truncation.finalChars,
            totalFiles: truncation.totalFiles,
            fullyIncluded: truncation.fullyIncludedFiles,
            truncated: truncation.truncatedFiles,
            skipped: truncation.skippedFiles,
        },
        truncation.originalChars !== truncation.finalChars
            ? 'Diff truncated for AI review'
            : 'Diff fits within budget',
    );

    // ─── Determine provider ─────────────────────────────────────────────
    const provider = resolveProvider(params);
    const systemPrompt = (params.prompt as string) ?? DEFAULT_SYSTEM_PROMPT;
    const additionalContext = params.context as string | undefined;

    // ─── Auto-extract PR context from event ─────────────────────────────
    const pr = context.event?.payload?.pull_request as Record<string, unknown> | undefined;
    const meta = context.event?.metadata as Record<string, unknown> | undefined;

    let autoContext = '';
    if (pr) {
        const parts: string[] = [];
        const title = pr.title as string | undefined;
        const number = pr.number ?? meta?.prNumber;
        const repo = meta?.repo as string | undefined;
        const author = (pr.user as Record<string, unknown>)?.login as string | undefined;
        const headRef = (pr.head as Record<string, unknown>)?.ref as string | undefined;
        const baseRef = (pr.base as Record<string, unknown>)?.ref as string | undefined;
        const labels = pr.labels as Array<{ name: string }> | undefined;
        const draft = pr.draft as boolean | undefined;

        if (repo) parts.push(`**Repository:** ${repo}`);
        if (number) parts.push(`**PR #${number}:** ${title ?? 'Untitled'}`);
        else if (title) parts.push(`**Title:** ${title}`);
        if (author) parts.push(`**Author:** ${author}`);
        if (headRef && baseRef) parts.push(`**Branch:** \`${headRef}\` → \`${baseRef}\``);
        if (labels?.length) parts.push(`**Labels:** ${labels.map(l => l.name).join(', ')}`);
        if (draft) parts.push(`**Status:** Draft`);

        if (parts.length > 0) {
            autoContext = parts.join('\n');
        }
    }

    // Build the user message with truncation summary
    let userMessage = '';
    if (truncation.originalChars !== truncation.finalChars) {
        userMessage += `> **Note:** This diff was truncated (${truncation.summary}). Focus on the code shown.\n\n`;
    }
    // Include auto-extracted context first, then any manual context
    const combinedContext = [autoContext, additionalContext].filter(Boolean).join('\n\n');
    if (combinedContext) {
        userMessage += `## PR Context\n${combinedContext}\n\n`;
    }
    userMessage += `## Diff\n\`\`\`diff\n${truncation.diff}\n\`\`\``;

    context.logger.info(
        { provider, promptLength: userMessage.length },
        'Sending diff to AI for review',
    );

    const workdir = params.workdir as string | undefined;

    const result = provider === 'claude-code'
        ? await reviewWithClaudeCode(
            userMessage,
            systemPrompt,
            (params.model as string) ?? DEFAULT_CLI_MODEL,
            context.logger,
            workdir,
        )
        : await reviewWithApi(
            userMessage,
            systemPrompt,
            (params.model as string) ?? DEFAULT_MODEL,
            (params.api_key as string) ?? process.env.ANTHROPIC_API_KEY!,
            (params.max_tokens as number) ?? DEFAULT_MAX_TOKENS,
            context.logger,
        );

    // Attach truncation metadata
    return {
        ...result,
        truncation: truncation.originalChars !== truncation.finalChars
            ? {
                summary: truncation.summary,
                originalChars: truncation.originalChars,
                finalChars: truncation.finalChars,
            }
            : undefined,
    };
};

// ─── Provider Resolution ────────────────────────────────────────────────────

function resolveProvider(params: Record<string, unknown>): 'api' | 'claude-code' {
    const explicit = params.provider as string | undefined;
    if (explicit === 'claude-code') return 'claude-code';
    if (explicit === 'api') return 'api';

    // Default to API if key is available, otherwise claude-code
    if (process.env.ANTHROPIC_API_KEY || params.api_key) return 'api';
    return 'claude-code';
}

// ─── Anthropic API Provider ─────────────────────────────────────────────────

async function reviewWithApi(
    userMessage: string,
    systemPrompt: string,
    model: string,
    apiKey: string,
    maxTokens: number,
    logger: import('pino').Logger,
) {
    if (!apiKey) {
        throw new Error(
            'ai-review (api provider): requires ANTHROPIC_API_KEY env var or params.api_key.',
        );
    }

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
    });

    const review = response.content
        .filter((block) => block.type === 'text')
        .map((block) => {
            if (block.type === 'text') return block.text;
            return '';
        })
        .join('\n');

    logger.info(
        {
            provider: 'api',
            model: response.model,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        },
        'AI review completed (API)',
    );

    return {
        review,
        model: response.model,
        provider: 'api' as const,
        usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
        },
    };
}

// ─── Claude Code CLI Provider ───────────────────────────────────────────────

async function reviewWithClaudeCode(
    userMessage: string,
    systemPrompt: string,
    model: string,
    logger: import('pino').Logger,
    workdir?: string,
) {
    const args = [
        '--print',
        '--model', model,
        '--output-format', 'text',
        '--no-session-persistence',
        '--system-prompt', systemPrompt,
    ];

    logger.info(
        { model, messageLength: userMessage.length, workdir: workdir ?? '(none)' },
        'Running Claude Code CLI',
    );

    return new Promise<{ review: string; model: string; provider: 'claude-code' }>((resolve, reject) => {
        const child = spawn('claude', args, {
            env: { ...process.env },
            cwd: workdir || undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err: Error) => {
            logger.error({ err: err.message }, 'Claude Code CLI spawn error');
            reject(new Error(`Claude Code CLI failed to spawn: ${err.message}`));
        });

        child.on('close', (code: number | null) => {
            const stdout = Buffer.concat(chunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');

            if (stderr) {
                logger.debug({ stderr: stderr.slice(0, 1000) }, 'Claude Code CLI stderr');
            }

            if (code !== 0) {
                logger.error(
                    { code, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) },
                    'Claude Code CLI exited with error',
                );
                reject(new Error(
                    `Claude Code CLI exited with code ${code}${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ''}${stdout ? `\nstdout: ${stdout.slice(0, 500)}` : ''}`,
                ));
                return;
            }

            const review = stdout.trim();

            logger.info(
                { provider: 'claude-code', model, reviewLength: review.length },
                'AI review completed (Claude Code CLI)',
            );

            resolve({
                review,
                model,
                provider: 'claude-code' as const,
            });
        });

        // Write the prompt to stdin (no size limit unlike CLI args)
        child.stdin.write(userMessage);
        child.stdin.end();
    });
}
