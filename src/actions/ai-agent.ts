import type { ActionHandler, EventPayload } from '../core/types.js';
import { runAgentWithFallback } from '../core/ai-providers.js';
import {
    parseStructuredReviewExt,
    renderReviewMarkdown,
} from './review-templates.js';
import {
    recordAiReviewRun,
    generateRunId,
    type AiReviewRunRecord,
} from '../core/run-store.js';

/**
 * "ai-agent" action.
 *
 * Runs an AI coding CLI *inside a working directory* with tool access,
 * enabling it to read files, grep code, and optionally edit files. The
 * specific CLI (Claude Code, Opencode, …) is selected via the provider
 * registry; see `src/core/ai-providers.ts`.
 *
 * Unlike `ai-review` (one-shot completion), this gives the model agentic
 * capabilities to explore and understand the full repo.
 *
 * Params:
 *   - workdir: Working directory to run in (usually from github-clone-repo)
 *   - prompt: What to ask the agent to do
 *   - provider: Registered provider name (must be kind="cli"). Falls back
 *               to the registry default. Legacy value "claude-code" works.
 *   - model: Model override (defaults to provider.defaultModel)
 *   - allowed_tools: Array of tools to allow (default: read-only tools)
 *   - output_format: "text" | "json" (default: "text")
 *   - parse_as_review: When true, parse the agent's output as a structured
 *                      code review and record a run under ~/.sokuza/runs/
 *                      ai-review/ so the auto-fix `address-review` loop
 *                      can consume it. Adds `markdown`/`structured`/
 *                      `summary`/`issues`/`mergeReady`/`runId` to the
 *                      returned output bag — same shape as `ai-review`.
 *
 * Returns: { output, review, model, provider, transcript } plus any
 * parsed JSON fields when output_format is "json". When parse_as_review
 * is true, also returns the review output bag listed above.
 */
export const aiAgentAction: ActionHandler = async (params, context) => {
    const workdir = params.workdir as string;
    if (!workdir) {
        throw new Error('ai-agent: workdir is required (use github-clone-repo to get it)');
    }

    const prompt = params.prompt as string;
    if (!prompt) {
        throw new Error('ai-agent: prompt is required');
    }

    const outputFormat = (params.output_format as 'text' | 'json') ?? 'text';
    const allowedTools = params.allowed_tools as string[] | undefined;
    const parseAsReview = params.parse_as_review === true;

    const startedAt = Date.now();
    const runId = generateRunId();
    const createdAt = new Date(startedAt).toISOString();

    context.logger.info(
        {
            workdir,
            promptLength: prompt.length,
            tools: allowedTools,
            parseAsReview,
        },
        'Running AI agent in repo',
    );

    const result = await runAgentWithFallback(context.ai, params.provider as string | undefined, {
        prompt,
        workdir,
        model: params.model as string | undefined,
        allowedTools,
        outputFormat,
        logger: context.logger,
    });

    // The ai.agent node (see core/nodes/builtins.ts) advertises two
    // outputs: `output` (the agent's text) and `transcript` (the parsed
    // JSON when output_format=json). The action's spread is what feeds
    // those ports — if it doesn't return `output`, every wire from
    // `{{nodes.X.output}}` resolves to undefined and downstream
    // template-only configs (like the library auto-label-pr's
    // github.comment body) silently get an empty string.
    //
    // Keep `review` for back-compat with older templates that wire
    // `{{nodes.X.review}}`, and the parsed JSON fields are still
    // spread at the top level so consumers that asked for json
    // output can access them directly.
    const base: Record<string, unknown> = {
        // Placeholders for the review-shape ports declared on the node.
        // Each key must exist on the return so wires like
        // `{{nodes.agent.markdown}}` resolve to a stable `undefined`
        // instead of silently looking up a missing key (same contract as
        // ai.review). Pinned by ai-nodes-output-contract.test.ts.
        // These get overwritten by the parsedJson spread below if the
        // agent emitted JSON that happens to include the same key,
        // and by the parse_as_review block when that flag is set.
        id: undefined,
        runId: undefined,
        markdown: undefined,
        structured: undefined,
        parsed: undefined,
        summary: undefined,
        issues: undefined,
        mergeReady: undefined,
        // Legacy + always-on ports.
        output: result.output,
        review: result.output,
        model: result.model,
        provider: result.provider,
        transcript: result.parsedJson ?? undefined,
    };
    if (result.parsedJson && typeof result.parsedJson === 'object') {
        Object.assign(base, result.parsedJson as Record<string, unknown>);
    }

    if (!parseAsReview) {
        return base;
    }

    // ─── parse_as_review path ──────────────────────────────────────────
    // Treat the agent's output as a structured code review. Reuses
    // ai-review's parser + run-store so the address-review loop can pick
    // up an agentic review by the same `{{runId}}` marker it already
    // honors. No repair retries here — agentic runs are expensive and
    // the user shaped the prompt; surface the parse failure cleanly
    // instead of looping a CLI process.
    const reviewText = result.output ?? '';
    const parseResult = parseStructuredReviewExt(reviewText);
    const parsed = parseResult.review;
    const markdown = parsed ? renderReviewMarkdown(parsed) : reviewText;

    if (!parsed) {
        context.logger.warn(
            {
                provider: result.provider,
                model: result.model,
                failureKind: parseResult.failureKind,
                preview: reviewText.slice(0, 300),
            },
            'ai-agent: parse_as_review enabled but agent output did not parse as a structured review. Raw output preserved in `markdown`; `structured`/`issues` will be undefined.',
        );
    }

    await recordAiReviewRun(
        buildAgentReviewRecord({
            runId,
            createdAt,
            durationMs: Date.now() - startedAt,
            workflowName: context.workflowName,
            event: extractEventInfo(context.event),
            provider: result.provider,
            model: result.model,
            promptChars: prompt.length,
            output: parsed
                ? {
                    parseSucceeded: true,
                    decision: parsed.decision,
                    issueCount: parsed.issues.length,
                    issues: parsed.issues.map((i) => ({
                        priority: i.priority,
                        title: i.title,
                        file: i.file,
                        path: i.path,
                        lineStart: i.lineStart,
                        lineEnd: i.lineEnd,
                        problem: i.problem,
                        fix: i.fix,
                    })),
                    reviewChars: markdown.length,
                }
                : {
                    parseSucceeded: false,
                    reviewChars: markdown.length,
                    rawSample: reviewText.slice(0, 5000),
                    parseFailureKind: parseResult.failureKind,
                },
        }),
        context.logger,
    );

    return {
        ...base,
        // ─── Output ports the ai.agent node declares for parse_as_review ──
        // Same names ai.review uses, so the same downstream nodes
        // (`github.create-review` with `{{nodes.X.markdown}}` +
        // `{{nodes.X.runId}}`) work without graph rewiring.
        id: runId,
        runId,
        markdown,
        structured: parsed ?? undefined,
        parsed: parsed ?? undefined,
        summary: parsed?.summary,
        issues: parsed?.issues,
        mergeReady: parsed ? parsed.decision === 'APPROVE' : undefined,
    };
};

/** Compose the synthetic ai-review run record produced by an agentic run.
 *  Truncation/diff fields are zeroed — the agent reads files directly,
 *  so there's no diff to truncate. The `strategy: 'agentic'` tag
 *  distinguishes these runs in the dashboard. */
function buildAgentReviewRecord(args: {
    runId: string;
    createdAt: string;
    durationMs: number;
    workflowName?: string;
    event: AiReviewRunRecord['event'];
    provider: string;
    model: string;
    promptChars: number;
    output: AiReviewRunRecord['output'];
}): AiReviewRunRecord {
    return {
        id: args.runId,
        action: 'ai-review',
        createdAt: args.createdAt,
        durationMs: args.durationMs,
        workflowName: args.workflowName,
        event: args.event,
        provider: args.provider,
        model: args.model,
        strategy: 'agentic',
        input: {
            diffBytes: 0,
            diffSha1: '',
            incompleteFiles: [],
        },
        truncation: {
            triggered: false,
            originalChars: 0,
            finalChars: 0,
            totalFiles: 0,
            fullyIncludedFiles: 0,
            truncatedFiles: 0,
            skippedFiles: 0,
            files: [],
        },
        output: args.output,
    };
}

function extractEventInfo(event: EventPayload | undefined): AiReviewRunRecord['event'] {
    if (!event) return { source: '', event: '' };
    const meta = event.metadata ?? {};
    const pr = event.payload?.pull_request as Record<string, unknown> | undefined;
    const info: AiReviewRunRecord['event'] = {
        source: event.source,
        event: event.event,
    };
    const repo = meta.repo as string | undefined;
    if (repo) info.repo = repo;
    const prNumber = (meta.prNumber ?? pr?.number) as number | undefined;
    if (typeof prNumber === 'number') info.prNumber = prNumber;
    const branch = (pr?.head as Record<string, unknown> | undefined)?.ref as string | undefined;
    if (branch) info.branch = branch;
    return info;
}
