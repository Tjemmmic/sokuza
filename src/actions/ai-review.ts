import type { ActionHandler } from '../core/types.js';
import { truncateDiff, DEFAULT_MAX_CHARS } from '../core/diff-truncator.js';
import {
    parseStructuredReviewExt,
    renderReviewMarkdown,
    buildRepairPrompt,
    type ParseFailureKind,
} from './review-templates.js';
import { getDefaultPrompt } from './default-prompts.js';
import { runCompletionWithFallback } from '../core/ai-providers.js';
import {
    recordAiReviewRun,
    generateRunId,
    sha1,
} from '../core/run-store.js';
import { extractEventInfo } from './_event-info.js';

const DEFAULT_MAX_TOKENS = 4096;

/** Coerce a node-config value to a finite number, or undefined when blank /
 *  unset / non-numeric. Node number-controls usually yield a number, but a
 *  hand-written YAML config can pass a string ("0.7") or empty string. */
function parseOptionalNumber(raw: unknown): number | undefined {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/**
 * Default system prompt — sourced through `default-prompts.ts` so the
 * visual editor's "Load default" button (which hits the same registry
 * via `GET /api/ai/defaults/:source`) shows the exact text the action
 * runs when the `prompt` port is left blank. If these ever diverge, the
 * user is being lied to about what the action will do.
 */
const DEFAULT_SYSTEM_PROMPT = getDefaultPrompt('ai-review-system-prompt') ?? '';

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
    const runId = generateRunId();
    const startedAt = Date.now();
    const createdAt = new Date(startedAt).toISOString();

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

    // Fields shared between the success record and the fallback error
    // record — computed once so the two terminal paths diverge only in
    // the completion-derived fields.
    const recordStub = {
        id: runId,
        action: 'ai-review' as const,
        createdAt,
        workflowName: context.workflowName,
        event: extractEventInfo(context.event),
        strategy: 'truncate' as const,
        input: {
            diffSource,
            diffBytes: diff.length,
            diffSha1: sha1(diff),
            incompleteFiles,
        },
        truncation: {
            triggered: truncation.originalChars !== truncation.finalChars,
            originalChars: truncation.originalChars,
            finalChars: truncation.finalChars,
            totalFiles: truncation.totalFiles,
            fullyIncludedFiles: truncation.fullyIncludedFiles,
            truncatedFiles: truncation.truncatedFiles,
            skippedFiles: truncation.skippedFiles,
            files: truncation.files,
        },
    };

    // Optional sampling temperature. Coerced so a string config ("0.7")
    // doesn't reach the API verbatim; blank/invalid → undefined (provider
    // default). The headline use is same-provider ensemble legs: bump this
    // so two `provider: kimi` nodes don't return near-identical reviews.
    const temperature = parseOptionalNumber(params.temperature);

    let completion: Awaited<ReturnType<typeof runCompletionWithFallback>>;
    try {
        completion = await runCompletionWithFallback(context.ai, params.provider as string | undefined, {
            systemPrompt,
            userMessage,
            model: params.model as string | undefined,
            maxTokens: (params.max_tokens as number) ?? DEFAULT_MAX_TOKENS,
            temperature,
            workdir: params.workdir as string | undefined,
            logger: context.logger,
            // Forward the workflow abort signal so a queue timeout /
            // dashboard cancel actually interrupts the in-flight AI call
            // (HTTP request aborted, CLI subprocess SIGTERM'd) instead
            // of letting the workflow's runtime race abandon the promise
            // while the underlying provider keeps consuming tokens.
            signal: context.signal,
        });
    } catch (err) {
        await recordAiReviewRun(
            {
                ...recordStub,
                durationMs: Date.now() - startedAt,
                provider: (params.provider as string | undefined) || '(unresolved)',
                model: (params.model as string | undefined) ?? '',
                output: { parseSucceeded: false, reviewChars: 0 },
                error: err instanceof Error ? err.message : String(err),
            },
            context.logger,
        );
        throw err;
    }

    // The model is instructed to emit structured JSON; we render it into
    // markdown here so the posted comment has consistent formatting
    // regardless of how well the model obeyed its rules about headings,
    // fences, etc. If parsing fails, fall back to the raw text so users
    // still get *something* — but log loudly so we notice the drift.
    // A length-capped completion almost always means cut-off JSON below.
    // Surface the real cause here so a parse failure isn't mistaken for a
    // misbehaving model — the fix is a higher `max_tokens`, not a new model.
    if (completion.truncated) {
        context.logger.warn(
            { provider: completion.provider, model: completion.model },
            'ai-review completion was truncated at max_tokens; the review may be incomplete and JSON parsing may fail. Raise the node\'s max_tokens.',
        );
    }

    let parseResult = parseStructuredReviewExt(completion.text);
    let parsed = parseResult.review;
    const repairAttempts: Array<{ kind: ParseFailureKind; rawSample: string }> = [];

    // Repair loop. The agent's first attempt may have produced exploration
    // text without converging, malformed JSON, or valid JSON in the wrong
    // shape. All three are usually fixable by a focused follow-up: feed
    // the previous output back in and ask for clean JSON only.
    //
    // Bounded by `parse_repair_retries` (default 1). Each retry is a fresh
    // completion call with the same provider, so cost/latency scale with
    // the cap. Catastrophic failures (provider error, no output at all)
    // are not retried since they indicate something deeper than format.
    const maxRepairs = Math.max(0, (params.parse_repair_retries as number) ?? 1);
    let attemptText = completion.text;
    for (let attempt = 1; attempt <= maxRepairs && !parsed && parseResult.failureKind; attempt++) {
        // Bail before the next repair if the workflow has been aborted.
        // Without this, a 5-minute timeout that lands mid-review would
        // still trigger up to `parse_repair_retries` more completions,
        // multiplying token spend on a workflow the user already gave
        // up on.
        if (context.signal?.aborted) {
            context.logger.warn({ attempt, maxRepairs }, 'Workflow aborted during repair loop; bailing');
            break;
        }
        if (!attemptText.trim()) break; // nothing to repair from
        repairAttempts.push({
            kind: parseResult.failureKind,
            rawSample: attemptText.slice(0, 5000),
        });
        const repair = buildRepairPrompt(attemptText, parseResult.failureKind);
        context.logger.warn(
            {
                provider: completion.provider,
                model: completion.model,
                failureKind: parseResult.failureKind,
                attempt,
                maxRepairs,
            },
            'Parse failed; running repair completion to recover JSON',
        );
        try {
            const repairCompletion = await runCompletionWithFallback(
                context.ai,
                params.provider as string | undefined,
                {
                    systemPrompt: repair.systemPrompt,
                    userMessage: repair.userMessage,
                    model: params.model as string | undefined,
                    maxTokens: (params.max_tokens as number) ?? DEFAULT_MAX_TOKENS,
                    temperature,
                    workdir: params.workdir as string | undefined,
                    logger: context.logger,
                    signal: context.signal,
                },
            );
            // Don't let an empty repair erase the previous attempt's
            // text. The previous behavior overwrote `attemptText` with
            // `""`, which then short-circuited `attemptText ||
            // completion.text` and resurrected the original incoherent
            // text as the posted "review" (the PR #13 case: 1221 chars
            // of opencode exploration narration). Keep the last
            // non-empty model output around so the rawSample debug
            // captures the more-recent attempt when one exists.
            if (repairCompletion.text.trim()) {
                attemptText = repairCompletion.text;
            }
            parseResult = parseStructuredReviewExt(repairCompletion.text);
            parsed = parseResult.review;
        } catch (err) {
            context.logger.warn({ err, attempt }, 'Repair completion threw; will fall back to raw');
            break;
        }
    }

    let review: string;
    if (parsed) {
        review = renderReviewMarkdown(parsed);
        context.logger.info(
            {
                provider: completion.provider,
                model: completion.model,
                issues: parsed.issues.length,
                decision: parsed.decision,
                repairAttempts: repairAttempts.length,
            },
            repairAttempts.length > 0
                ? 'AI review rendered after repair'
                : 'AI review rendered from structured JSON',
        );
    } else {
        // Hard-reject `no-json` AFTER at least one repair attempt. The
        // parser's `failureKind = 'no-json'` means the model's final
        // output contained ZERO `{` characters — there's no possible
        // way to extract a structured review from it, and posting it
        // raw means the user sees the model's internal exploration /
        // tool narration prose as the "review" (the PR #13 case:
        // 1221 chars of "Now let me check the spawnCli function …").
        //
        // The 0.1.3 empty-output guard a few lines down checks
        // `!review.trim()` — it fired on the "both outputs empty"
        // case but missed THIS asymmetric "first chatty, repair empty"
        // shape: the previous fallback expression
        // `review = attemptText || completion.text` resurrected the
        // original 1221-char text when `attemptText` (the empty repair
        // output) was falsy, leaving `review` non-empty and slipping
        // past `!review.trim()`. Anchoring on the parser's own
        // structural signal — no `{` even after being explicitly
        // asked for JSON — is provider-agnostic and false-positive-
        // free (a legitimate short review always parses and never
        // enters the repair loop).
        //
        // `parse_repair_retries: 0` workflows that opt out of the
        // repair loop still get the previous "post raw text" behavior
        // — we only escalate after explicit repair attempt.
        if (parseResult.failureKind === 'no-json' && repairAttempts.length > 0) {
            await recordAiReviewRun(
                {
                    ...recordStub,
                    durationMs: Date.now() - startedAt,
                    provider: completion.provider,
                    model: completion.model,
                    usage: completion.usage,
                    output: {
                        parseSucceeded: false,
                        reviewChars: 0,
                        rawSample: attemptText.slice(0, 5000),
                        parseFailureKind: parseResult.failureKind,
                        repairAttempts,
                    },
                },
                context.logger,
            );
            throw new Error(
                `ai-review: ${completion.provider} (${completion.model}) produced no JSON ` +
                `even after ${repairAttempts.length} repair attempt(s). Final output contained ` +
                `zero \`{\` characters — typically the model lapsing into tool-narration / ` +
                `chain-of-thought instead of producing the requested structured review. ` +
                `Posting raw would surface that exploration text as the user-facing comment. ` +
                `Run record: ${runId}.`,
            );
        }
        // Be explicit about which string we fall back to so the
        // empty-guard below and this branch agree on the same value.
        // The old `attemptText || completion.text` accidentally
        // resurrected the original output whenever a non-empty first
        // attempt was followed by an empty repair.
        review = attemptText.trim() ? attemptText : completion.text;
        context.logger.warn(
            {
                provider: completion.provider,
                model: completion.model,
                failureKind: parseResult.failureKind,
                repairAttempts: repairAttempts.length,
                preview: review.slice(0, 300),
            },
            'AI review did not return valid JSON even after repair; posting raw text as fallback',
        );
    }

    // ─── Empty-output guard ─────────────────────────────────────────────
    // Real failure mode previously observed with opencode + glm-5.1: the
    // CLI exits 0 but emits a JSONL stream with no `text` events (model
    // gave up before producing text, provider mid-stream hiccup, schema
    // drift). `completion.text` is `""`, the parser finds no JSON, the
    // fallback above sets `review = ""` — and the workflow happily
    // posts an empty review comment with just the template's header
    // and footer. Throwing here surfaces the failure in the dashboard
    // run viewer instead of silently advertising "the AI reviewed your
    // PR" with no content. extractCliText already surfaces opencode
    // `error` events as `[opencode-error] ...` text, so the throw also
    // captures that diagnostic when the model output was an error.
    if (!review.trim()) {
        await recordAiReviewRun(
            {
                ...recordStub,
                durationMs: Date.now() - startedAt,
                provider: completion.provider,
                model: completion.model,
                usage: completion.usage,
                output: {
                    parseSucceeded: false,
                    reviewChars: 0,
                    rawSample: attemptText.slice(0, 5000),
                    parseFailureKind: parseResult.failureKind,
                    ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
                },
            },
            context.logger,
        );
        throw new Error(
            `ai-review: ${completion.provider} (${completion.model}) returned no usable content. ` +
            `The CLI exited cleanly but produced no model text. Common causes: model ` +
            `emitted only reasoning, provider mid-stream error, or upstream CLI schema ` +
            `drift. Run record: ${runId}.`,
        );
    }

    await recordAiReviewRun(
        {
            ...recordStub,
            durationMs: Date.now() - startedAt,
            provider: completion.provider,
            model: completion.model,
            usage: completion.usage,
            output: parsed
                ? {
                    parseSucceeded: true,
                    decision: parsed.decision,
                    issueCount: parsed.issues.length,
                    issues: parsed.issues.map((i: typeof parsed.issues[number]) => ({
                        priority: i.priority,
                        title: i.title,
                        file: i.file,
                        path: i.path,
                        lineStart: i.lineStart,
                        lineEnd: i.lineEnd,
                        problem: i.problem,
                        fix: i.fix,
                    })),
                    reviewChars: review.length,
                    // Record repair history even on success so the dashboard
                    // can show "rendered after N repair attempts" — useful
                    // signal that the prompt or model is flaky.
                    ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
                }
                : {
                    parseSucceeded: false,
                    reviewChars: review.length,
                    rawSample: attemptText.slice(0, 5000),
                    parseFailureKind: parseResult.failureKind,
                    ...(repairAttempts.length > 0 ? { repairAttempts } : {}),
                },
        },
        context.logger,
    );

    return {
        // The run-id is exposed so downstream steps (notably
        // github-create-review) can stamp the comment marker
        // `<!-- sokuza:run-id=... -->` and so the auto address-review
        // workflow can later look up the structured record.
        id: runId,
        review,
        model: completion.model,
        provider: completion.provider,
        usage: completion.usage,
        parsed: parsed ?? undefined,
        truncation: truncation.originalChars !== truncation.finalChars
            ? {
                summary: truncation.summary,
                originalChars: truncation.originalChars,
                finalChars: truncation.finalChars,
            }
            : undefined,
        // ─── Output ports the ai.review node declares ──────────────────
        // `actionNode` spreads this return object onto the node's outputs
        // (see wrapResult in core/nodes/builtins.ts). The graph editor's
        // node definition advertises these specific port names; if any
        // are missing, wires from `review.<port>` resolve to undefined
        // and the runtime silently falls through to config defaults,
        // which is how a wired `body` ended up empty on github.comment.
        // Always emit them, even when parsing failed (markdown is still
        // the rendered text; structured outputs degrade to undefined).
        markdown: review,
        structured: parsed ?? undefined,
        summary: parsed?.summary,
        issues: parsed?.issues,
        mergeReady: parsed ? parsed.decision === 'APPROVE' : undefined,
        runId,
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
