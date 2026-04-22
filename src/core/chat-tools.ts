/**
 * Tools available to the chat agent.
 *
 * These are read-only inspection tools plus `run_workflow` for triggering
 * existing sokuza workflows from a chat session. No Edit/Write/Bash — by
 * user decision, we're building a "chat about code" experience, not a
 * coding agent (that overlaps with claude-code / opencode).
 *
 * Each tool definition follows the Anthropic `tools` schema so chat-agent
 * can hand them directly to `messages.create({ tools: ... })`.
 * Implementations run server-side; their outputs are posted back to the
 * model as `tool_result` blocks.
 *
 * Filesystem tools are sandboxed to the session's workdir — any attempt
 * to escape (`../../`, absolute paths outside the workdir) is rejected
 * before hitting disk.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { ChatSession } from './types.js';
import type { SokuzaEngine } from './engine.js';

// ─── Tool definitions (JSON Schema for the Anthropic API) ───────────────────

/**
 * Tool definitions shipped to the model on every turn. Descriptions are
 * load-bearing — the model decides whether to invoke a tool based on
 * them, so they're written for a reader who has only this list to go on.
 */
export const CHAT_TOOL_DEFINITIONS: Anthropic.Tool[] = [
    {
        name: 'get_scope_info',
        description:
            'Return the session scope — which repo, branch, and (if applicable) pull request this chat is about. Call this first when the user asks general "what is this?" questions so you know what you\'re looking at.',
        input_schema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'get_diff',
        description:
            'Return the unified git diff for this session. For PR-scoped sessions this is the PR\'s diff (base → head). For branch-scoped sessions it\'s the branch vs its upstream. Not available for plain repo-scoped sessions (returns an error you can relay to the user).',
        input_schema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'list_files',
        description:
            'List files in the session\'s repo workdir, relative to the given path (default: repo root). Respects `.gitignore` via `git ls-files`. Use this to explore the repo before reading specific files.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Subdirectory to list, relative to the repo root. Defaults to the repo root.',
                },
            },
        },
    },
    {
        name: 'read_file',
        description:
            'Read a file from the session\'s repo workdir. Output is truncated to ~64KB by default; raise `maxBytes` (up to 512KB) for larger files. Returns an error if the path escapes the workdir or the file does not exist.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'File path relative to the repo root (e.g. "src/foo.ts").',
                },
                maxBytes: {
                    type: 'integer',
                    description: 'Truncation cap in bytes (default 65536, max 524288).',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'grep',
        description:
            'Search the session\'s repo workdir for a pattern (uses `rg` if available, otherwise `grep -rn`). Returns matching file:line snippets. Use this instead of reading files one at a time when hunting for identifiers.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Regex pattern to search for.',
                },
                pathGlob: {
                    type: 'string',
                    description: 'Optional glob to restrict the search, e.g. "*.ts" or "src/**".',
                },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'list_workflows',
        description:
            'List the sokuza workflows configured on this server. Returns each workflow\'s name, trigger source/events, and declared input fields so you know what you can call with `run_workflow`.',
        input_schema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'run_workflow',
        description:
            'Trigger a configured sokuza workflow by name and wait for it to finish. Returns the workflow\'s final output — for PR-review workflows this is the rendered review markdown. Use this when the user asks to run a review, fix an issue, etc. Discover available workflows with `list_workflows` first if uncertain.',
        input_schema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Exact workflow name from `list_workflows` output.',
                },
                inputs: {
                    type: 'object',
                    description:
                        'Inputs keyed by the workflow\'s declared input field names. For a PR-scoped session the current PR is auto-injected when the workflow declares a `github-pr` input — you can omit `inputs` entirely in that case.',
                },
            },
            required: ['name'],
        },
    },
];

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/** Context passed to every tool handler. Narrow by design — tools only get what they need. */
export interface ChatToolContext {
    session: ChatSession;
    engine: SokuzaEngine;
    logger: Logger;
    /** Store handle used for tools that read from the session log (get_diff). */
    store: import('./chat-store.js').ChatStore;
}

/** Return value shape for a tool invocation — string content plus an error flag for the model. */
export interface ChatToolResult {
    content: string;
    isError: boolean;
}

/**
 * Execute a named tool with the given input. All tool errors are caught
 * and returned with `isError: true` so the model gets a structured
 * response it can react to, rather than a 500 bubbling up to the API.
 */
export async function dispatchChatTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ChatToolContext,
): Promise<ChatToolResult> {
    try {
        switch (name) {
            case 'get_scope_info':
                return ok(JSON.stringify(getScopeInfo(ctx), null, 2));
            case 'get_diff':
                return await getDiffTool(ctx);
            case 'list_files':
                return await listFilesTool(input, ctx);
            case 'read_file':
                return await readFileTool(input, ctx);
            case 'grep':
                return await grepTool(input, ctx);
            case 'list_workflows':
                return await listWorkflowsTool(ctx);
            case 'run_workflow':
                return await runWorkflowTool(input, ctx);
            default:
                return err(`Unknown tool: ${name}. Available: ${CHAT_TOOL_DEFINITIONS.map(t => t.name).join(', ')}`);
        }
    } catch (e: any) {
        ctx.logger.warn({ tool: name, err: e?.message, input }, 'Chat tool threw');
        return err(e?.message ?? String(e));
    }
}

function ok(content: string): ChatToolResult { return { content, isError: false }; }
function err(content: string): ChatToolResult { return { content, isError: true }; }

// ─── Individual tool handlers ───────────────────────────────────────────────

function getScopeInfo(ctx: ChatToolContext): Record<string, unknown> {
    const { session } = ctx;
    return {
        title: session.title,
        scope: session.scope,
        workdir: session.workdir,
        provider: session.provider,
    };
}

/**
 * Return the diff stashed at session creation. Stored as a system message
 * tagged `tool_cache:get_diff` so later turns can read it without
 * re-fetching from GitHub. See chat-agent for how this is seeded.
 */
async function getDiffTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    const cached = await readToolCache(ctx, 'get_diff');
    if (cached !== null) return ok(cached);
    if (ctx.session.scope.kind === 'repo') {
        return err('This is a repo-scoped session — no diff is associated with it. Use list_files / read_file to explore.');
    }
    return err('No diff was cached at session creation. This is a bug — please report it.');
}

async function readToolCache(ctx: ChatToolContext, key: string): Promise<string | null> {
    // chat-store holds the messages; we look for a system message with a
    // well-known prefix. We use the store handle from the context so tests
    // and production both hit the same on-disk layout.
    const messages = await ctx.store.getMessages(ctx.session.id);
    const prefix = `[tool_cache:${key}]`;
    for (const m of messages) {
        if (m.role === 'system' && m.content.startsWith(prefix)) {
            return m.content.slice(prefix.length).trimStart();
        }
    }
    return null;
}

async function listFilesTool(
    input: Record<string, unknown>,
    ctx: ChatToolContext,
): Promise<ChatToolResult> {
    const subPath = typeof input.path === 'string' ? input.path : '';
    const target = resolveInsideWorkdir(subPath, ctx.session.workdir);

    if (!existsSync(target)) {
        return err(`Path not found: ${subPath || '/'}`);
    }

    // Prefer `git ls-files` so we respect .gitignore. Fall back to readdir
    // when the target is outside git's tracked tree (shouldn't happen, but
    // we stay defensive).
    const gitFiles = await gitLsFiles(ctx.session.workdir, subPath).catch(() => null);
    if (gitFiles) {
        const limited = gitFiles.slice(0, 500);
        const truncNote = gitFiles.length > 500
            ? `\n\n… ${gitFiles.length - 500} more files omitted (result limited to 500).`
            : '';
        return ok(
            `${gitFiles.length} tracked file(s) under ${subPath || '/'}:\n` +
            limited.map((f) => `- ${f}`).join('\n') +
            truncNote,
        );
    }

    const entries = await readdir(target, { withFileTypes: true });
    return ok(
        entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join('\n'),
    );
}

async function readFileTool(
    input: Record<string, unknown>,
    ctx: ChatToolContext,
): Promise<ChatToolResult> {
    const path = input.path;
    if (typeof path !== 'string' || path.length === 0) {
        return err('read_file: `path` is required');
    }
    const maxBytes = Math.min(
        typeof input.maxBytes === 'number' ? input.maxBytes : 65_536,
        524_288,
    );

    const target = resolveInsideWorkdir(path, ctx.session.workdir);

    const st = await stat(target).catch(() => null);
    if (!st) return err(`File not found: ${path}`);
    if (!st.isFile()) return err(`Not a file: ${path}`);

    const raw = await readFile(target);
    const truncated = raw.length > maxBytes;
    const body = (truncated ? raw.subarray(0, maxBytes) : raw).toString('utf-8');
    const header = `path: ${path}\nsize: ${raw.length} bytes${truncated ? ` (truncated to ${maxBytes})` : ''}\n`;
    return ok(`${header}\n${body}`);
}

async function grepTool(
    input: Record<string, unknown>,
    ctx: ChatToolContext,
): Promise<ChatToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return err('grep: `pattern` is required');
    }
    const pathGlob = typeof input.pathGlob === 'string' && input.pathGlob.length > 0
        ? input.pathGlob
        : undefined;

    // Try rg first — it's faster, respects .gitignore, has the cleanest
    // output. Fall back to plain grep -rn for hosts without ripgrep.
    const rgResult = await runGrep('rg', buildRgArgs(pattern, pathGlob), ctx.session.workdir).catch(() => null);
    if (rgResult !== null) {
        return formatGrepOutput(rgResult, 'rg');
    }

    const grepResult = await runGrep('grep', buildGrepArgs(pattern, pathGlob), ctx.session.workdir).catch((e) => {
        ctx.logger.warn({ err: e?.message }, 'grep fallback failed');
        return null;
    });
    if (grepResult !== null) {
        return formatGrepOutput(grepResult, 'grep');
    }
    return err('Neither `rg` nor `grep` is available on this host.');
}

function buildRgArgs(pattern: string, pathGlob?: string): string[] {
    const args = ['--line-number', '--no-heading', '--color=never', '--max-count=10'];
    if (pathGlob) args.push('--glob', pathGlob);
    args.push(pattern);
    return args;
}

function buildGrepArgs(pattern: string, pathGlob?: string): string[] {
    // grep -rn into the cwd; --include for pathGlob (narrower filter).
    const args = ['-rn'];
    if (pathGlob) args.push(`--include=${pathGlob}`);
    args.push(pattern);
    args.push('.');
    return args;
}

function runGrep(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolveResult, rejectResult) => {
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => errChunks.push(c));
        child.on('error', rejectResult);
        child.on('close', (code) => {
            // rg returns 1 when no matches; grep also returns 1. Treat that
            // as a clean "no results" string, not an error.
            if (code === 0 || code === 1) {
                resolveResult(Buffer.concat(chunks).toString('utf-8'));
            } else {
                rejectResult(new Error(
                    `${cmd} exited ${code}: ${Buffer.concat(errChunks).toString('utf-8').slice(0, 200)}`,
                ));
            }
        });
        setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            rejectResult(new Error(`${cmd} timed out`));
        }, 10_000);
    });
}

function formatGrepOutput(raw: string, engine: string): ChatToolResult {
    if (!raw.trim()) return ok('(no matches)');
    const lines = raw.split('\n').filter(Boolean);
    const limited = lines.slice(0, 200);
    const truncNote = lines.length > 200 ? `\n… ${lines.length - 200} more matches omitted.` : '';
    return ok(`[${engine}] ${lines.length} match(es):\n${limited.join('\n')}${truncNote}`);
}

async function listWorkflowsTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    const config = ctx.engine.getConfig();
    const workflows = config.workflows ?? [];
    if (workflows.length === 0) {
        return ok('(no workflows configured on this server)');
    }
    const summarized = workflows.map((wf) => ({
        name: wf.name,
        description: wf.description,
        template: wf.template,
        trigger: {
            source: wf.trigger.source,
            event: wf.trigger.event,
        },
        inputs: (wf.inputs ?? []).map((i) => ({
            name: i.name,
            type: i.type,
            required: i.required ?? false,
            label: i.label,
        })),
    }));
    return ok(JSON.stringify(summarized, null, 2));
}

async function runWorkflowTool(
    input: Record<string, unknown>,
    ctx: ChatToolContext,
): Promise<ChatToolResult> {
    const name = input.name;
    if (typeof name !== 'string' || name.length === 0) {
        return err('run_workflow: `name` is required');
    }
    const providedInputs = (input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs))
        ? input.inputs as Record<string, unknown>
        : {};

    // For PR-scoped sessions, auto-inject the current PR as the value for
    // whichever `github-pr` input the workflow declares. Same pattern the
    // dashboard's "Review" button uses — keeps the model from having to
    // guess the input field name.
    const config = ctx.engine.getConfig();
    const workflow = config.workflows?.find((wf) => wf.name === name);
    if (!workflow) {
        return err(`Workflow "${name}" not found. Call list_workflows to see available workflows.`);
    }

    const augmented = { ...providedInputs };
    if (ctx.session.scope.kind === 'pr' && workflow.inputs) {
        const prInput = workflow.inputs.find((i) => i.type === 'github-pr');
        if (prInput && !(prInput.name in augmented)) {
            augmented[prInput.name] = {
                number: ctx.session.scope.prNumber,
                repo: ctx.session.scope.repo,
            };
        }
    }

    ctx.logger.info(
        { sessionId: ctx.session.id, workflow: name, inputs: Object.keys(augmented) },
        'Chat invoking workflow',
    );

    const result = await ctx.engine.runWorkflowByName(name, augmented);
    if (!result.ok) {
        return err(`Workflow failed: ${result.error ?? 'unknown error'}`);
    }

    // Pull the most useful field out of the output — for PR-review
    // workflows it's `review` on the last step; for agentic workflows
    // it may be `output` or the whole blob.
    const rendered = extractUsefulOutput(result.output);
    return ok(rendered);
}

function extractUsefulOutput(output: unknown): string {
    if (!output || typeof output !== 'object') {
        return String(output ?? '(workflow completed with no output)');
    }
    const obj = output as { results?: Record<number, unknown>; steps?: Record<string, unknown> };
    const stepResults = Object.values(obj.steps ?? {});
    const indexResults = Object.values(obj.results ?? {});
    const allResults = [...stepResults, ...indexResults];

    // Prefer the last result that has a `review` field (PR-review workflows).
    for (let i = allResults.length - 1; i >= 0; i--) {
        const r = allResults[i];
        if (r && typeof r === 'object' && 'review' in r && typeof (r as any).review === 'string') {
            return (r as any).review;
        }
    }

    // Else last truthy result.
    for (let i = allResults.length - 1; i >= 0; i--) {
        const r = allResults[i];
        if (r === undefined || r === null) continue;
        if (typeof r === 'string') return r;
        return '```json\n' + JSON.stringify(r, null, 2) + '\n```';
    }
    return '(workflow completed with no output)';
}

// ─── Workdir sandbox helper ─────────────────────────────────────────────────

/**
 * Resolve `subPath` relative to `workdir`, reject any path that escapes
 * the workdir. Accepts empty string as "the workdir itself".
 *
 * Escape attempts (`../..`, absolute paths outside workdir) throw so the
 * tool dispatcher catches and reports them as errors instead of letting
 * them reach `readFile` / `readdir`.
 */
function resolveInsideWorkdir(subPath: string, workdir: string): string {
    const base = resolve(workdir);
    if (!subPath) return base;
    if (isAbsolute(subPath)) {
        throw new Error(`Path must be relative to the repo root (got "${subPath}")`);
    }
    const target = resolve(base, subPath);
    const rel = relative(base, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Path "${subPath}" escapes the session workdir`);
    }
    return target;
}

function gitLsFiles(workdir: string, subPath: string): Promise<string[]> {
    return new Promise((resolveResult, rejectResult) => {
        const args = ['ls-files'];
        if (subPath) args.push('--', subPath);
        const child = spawn('git', args, { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('error', rejectResult);
        child.on('close', (code) => {
            if (code !== 0) {
                rejectResult(new Error(`git ls-files exited ${code}`));
                return;
            }
            const output = Buffer.concat(chunks).toString('utf-8');
            resolveResult(output.split('\n').filter(Boolean));
        });
    });
}

// ─── Public helpers for chat-agent ──────────────────────────────────────────

/** Tool-cache prefix used by `get_diff` and any future cached tools. */
export const TOOL_CACHE_PREFIX = '[tool_cache:';

/** Format a cached-diff system message for the initial session log. */
export function formatDiffCache(diff: string): string {
    return `[tool_cache:get_diff]\n${diff}`;
}

// Avoid unused-import warnings — `join` is exported for downstream chat-agent use.
export { join };
