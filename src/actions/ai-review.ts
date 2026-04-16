import type { ActionHandler } from '../core/types.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../core/diff-truncator.js';
import { generateCodeReviewPrompt } from './review-templates.js';
import { runCompletionWithFallback } from '../core/ai-providers.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Legacy system prompt maintained for backward compatibility.
 * New workflows should use generateCodeReviewPrompt() from review-templates.ts.
 */
const DEFAULT_SYSTEM_PROMPT = generateCodeReviewPrompt();

/**
 * "ai-review" action.
 *
 * Sends a code diff to the configured AI provider for review and returns
 * the review text. The provider is looked up from the registry built at
 * startup from the `ai:` block of `sokuza.config.yaml` (see
 * `src/core/ai-providers.ts`), so any Anthropic-API, OpenAI-compatible,
 * or CLI provider works without action-level changes.
 *
 * Large diffs are automatically truncated to fit within the model's
 * context budget.
 *
 * Params:
 *   - provider: Registered provider name (e.g. "anthropic", "zai-glm",
 *               "claude-code"). Falls back to the registry default.
 *               Legacy values "api" and "claude-code" still work.
 *   - model: Model override (defaults to provider.defaultModel)
 *   - prompt: System prompt for the review
 *   - diff: The code diff to review (auto-resolved from previous steps)
 *   - context: Optional additional context (PR title, description, etc.)
 *   - max_tokens: Max response tokens (API providers, default 4096)
 *   - max_diff_chars: Max diff characters before truncation
 *   - workdir: CWD for CLI providers
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

    const diffSource = resolveDiffSource(context);
    const incompleteFiles = resolveIncompleteFiles(context);

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

    // ─── Resolve provider via registry ──────────────────────────────────
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
    if (diffSource === 'file-patches') {
        userMessage += '> **Note:** The full diff was too large to fetch in one piece. This diff was assembled from individual file patches. Some context between files may be missing.\n\n';
    } else if (diffSource === 'summary') {
        userMessage += '> **Note:** The diff was too large to fetch even as individual file patches. Only a file-level summary is shown. Read the files directly for full details.\n\n';
    }
    if (incompleteFiles.length > 0) {
        userMessage += `> **Note:** The following files had patches too large to include: ${incompleteFiles.map((f) => `\`${f}\``).join(', ')}. Read these files directly if they are relevant.\n\n`;
    }
    // Include auto-extracted context first, then any manual context
    const combinedContext = [autoContext, additionalContext].filter(Boolean).join('\n\n');
    if (combinedContext) {
        userMessage += `## PR Context\n${combinedContext}\n\n`;
    }
    userMessage += `## Diff\n\`\`\`diff\n${truncation.diff}\n\`\`\``;

    context.logger.info(
        { promptLength: userMessage.length },
        'Sending diff to AI for review',
    );

    const completion = await runCompletionWithFallback(context.ai, params.provider as string | undefined, {
        systemPrompt,
        userMessage,
        model: params.model as string | undefined,
        maxTokens: (params.max_tokens as number) ?? DEFAULT_MAX_TOKENS,
        workdir: params.workdir as string | undefined,
        logger: context.logger,
    });

    return {
        review: completion.text,
        model: completion.model,
        provider: completion.provider,
        usage: completion.usage,
        truncation: truncation.originalChars !== truncation.finalChars
            ? {
                summary: truncation.summary,
                originalChars: truncation.originalChars,
                finalChars: truncation.finalChars,
            }
            : undefined,
    };
};

function resolveDiffSource(context: { steps: Record<string, unknown>; results: Record<string | number, unknown> }): string | undefined {
    for (const result of Object.values(context.steps)) {
        if (result && typeof result === 'object' && 'diff_source' in (result as Record<string, unknown>)) {
            return (result as Record<string, unknown>).diff_source as string;
        }
    }
    for (const result of Object.values(context.results)) {
        if (result && typeof result === 'object' && 'diff_source' in (result as Record<string, unknown>)) {
            return (result as Record<string, unknown>).diff_source as string;
        }
    }
    return undefined;
}

function resolveIncompleteFiles(context: { steps: Record<string, unknown>; results: Record<string | number, unknown> }): string[] {
    for (const result of Object.values(context.steps)) {
        if (result && typeof result === 'object' && 'incomplete_files' in (result as Record<string, unknown>)) {
            const files = (result as Record<string, unknown>).incomplete_files;
            if (Array.isArray(files)) return files as string[];
        }
    }
    for (const result of Object.values(context.results)) {
        if (result && typeof result === 'object' && 'incomplete_files' in (result as Record<string, unknown>)) {
            const files = (result as Record<string, unknown>).incomplete_files;
            if (Array.isArray(files)) return files as string[];
        }
    }
    return [];
}
