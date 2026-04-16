import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import yaml from 'js-yaml';
import type { SokuzaConfig, WorkflowRunRecord } from '../core/types.js';
import type { WorkflowQueue } from '../core/queue.js';

interface ApiDeps {
    logger: Logger;
    getConfigPath: () => string;
    getTemplateDir: () => string;
    getIntegrationStatus: () => Record<string, { enabled: boolean; events: string[] }>;
    getRecentEvents: () => EventEntry[];
    addEventSubscriber: (cb: (event: unknown) => void) => () => void;
    getRegisteredActions: () => string[];
    runWorkflow: (name: string, inputs: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; runId?: string }>;
    rerunWorkflow: (runId: string) => Promise<{ ok: boolean; error?: string; runId?: string }>;
    getRunHistory: (workflowName?: string) => WorkflowRunRecord[];
    getConfig: () => SokuzaConfig;
    getQueue?: () => WorkflowQueue;
}

export interface EventEntry {
    event: { source: string; event: string; action?: string; metadata: Record<string, unknown> };
    timestamp: string;
    matchedWorkflows: string[];
}

/**
 * Mount all dashboard API routes on the Fastify server.
 */
export function registerApiRoutes(server: FastifyInstance, deps: ApiDeps): void {
    const { logger } = deps;

    // ─── Config ─────────────────────────────────────────────────────────

    server.get('/api/config', async () => {
        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        return { config: parsed };
    });

    server.put('/api/config', async (request, reply) => {
        const body = request.body as Record<string, unknown>;

        let yamlStr: string;

        // Accept raw YAML from Settings editor or Integration setup wizard
        if (typeof body.__raw_yaml === 'string') {
            const raw = body.__raw_yaml;
            try {
                yaml.load(raw); // Validate it parses
            } catch (e: any) {
                return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
            }
            yamlStr = raw;
        } else if (body.config && typeof (body.config as any).__raw_yaml === 'string') {
            // Legacy: Settings editor used to nest inside config
            const raw = (body.config as any).__raw_yaml as string;
            try {
                yaml.load(raw); // Validate it parses
            } catch (e: any) {
                return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
            }
            yamlStr = raw;
        } else if (body.config) {
            yamlStr = yaml.dump(body.config, { lineWidth: 120, noRefs: true });
        } else {
            return reply.status(400).send({ error: 'Missing config in body' });
        }

        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info('Config updated via dashboard');
        return { ok: true };
    });

    // ─── Deck ───────────────────────────────────────────────────────────

    server.get('/api/deck', async () => {
        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const deck = (parsed.deck as string[]) ?? [];
        return { deck };
    });

    server.post('/api/deck/add', async (request, reply) => {
        const { id } = request.body as { id: string };
        if (!id) {
            return reply.status(400).send({ error: 'Missing id' });
        }

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const deck = ((parsed.deck as string[]) ?? []);

        if (!deck.includes(id)) {
            deck.push(id);
            parsed.deck = deck;
            const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
            await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
            logger.info({ id }, 'Added to deck');
        }

        return { ok: true, deck };
    });

    server.delete('/api/deck/:id', async (request) => {
        const { id } = request.params as { id: string };

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const deck = ((parsed.deck as string[]) ?? []).filter(d => d !== id);
        parsed.deck = deck;

        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ id }, 'Removed from deck');

        return { ok: true, deck };
    });

    // ─── Workflows ──────────────────────────────────────────────────────

    server.get('/api/workflows', async () => {
        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const workflows = (parsed.workflows as unknown[]) ?? [];
        return { workflows };
    });

    server.post('/api/workflows', async (request, reply) => {
        const workflow = request.body as Record<string, unknown>;
        if (!workflow?.name) {
            return reply.status(400).send({ error: 'Workflow must have a name' });
        }

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const workflows = ((parsed.workflows as unknown[]) ?? []) as Record<string, unknown>[];

        if (workflows.some((w) => w.name === workflow.name)) {
            return reply.status(409).send({ error: `Workflow "${workflow.name}" already exists` });
        }

        workflows.push(workflow);
        parsed.workflows = workflows;

        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ workflow: workflow.name }, 'Workflow created via dashboard');
        return { ok: true, workflow };
    });

    server.put('/api/workflows/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const update = request.body as Record<string, unknown>;

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const workflows = ((parsed.workflows as unknown[]) ?? []) as Record<string, unknown>[];

        const idx = workflows.findIndex((w) => w.name === name);
        if (idx === -1) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }

        workflows[idx] = { ...update, name: update.name ?? name };
        parsed.workflows = workflows;

        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ workflow: name }, 'Workflow updated via dashboard');
        return { ok: true, workflow: workflows[idx] };
    });

    server.delete('/api/workflows/:name', async (request, reply) => {
        const { name } = request.params as { name: string };

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const workflows = ((parsed.workflows as unknown[]) ?? []) as Record<string, unknown>[];

        const filtered = workflows.filter((w) => w.name !== name);
        if (filtered.length === workflows.length) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }

        parsed.workflows = filtered;
        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ workflow: name }, 'Workflow deleted via dashboard');
        return { ok: true };
    });

    // ─── Run Workflow (manual trigger) ──────────────────────────────────

    server.post('/api/workflows/:name/run', async (request, reply) => {
        const { name } = request.params as { name: string };
        const body = request.body as { inputs?: Record<string, unknown> } | null;
        const inputs = body?.inputs ?? {};

        logger.info({ workflow: name, inputs }, 'Manual workflow run triggered via dashboard');

        try {
            const result = await deps.runWorkflow(name, inputs);
            if (!result.ok) {
                return reply.status(404).send({ error: result.error });
            }
            return { ok: true, message: `Workflow "${name}" started` };
        } catch (err: any) {
            logger.error({ workflow: name, err }, 'Manual workflow run failed');
            return reply.status(500).send({ error: err.message ?? 'Workflow execution failed' });
        }
    });

    // ─── Workflow details (single) ──────────────────────────────────────

    server.get('/api/workflows/:name/details', async (request, reply) => {
        const { name } = request.params as { name: string };
        const config = deps.getConfig();
        const workflow = config.workflows?.find((w) => w.name === name);
        if (!workflow) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }
        return { workflow };
    });

    // ─── Run History ────────────────────────────────────────────────────

    server.get('/api/runs', async (request) => {
        const { workflow } = (request.query ?? {}) as { workflow?: string };
        return { runs: deps.getRunHistory(workflow) };
    });

    server.get('/api/workflows/:name/runs', async (request) => {
        const { name } = request.params as { name: string };
        return { runs: deps.getRunHistory(name) };
    });

    server.post('/api/runs/:id/rerun', async (request, reply) => {
        const { id } = request.params as { id: string };
        logger.info({ runId: id }, 'Rerun triggered via dashboard');

        try {
            const result = await deps.rerunWorkflow(id);
            if (!result.ok) {
                return reply.status(404).send({ error: result.error });
            }
            return { ok: true, runId: result.runId, message: 'Workflow rerun started' };
        } catch (err: any) {
            logger.error({ runId: id, err }, 'Rerun failed');
            return reply.status(500).send({ error: err.message ?? 'Rerun failed' });
        }
    });

    // ─── My PRs (gh CLI powered) ────────────────────────────────────────

    server.get('/api/my-prs', async (_request, reply) => {
        try {
            // Dynamic import to avoid hard dependency
            const { GhCliIntegration } = await import('../integrations/gh-cli/index.js');
            const prs = await GhCliIntegration.listMyPrs();
            return { prs };
        } catch (err: any) {
            logger.warn({ err }, 'Failed to list PRs via gh CLI');
            return reply.status(503).send({
                error: 'gh CLI not available. Install and authenticate: https://cli.github.com/',
                prs: [],
            });
        }
    });

    server.get('/api/prs/:owner/:repo/:number', async (request, reply) => {
        const { owner, repo, number } = request.params as { owner: string; repo: string; number: string };
        try {
            const { GhCliIntegration } = await import('../integrations/gh-cli/index.js');
            const pr = await GhCliIntegration.getPrDetails(`${owner}/${repo}`, Number(number));
            return { pr };
        } catch (err: any) {
            logger.warn({ err, owner, repo, number }, 'Failed to fetch PR details');
            return reply.status(503).send({ error: err.message ?? 'Failed to fetch PR' });
        }
    });

    // ─── My Issues (gh CLI powered) ──────────────────────────────────────

    server.get('/api/my-issues', async (_request, reply) => {
        try {
            const { GhCliIntegration } = await import('../integrations/gh-cli/index.js');
            const issues = await GhCliIntegration.listMyIssues();
            return { issues };
        } catch (err: any) {
            logger.warn({ err }, 'Failed to list issues via gh CLI');
            return reply.status(503).send({
                error: 'gh CLI not available. Install and authenticate: https://cli.github.com/',
                issues: [],
            });
        }
    });

    server.get('/api/issues/:owner/:repo/:number', async (request, reply) => {
        const { owner, repo, number } = request.params as { owner: string; repo: string; number: string };
        try {
            const { GhCliIntegration } = await import('../integrations/gh-cli/index.js');
            const issue = await GhCliIntegration.getIssueDetails(`${owner}/${repo}`, Number(number));
            return { issue };
        } catch (err: any) {
            logger.warn({ err, owner, repo, number }, 'Failed to fetch issue details');
            return reply.status(503).send({ error: err.message ?? 'Failed to fetch issue' });
        }
    });

    // ─── Issue Actions (config-based quick actions) ─────────────────────

    server.get('/api/issue-actions', async () => {
        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const actions = (parsed.issueActions as unknown[]) ?? [];
        return { actions };
    });

    server.post('/api/issue-actions', async (request, reply) => {
        const action = request.body as Record<string, unknown>;
        if (!action?.id || !action?.name) {
            return reply.status(400).send({ error: 'Issue action must have id and name' });
        }

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const actions = ((parsed.issueActions as unknown[]) ?? []) as Record<string, unknown>[];

        if (actions.some((a) => a.id === action.id)) {
            return reply.status(409).send({ error: `Issue action "${action.id}" already exists` });
        }

        actions.push(action);
        parsed.issueActions = actions;

        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ action: action.id }, 'Issue action created via dashboard');
        return { ok: true, action };
    });

    server.put('/api/issue-actions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const update = request.body as Record<string, unknown>;

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const actions = ((parsed.issueActions as unknown[]) ?? []) as Record<string, unknown>[];

        const idx = actions.findIndex((a) => a.id === id);
        if (idx === -1) {
            return reply.status(404).send({ error: `Issue action "${id}" not found` });
        }

        actions[idx] = { ...update, id: update.id ?? id };
        parsed.issueActions = actions;

        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ action: id }, 'Issue action updated via dashboard');
        return { ok: true, action: actions[idx] };
    });

    server.delete('/api/issue-actions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const actions = ((parsed.issueActions as unknown[]) ?? []) as Record<string, unknown>[];

        const filtered = actions.filter((a) => a.id !== id);
        if (filtered.length === actions.length) {
            return reply.status(404).send({ error: `Issue action "${id}" not found` });
        }

        parsed.issueActions = filtered;
        const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
        await writeFile(deps.getConfigPath(), yamlStr, 'utf-8');
        logger.info({ action: id }, 'Issue action deleted via dashboard');
        return { ok: true };
    });

    server.post('/api/issue-actions/:id/run', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { owner: string; repo: string; issueNumber: number };

        if (!body?.owner || !body?.repo || !body?.issueNumber) {
            return reply.status(400).send({ error: 'Missing owner, repo, or issueNumber' });
        }

        const raw = await readFile(deps.getConfigPath(), 'utf-8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const actions = ((parsed.issueActions as unknown[]) ?? []) as Record<string, unknown>[];
        const action = actions.find((a) => a.id === id);

        if (!action) {
            return reply.status(404).send({ error: `Issue action "${id}" not found` });
        }

        const workflowName = action.workflow as string | undefined;
        if (!workflowName) {
            return reply.status(400).send({ error: `Issue action "${id}" has no workflow configured` });
        }

        logger.info({ actionId: id, workflow: workflowName, issue: body.issueNumber }, 'Issue action triggered');

        try {
            const result = await deps.runWorkflow(workflowName, {
                issue: {
                    number: body.issueNumber,
                    owner: body.owner,
                    repo: body.repo,
                    url: `https://github.com/${body.owner}/${body.repo}/issues/${body.issueNumber}`,
                },
            });
            if (!result.ok) {
                return reply.status(500).send({ error: result.error });
            }
            return { ok: true, message: `Action "${action.name}" started for issue #${body.issueNumber}` };
        } catch (err: any) {
            logger.error({ actionId: id, err }, 'Issue action failed');
            return reply.status(500).send({ error: err.message ?? 'Action execution failed' });
        }
    });

    // ─── Templates ──────────────────────────────────────────────────────

    server.get('/api/templates', async () => {
        const dir = deps.getTemplateDir();
        let files: string[];
        try {
            files = await readdir(dir);
        } catch {
            return { templates: [] };
        }

        const templates = [];
        for (const file of files) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
            const name = basename(file, extname(file));
            const content = await readFile(join(dir, file), 'utf-8');
            const parsed = yaml.load(content) as Record<string, unknown>;
            templates.push({
                name,
                trigger: parsed.trigger,
                steps: parsed.steps,
                raw: content,
            });
        }

        return { templates };
    });

    // Library templates (separate from user templates)
    server.get('/api/templates/library', async () => {
        const dir = join(deps.getTemplateDir(), 'library');
        let files: string[];
        try {
            files = await readdir(dir);
        } catch {
            return { templates: [] };
        }

        const templates = [];
        for (const file of files) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
            const name = basename(file, extname(file));
            const content = await readFile(join(dir, file), 'utf-8');
            templates.push({ name, content });
        }

        return { templates };
    });

    server.post('/api/templates', async (request, reply) => {
        const body = request.body as { name: string; content: string };
        if (!body?.name || !body?.content) {
            return reply.status(400).send({ error: 'Template requires name and content' });
        }
        const safeName = body.name.replace(/[^a-zA-Z0-9_-]/g, '-');
        const filePath = join(deps.getTemplateDir(), `${safeName}.yaml`);

        try {
            yaml.load(body.content); // Validate YAML
        } catch (e: any) {
            return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
        }

        await writeFile(filePath, body.content, 'utf-8');
        logger.info({ template: safeName }, 'Template created via dashboard');
        return { ok: true, name: safeName };
    });

    server.put('/api/templates/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const body = request.body as { content: string };
        if (!body?.content) {
            return reply.status(400).send({ error: 'Template content required' });
        }

        const filePath = join(deps.getTemplateDir(), `${name}.yaml`);
        try {
            await readFile(filePath, 'utf-8'); // check it exists
        } catch {
            return reply.status(404).send({ error: `Template "${name}" not found` });
        }

        try {
            yaml.load(body.content);
        } catch (e: any) {
            return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
        }

        await writeFile(filePath, body.content, 'utf-8');
        logger.info({ template: name }, 'Template updated via dashboard');
        return { ok: true };
    });

    server.delete('/api/templates/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const filePath = join(deps.getTemplateDir(), `${name}.yaml`);

        try {
            await readFile(filePath, 'utf-8');
        } catch {
            return reply.status(404).send({ error: `Template "${name}" not found` });
        }

        const { unlink } = await import('node:fs/promises');
        await unlink(filePath);
        logger.info({ template: name }, 'Template deleted via dashboard');
        return { ok: true };
    });

    // ─── Integrations ───────────────────────────────────────────────────

    server.get('/api/integrations', async () => {
        return { integrations: deps.getIntegrationStatus() };
    });

    // ─── Actions registry ───────────────────────────────────────────────

    server.get('/api/actions', async () => {
        return { actions: deps.getRegisteredActions() };
    });

    // ─── Queue ──────────────────────────────────────────────────────────

    server.get('/api/queue', async () => {
        const queue = deps.getQueue?.();
        if (!queue) {
            return { stats: null, jobs: [] };
        }
        const stats = queue.getStats();
        const jobs = queue.getJobs();
        return {
            stats,
            jobs: jobs.map(serializeJob),
        };
    });

    server.get('/api/queue/jobs', async (request) => {
        const queue = deps.getQueue?.();
        if (!queue) return { jobs: [] };
        const { status } = (request.query ?? {}) as { status?: string };
        const jobs = queue.getJobs(status as any);
        return { jobs: jobs.map(serializeJob) };
    });

    server.post('/api/queue/jobs/:id/cancel', async (request, reply) => {
        const queue = deps.getQueue?.();
        if (!queue) return reply.status(503).send({ error: 'Queue not available' });
        const { id } = request.params as { id: string };
        const ok = queue.cancel(id);
        if (!ok) return reply.status(404).send({ error: `Job "${id}" not found in queue or running` });
        logger.info({ jobId: id }, 'Job cancelled via dashboard');
        return { ok: true };
    });

    server.post('/api/queue/jobs/:id/retry', async (request, reply) => {
        const queue = deps.getQueue?.();
        if (!queue) return reply.status(503).send({ error: 'Queue not available' });
        const { id } = request.params as { id: string };
        const ok = queue.retry(id);
        if (!ok) return reply.status(404).send({ error: `Job "${id}" not found or not retryable` });
        logger.info({ jobId: id }, 'Job retried via dashboard');
        return { ok: true };
    });

    // ─── Events (REST — persisted history) ──────────────────────────────

    server.get('/api/events', async () => {
        return { events: deps.getRecentEvents() };
    });

    // ─── Events stats ───────────────────────────────────────────────────

    server.get('/api/events/stats', async () => {
        const allEvents = deps.getRecentEvents();
        const now = Date.now();
        const hour = 60 * 60 * 1000;

        // Events in last hour
        const lastHour = allEvents.filter((e) => now - new Date(e.timestamp).getTime() < hour);

        // By source
        const bySource: Record<string, number> = {};
        for (const e of allEvents) {
            const src = e.event?.source ?? 'unknown';
            bySource[src] = (bySource[src] ?? 0) + 1;
        }

        // By event type
        const byEvent: Record<string, number> = {};
        for (const e of allEvents) {
            const evt = e.event?.event ?? 'unknown';
            byEvent[evt] = (byEvent[evt] ?? 0) + 1;
        }

        // Top triggered workflows
        const byWorkflow: Record<string, number> = {};
        for (const e of allEvents) {
            for (const wf of e.matchedWorkflows ?? []) {
                byWorkflow[wf] = (byWorkflow[wf] ?? 0) + 1;
            }
        }

        // Events per hour (last 24h)
        const hourlyBuckets: { hour: string; count: number }[] = [];
        for (let i = 23; i >= 0; i--) {
            const bucketStart = now - (i + 1) * hour;
            const bucketEnd = now - i * hour;
            const count = allEvents.filter((e) => {
                const t = new Date(e.timestamp).getTime();
                return t >= bucketStart && t < bucketEnd;
            }).length;
            const d = new Date(bucketEnd);
            hourlyBuckets.push({
                hour: `${d.getHours().toString().padStart(2, '0')}:00`,
                count,
            });
        }

        return {
            total: allEvents.length,
            lastHour: lastHour.length,
            bySource,
            byEvent,
            byWorkflow,
            hourlyBuckets,
        };
    });

    // ─── Events stream (SSE) ────────────────────────────────────────────

    server.get('/api/events/stream', async (request, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        reply.raw.write('data: {"type":"connected"}\n\n');

        const unsubscribe = deps.addEventSubscriber((event) => {
            try {
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch { /* client disconnected */ }
        });

        const heartbeat = setInterval(() => {
            try { reply.raw.write(': heartbeat\n\n'); } catch { /* */ }
        }, 30_000);

        request.raw.on('close', () => {
            unsubscribe();
            clearInterval(heartbeat);
        });
    });

    // ─── GitHub Proxy (for smart pickers) ───────────────────────────────

    /** Resolve a GitHub token from integration configs */
    function getGitHubToken(): string | null {
        const config = deps.getConfig();
        const gh = config.integrations?.github as Record<string, unknown> | undefined;
        const ghPoll = config.integrations?.['github-poll'] as Record<string, unknown> | undefined;
        return (gh?.token as string) ?? (ghPoll?.token as string) ?? null;
    }

    /** Proxy a GET request to the GitHub API */
    async function githubProxyGet(path: string, query?: Record<string, string>): Promise<unknown> {
        const token = getGitHubToken();
        if (!token) throw new Error('No GitHub token configured');

        const url = new URL(`https://api.github.com${path}`);
        if (query) {
            for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        }

        const res = await fetch(url.toString(), {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });

        if (!res.ok) {
            throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
        }

        return await res.json();
    }

    // List open PRs for a repo
    server.get('/api/github/:owner/:repo/pulls', async (request, reply) => {
        const { owner, repo } = request.params as { owner: string; repo: string };
        const { state } = (request.query ?? {}) as { state?: string };
        try {
            const prs = await githubProxyGet(
                `/repos/${owner}/${repo}/pulls`,
                { state: state ?? 'open', sort: 'updated', direction: 'desc', per_page: '30' },
            ) as Array<Record<string, unknown>>;

            return {
                items: prs.map((pr) => ({
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    author: (pr.user as Record<string, unknown>)?.login,
                    head: {
                        ref: (pr.head as Record<string, unknown>)?.ref,
                        sha: (pr.head as Record<string, unknown>)?.sha,
                    },
                    base: {
                        ref: (pr.base as Record<string, unknown>)?.ref,
                    },
                    labels: ((pr.labels as Array<Record<string, unknown>>) ?? []).map((l) => l.name),
                    created_at: pr.created_at,
                    updated_at: pr.updated_at,
                    draft: pr.draft,
                })),
            };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // List open issues for a repo
    server.get('/api/github/:owner/:repo/issues', async (request, reply) => {
        const { owner, repo } = request.params as { owner: string; repo: string };
        const { state } = (request.query ?? {}) as { state?: string };
        try {
            const issues = await githubProxyGet(
                `/repos/${owner}/${repo}/issues`,
                { state: state ?? 'open', sort: 'updated', direction: 'desc', per_page: '30', filter: 'all' },
            ) as Array<Record<string, unknown>>;

            return {
                items: issues
                    .filter((i) => !i.pull_request) // Exclude PRs
                    .map((issue) => ({
                        number: issue.number,
                        title: issue.title,
                        state: issue.state,
                        author: (issue.user as Record<string, unknown>)?.login,
                        labels: ((issue.labels as Array<Record<string, unknown>>) ?? []).map((l) => l.name),
                        created_at: issue.created_at,
                        updated_at: issue.updated_at,
                    })),
            };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // List branches for a repo
    server.get('/api/github/:owner/:repo/branches', async (request, reply) => {
        const { owner, repo } = request.params as { owner: string; repo: string };
        try {
            const branches = await githubProxyGet(
                `/repos/${owner}/${repo}/branches`,
                { per_page: '50' },
            ) as Array<Record<string, unknown>>;

            return {
                items: branches.map((b) => ({
                    name: b.name,
                    sha: ((b.commit as Record<string, unknown>)?.sha as string)?.slice(0, 8),
                    protected: b.protected,
                })),
            };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // List repos from config + user's accessible repos
    server.get('/api/github/repos', async (_request, reply) => {
        try {
            const config = deps.getConfig();
            // Gather repos from integrations config
            const configRepos = new Set<string>();
            const ghPoll = config.integrations?.['github-poll'] as Record<string, unknown> | undefined;
            if (ghPoll?.repos && Array.isArray(ghPoll.repos)) {
                for (const r of ghPoll.repos) configRepos.add(r as string);
            }
            // Also gather from workflow triggers
            for (const wf of config.workflows ?? []) {
                const repos = Array.isArray(wf.trigger?.repo) ? wf.trigger.repo : wf.trigger?.repo ? [wf.trigger.repo] : [];
                for (const r of repos) configRepos.add(r);
            }

            // Fetch user's repos from GitHub for discovery
            let apiRepos: Array<{ full_name: string; description: string | null }> = [];
            try {
                const userRepos = await githubProxyGet(
                    '/user/repos',
                    { sort: 'updated', direction: 'desc', per_page: '30', type: 'all' },
                ) as Array<Record<string, unknown>>;
                apiRepos = userRepos.map((r) => ({
                    full_name: r.full_name as string,
                    description: r.description as string | null,
                }));
            } catch { /* token may not have user scope - that's fine */ }

            // Merge: config repos first, then API repos
            const seen = new Set<string>();
            const items: Array<{ full_name: string; description?: string | null; source: string }> = [];

            for (const r of configRepos) {
                seen.add(r);
                items.push({ full_name: r, source: 'config' });
            }
            for (const r of apiRepos) {
                if (!seen.has(r.full_name)) {
                    seen.add(r.full_name);
                    items.push({ full_name: r.full_name, description: r.description, source: 'github' });
                }
            }

            return { items };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });
}

function serializeJob(job: import('../core/types.js').QueueJob) {
    return {
        id: job.id,
        workflowName: job.workflow.name,
        status: job.status,
        priority: job.priority,
        dedupKey: job.dedupKey,
        enqueuedAt: job.enqueuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        attempts: job.attempts,
        event: {
            source: job.event.source,
            event: job.event.event,
            action: job.event.action,
        },
    };
}
