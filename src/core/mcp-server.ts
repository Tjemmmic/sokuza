/**
 * Sokuza MCP server.
 *
 * Exposes Sokuza's PR context and AI-review findings to external CLI clients
 * (Claude Code, etc.) over the Model Context Protocol. Run as a stdio server
 * via `sokuza mcp`, so it plugs straight into `~/.claude.json`.
 *
 * Two tools are fully local (they read git + the on-disk run store), and two
 * bridge to a running Sokuza engine over its authenticated HTTP API:
 *
 *   sokuza_get_pr_context     — branch / repository / latest commit (local git)
 *   sokuza_get_review_findings — P1/P2/P3 issues from ~/.sokuza/runs/ai-review
 *   sokuza_report_status       — push a status line to the dashboard (bridge)
 *   sokuza_ask_human           — ask a question and block for the answer (bridge)
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never write logs there — all
 * diagnostics go to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { VERSION } from '../version.js';
import { listAiReviewRuns, getAiReviewRunById } from './run-store.js';
import { listRuntimeStates } from '../server/discovery.js';
import { tokenFilePath } from '../server/auth.js';

const execFileP = promisify(execFile);

// ─── PR context (local git) ─────────────────────────────────────────────────

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGit: GitRunner = async (args, cwd) => {
    const { stdout } = await execFileP('git', args, { cwd, timeout: 10_000 });
    return stdout.trim();
};

export interface PrContext {
    repository: string | null;
    branch: string | null;
    commit: { sha: string; subject: string; author: string } | null;
    cwd: string;
}

/** Parse `owner/repo` out of a git remote URL; returns the raw url if it
 *  doesn't look like a recognised host form. */
export function parseRepoFromRemote(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;
    // git@host:owner/repo.git  |  ssh://git@host/owner/repo.git
    // https://host/owner/repo(.git)
    const m = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/.exec(trimmed);
    return m ? m[1] : trimmed;
}

export async function gatherPrContext(cwd: string, git: GitRunner = defaultGit): Promise<PrContext> {
    const safe = async (args: string[]): Promise<string | null> => {
        try { return await git(args, cwd); } catch { return null; }
    };
    const branch = await safe(['rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = await safe(['remote', 'get-url', 'origin']);
    const sha = await safe(['rev-parse', 'HEAD']);
    const subject = await safe(['log', '-1', '--pretty=%s']);
    const author = await safe(['log', '-1', '--pretty=%an']);
    return {
        repository: remote ? parseRepoFromRemote(remote) : null,
        // 'HEAD' means a detached checkout — report no branch rather than the
        // literal string.
        branch: branch === 'HEAD' ? null : branch,
        commit: sha ? { sha, subject: subject ?? '', author: author ?? '' } : null,
        cwd,
    };
}

// ─── Review findings (on-disk run store) ────────────────────────────────────

export interface ReviewFindingsArgs {
    repo?: string;
    prNumber?: number;
    runId?: string;
    limit?: number;
}

export interface ReviewFindingsResult {
    runs: Array<{
        runId: string;
        createdAt: string;
        repo?: string;
        prNumber?: number;
        decision?: string;
        provider: string;
        model: string;
        issues: NonNullable<Awaited<ReturnType<typeof getAiReviewRunById>>>['output']['issues'];
    }>;
}

export async function getReviewFindings(
    args: ReviewFindingsArgs,
    baseDir?: string,
): Promise<ReviewFindingsResult> {
    // Direct lookup by run id.
    if (args.runId) {
        const record = await getAiReviewRunById(args.runId, baseDir);
        if (!record) return { runs: [] };
        return {
            runs: [{
                runId: record.id,
                createdAt: record.createdAt,
                repo: record.event.repo,
                prNumber: record.event.prNumber,
                decision: record.output.decision,
                provider: record.provider,
                model: record.model,
                issues: record.output.issues ?? [],
            }],
        };
    }

    const limit = Math.max(1, Math.min(args.limit ?? 3, 20));
    const summaries = await listAiReviewRuns({
        repo: args.repo,
        limit: 100,
        baseDir,
    });
    const matched = summaries
        .filter((s) => args.prNumber === undefined || s.event.prNumber === args.prNumber)
        .slice(0, limit);

    const runs: ReviewFindingsResult['runs'] = [];
    for (const summary of matched) {
        const record = await getAiReviewRunById(summary.id, baseDir);
        if (!record) continue;
        runs.push({
            runId: record.id,
            createdAt: record.createdAt,
            repo: record.event.repo,
            prNumber: record.event.prNumber,
            decision: record.output.decision,
            provider: record.provider,
            model: record.model,
            issues: record.output.issues ?? [],
        });
    }
    return { runs };
}

// ─── Engine bridge (authenticated HTTP to a running sokuza) ─────────────────

export interface EngineBridge {
    available(): Promise<boolean>;
    reportStatus(input: { source?: string; message: string; level?: string }): Promise<void>;
    ask(prompt: string, opts: { source?: string; timeoutMs: number; pollMs?: number }): Promise<string>;
}

/** Discover the running engine's base URL + token, or null if unreachable. */
async function discoverEngine(): Promise<{ baseUrl: string; token: string } | null> {
    let token: string;
    try {
        token = (await readFile(tokenFilePath(), 'utf-8')).trim();
    } catch {
        return null; // no token file → no engine has ever run here
    }
    if (!token) return null;

    const states = await listRuntimeStates();
    const sorted = [...states].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const s of sorted) {
        const host = s.host === '0.0.0.0' || s.host === '::' ? '127.0.0.1' : s.host;
        const hostPart = host.includes(':') ? `[${host}]` : host;
        const baseUrl = `http://${hostPart}:${s.port}`;
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) return { baseUrl, token };
        } catch {
            /* try the next instance */
        }
    }
    return null;
}

export class HttpEngineBridge implements EngineBridge {
    private cached: { baseUrl: string; token: string } | null = null;

    private async resolve(): Promise<{ baseUrl: string; token: string }> {
        if (this.cached) return this.cached;
        const found = await discoverEngine();
        if (!found) {
            throw new Error(
                'No running Sokuza engine found. Start it with `sokuza start` so MCP can reach the dashboard.',
            );
        }
        this.cached = found;
        return found;
    }

    private async post(path: string, body: unknown): Promise<Response> {
        const { baseUrl, token } = await this.resolve();
        return fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    }

    async available(): Promise<boolean> {
        try { await this.resolve(); return true; } catch { return false; }
    }

    async reportStatus(input: { source?: string; message: string; level?: string }): Promise<void> {
        const res = await this.post('/api/mcp/status', input);
        if (!res.ok) throw new Error(`engine returned ${res.status} for report_status`);
    }

    async ask(prompt: string, opts: { source?: string; timeoutMs: number; pollMs?: number }): Promise<string> {
        const { baseUrl, token } = await this.resolve();
        const create = await this.post('/api/mcp/ask', { prompt, source: opts.source });
        if (!create.ok) throw new Error(`engine returned ${create.status} for ask`);
        const { id } = (await create.json()) as { id: string };

        const pollMs = opts.pollMs ?? 1500;
        const deadline = Date.now() + opts.timeoutMs;
        while (Date.now() < deadline) {
            await delay(pollMs);
            const res = await fetch(`${baseUrl}/api/mcp/ask/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) continue;
            const data = (await res.json()) as { status: string; answer?: string };
            if (data.status === 'answered') return data.answer ?? '';
        }
        throw new Error(
            'Timed out waiting for a human answer in the Sokuza dashboard. Open the dashboard and respond, then retry.',
        );
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ─── Tool definitions + dispatch ────────────────────────────────────────────

export const TOOLS: Tool[] = [
    {
        name: 'sokuza_get_pr_context',
        description: 'Get the current repository, branch, and latest commit for the working directory sokuza mcp was launched in.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'sokuza_get_review_findings',
        description: 'Return AI code-review findings (P1/P2/P3 issues) recorded by sokuza. Filter by repo (owner/repo), prNumber, or a specific runId.',
        inputSchema: {
            type: 'object',
            properties: {
                repo: { type: 'string', description: 'owner/repo to filter by' },
                prNumber: { type: 'number', description: 'PR number to filter by' },
                runId: { type: 'string', description: 'A specific review run id' },
                limit: { type: 'number', description: 'Max runs to return (default 3, max 20)' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'sokuza_report_status',
        description: 'Post a status update to the Sokuza dashboard event stream. Requires a running sokuza engine.',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The status message to display' },
                level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Severity (default info)' },
                source: { type: 'string', description: 'Who is reporting, e.g. "claude-code"' },
            },
            required: ['message'],
            additionalProperties: false,
        },
    },
    {
        name: 'sokuza_ask_human',
        description: 'Ask a human a question via the Sokuza dashboard and block until they answer (or a timeout). Requires a running sokuza engine.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The question to ask the human' },
                source: { type: 'string', description: 'Who is asking, e.g. "claude-code"' },
                timeoutSeconds: { type: 'number', description: 'How long to wait (default 300, max 1800)' },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
    },
];

export interface McpToolDeps {
    cwd: string;
    git: GitRunner;
    bridge: EngineBridge;
    runsBaseDir?: string;
}

function ok(data: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

export async function dispatchTool(
    name: string,
    args: Record<string, unknown>,
    deps: McpToolDeps,
): Promise<CallToolResult> {
    try {
        switch (name) {
            case 'sokuza_get_pr_context':
                return ok(await gatherPrContext(deps.cwd, deps.git));

            case 'sokuza_get_review_findings':
                return ok(await getReviewFindings({
                    repo: typeof args.repo === 'string' ? args.repo : undefined,
                    prNumber: typeof args.prNumber === 'number' ? args.prNumber : undefined,
                    runId: typeof args.runId === 'string' ? args.runId : undefined,
                    limit: typeof args.limit === 'number' ? args.limit : undefined,
                }, deps.runsBaseDir));

            case 'sokuza_report_status': {
                const message = typeof args.message === 'string' ? args.message : '';
                if (!message) return fail('message is required');
                await deps.bridge.reportStatus({
                    message,
                    level: typeof args.level === 'string' ? args.level : undefined,
                    source: typeof args.source === 'string' ? args.source : undefined,
                });
                return ok({ reported: true });
            }

            case 'sokuza_ask_human': {
                const prompt = typeof args.prompt === 'string' ? args.prompt : '';
                if (!prompt) return fail('prompt is required');
                const timeoutSeconds = Math.max(
                    5,
                    Math.min(typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 300, 1800),
                );
                const answer = await deps.bridge.ask(prompt, {
                    source: typeof args.source === 'string' ? args.source : undefined,
                    timeoutMs: timeoutSeconds * 1000,
                });
                return ok({ answer });
            }

            default:
                return fail(`unknown tool: ${name}`);
        }
    } catch (err) {
        return fail((err as Error).message ?? 'tool failed');
    }
}

/** Build a configured (but not yet connected) MCP Server. */
export function buildMcpServer(deps: McpToolDeps): Server {
    const server = new Server(
        { name: 'sokuza', version: VERSION },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
        dispatchTool(request.params.name, request.params.arguments ?? {}, deps),
    );

    return server;
}

/** Entry point for `sokuza mcp`: build the server over stdio and block. */
export async function runMcpServer(): Promise<void> {
    const server = buildMcpServer({
        cwd: process.cwd(),
        git: defaultGit,
        bridge: new HttpEngineBridge(),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Connected: the transport keeps the process alive on stdin. Surface a
    // single line on stderr so an operator running it by hand sees life.
    process.stderr.write(`sokuza mcp ${VERSION} ready (stdio)\n`);
}
