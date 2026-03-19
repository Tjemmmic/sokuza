import { spawn } from 'node:child_process';
import type { ActionHandler } from '../core/types.js';

/**
 * "ai-agent" action.
 *
 * Runs Claude Code CLI *inside a working directory* with tool access,
 * enabling it to read files, grep code, and optionally edit files.
 *
 * Unlike "ai-review" (which just sends a diff for review), this gives
 * Claude agentic capabilities to explore and understand the full repo.
 *
 * Params:
 *   - workdir: Working directory to run in (usually from github-clone-repo)
 *   - prompt: What to ask Claude to do
 *   - model: Claude model (default: "sonnet")
 *   - allowed_tools: Array of tools to allow (default: read-only tools)
 *   - max_turns: Max conversation turns (default: 10)
 *   - output_format: "text" | "json" (default: "text")
 *
 * Returns: { review, model, provider } or parsed JSON if output_format is "json"
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

    const model = (params.model as string) ?? 'sonnet';
    const maxTurns = (params.max_turns as number) ?? 10;
    const outputFormat = (params.output_format as string) ?? 'text';

    // Default: read-only tools so Claude can explore but not modify
    const defaultTools = ['Read', 'Grep', 'Glob', 'LS'];
    const allowedTools = (params.allowed_tools as string[]) ?? defaultTools;

    const args = [
        '--print',
        '--model', model,
        '--output-format', outputFormat,
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        '--allowedTools', allowedTools.join(','),
    ];

    context.logger.info(
        { model, workdir, promptLength: prompt.length, tools: allowedTools },
        'Running Claude Code agent in repo',
    );

    return new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn('claude', args, {
            cwd: workdir,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err: Error) => {
            context.logger.error({ err: err.message }, 'Claude agent spawn error');
            reject(new Error(`Claude agent failed to spawn: ${err.message}`));
        });

        child.on('close', (code: number | null) => {
            const stdout = Buffer.concat(chunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');

            if (stderr) {
                context.logger.debug({ stderr: stderr.slice(0, 1000) }, 'Claude agent stderr');
            }

            if (code !== 0) {
                context.logger.error(
                    { code, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) },
                    'Claude agent exited with error',
                );
                reject(new Error(
                    `Claude agent exited with code ${code}${stdout ? `\nstdout: ${stdout.slice(0, 500)}` : ''}`,
                ));
                return;
            }

            context.logger.info(
                { model, outputLength: stdout.length },
                'Claude agent completed',
            );

            // Try to parse as JSON if requested
            if (outputFormat === 'json') {
                try {
                    const parsed = JSON.parse(stdout);
                    resolve({
                        ...parsed,
                        model,
                        provider: 'claude-code',
                    });
                    return;
                } catch {
                    context.logger.warn('Failed to parse agent output as JSON, returning as text');
                }
            }

            resolve({
                review: stdout.trim(),
                model,
                provider: 'claude-code',
            });
        });

        // Send prompt via stdin
        child.stdin.write(prompt);
        child.stdin.end();
    });
};
