import type { ActionHandler } from '../core/types.js';
import { runAgentWithFallback } from '../core/ai-providers.js';

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
 *
 * Returns: { review, model, provider } plus any parsed JSON fields
 * when output_format is "json".
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

    context.logger.info(
        {
            workdir,
            promptLength: prompt.length,
            tools: allowedTools,
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
    const base = {
        output: result.output,
        review: result.output,
        model: result.model,
        provider: result.provider,
        transcript: result.parsedJson ?? undefined,
    };
    if (result.parsedJson && typeof result.parsedJson === 'object') {
        return {
            ...(result.parsedJson as Record<string, unknown>),
            ...base,
        };
    }
    return base;
};
