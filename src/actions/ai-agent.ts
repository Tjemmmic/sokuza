import type { ActionHandler } from '../core/types.js';
import { resolveProvider, runAgent } from '../core/ai-providers.js';

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

    const provider = resolveProvider(context.ai, params.provider as string | undefined);
    const outputFormat = (params.output_format as 'text' | 'json') ?? 'text';
    const allowedTools = params.allowed_tools as string[] | undefined;

    context.logger.info(
        {
            provider: provider.name,
            kind: provider.kind,
            workdir,
            promptLength: prompt.length,
            tools: allowedTools,
        },
        'Running AI agent in repo',
    );

    const result = await runAgent(provider, {
        prompt,
        workdir,
        model: params.model as string | undefined,
        allowedTools,
        outputFormat,
        logger: context.logger,
    });

    // When JSON parsing succeeded, spread the parsed fields into the
    // result so downstream steps can reference them directly.
    if (result.parsedJson && typeof result.parsedJson === 'object') {
        return {
            ...(result.parsedJson as Record<string, unknown>),
            model: result.model,
            provider: result.provider,
        };
    }

    return {
        review: result.output,
        model: result.model,
        provider: result.provider,
    };
};
