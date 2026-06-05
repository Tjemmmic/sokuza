import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import yaml from 'js-yaml';
import type { SokuzaConfig, EventPayload, WebhookDelivery, WorkflowRunRecord } from '../core/types.js';
import type { WorkflowQueue } from '../core/queue.js';
import type { ConfigStore } from '../core/config-store.js';
import { ARGS_STYLES } from '../core/args-styles.js';
import type { LogStore } from '../core/log-store.js';
import { VERSION } from '../version.js';
import { serviceStatus, installService, uninstallService, restartService, isServiceInstalled } from '../cli/service.js';
import { runUpdateCommand, resolveEntryPath } from '../cli/update.js';
import { readUpdateCache, refreshUpdateCache, isNewer } from '../cli/update-check.js';

interface ApiDeps {
    logger: Logger;
    logStore: LogStore;
    configStore: ConfigStore;
    getTemplateDir: () => string;
    getIntegrationStatus: () => Record<string, { enabled: boolean; events: string[] }>;
    getRecentEvents: () => EventEntry[];
    addEventSubscriber: (cb: (event: unknown) => void) => () => void;
    /** Push an arbitrary payload to every SSE subscriber. Used to
     *  forward run-store and other engine-side events through the same
     *  feed the dashboard already listens to. */
    broadcastEvent: (payload: unknown) => void;
    getRegisteredActions: () => string[];
    runWorkflow: (name: string, inputs: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; runId?: string }>;
    rerunWorkflow: (runId: string) => Promise<{ ok: boolean; error?: string; runId?: string }>;
    replayEvent: (eventIndex: number) => { ok: boolean; error?: string };
    getRunHistory: (workflowName?: string) => WorkflowRunRecord[];
    getConfig: () => SokuzaConfig;
    getQueue?: () => WorkflowQueue;
    previewEvent: (event: EventPayload) => { matched: string[]; unmatched: Array<{ name: string; reason: string }> };
    getWebhookDeliveries: (workflowName?: string) => WebhookDelivery[];
    /** Force the engine to re-read the config from disk (workflows + AI + queue + integrations). */
    reloadConfig: () => Promise<void>;
    /** Handle to the running engine — used by chat tools to call `runWorkflowByName`. */
    getEngine: () => import('../core/engine.js').SokuzaEngine;
    /** Chat session store — shared by all /api/chat/* handlers. */
    getChatStore: () => import('../core/chat-store.js').ChatStore;
    /** Persistent per-PR git workdir manager for the address-review action. */
    getWorkdirManager: () => import('../core/workdir-store.js').WorkdirManager;
    /** Per-user node preset store — populated by library installs and
     *  surfaced as a "Presets" group in the editor's node palette. */
    getPresetStore: () => import('../core/preset-store.js').PresetStore;
}

function sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

// ─── Chat session helpers ───────────────────────────────────────────────────
//
// `parseSessionScope` validates the body of POST /api/chat/sessions, and
// `gatherSessionContext` runs the same github-clone-repo + github-fetch-diff
// pipeline a PR review would, so a fresh session has a real workdir and
// (for PR scopes) a diff cached for `get_diff` tool calls.

import type { SessionScope, ChatSession, ChatMessage } from '../core/types.js';

function parseSessionScope(raw: unknown): SessionScope | Error {
    if (!raw || typeof raw !== 'object') {
        return new Error('scope is required (one of: {kind:"repo", repo}, {kind:"branch", repo, ref}, {kind:"pr", repo, ref, prNumber})');
    }
    const s = raw as Record<string, unknown>;
    const kind = s.kind;
    const repo = s.repo;
    if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        return new Error('scope.repo must be "owner/name"');
    }

    if (kind === 'repo') {
        const ref = typeof s.ref === 'string' && s.ref ? s.ref : undefined;
        return { kind: 'repo', repo, ref };
    }
    if (kind === 'branch') {
        const ref = typeof s.ref === 'string' ? s.ref : '';
        if (!ref) return new Error('scope.ref is required for branch scopes');
        return { kind: 'branch', repo, ref };
    }
    if (kind === 'pr') {
        const ref = typeof s.ref === 'string' ? s.ref : '';
        const prNumber = typeof s.prNumber === 'number' ? s.prNumber : Number(s.prNumber);
        if (!ref) return new Error('scope.ref is required for PR scopes (the PR head branch)');
        if (!Number.isFinite(prNumber) || prNumber <= 0) return new Error('scope.prNumber must be a positive integer');
        return {
            kind: 'pr',
            repo,
            ref,
            prNumber,
            title: typeof s.title === 'string' ? s.title : undefined,
            author: typeof s.author === 'string' ? s.author : undefined,
        };
    }
    return new Error(`scope.kind must be "repo" | "branch" | "pr" (got "${kind}")`);
}

async function gatherSessionContext(
    session: ChatSession,
    scope: SessionScope,
    deps: ApiDeps,
    log: import('pino').Logger,
): Promise<void> {
    // Reuse the existing actions — we don't want a parallel clone path.
    const { githubCloneRepoAction } = await import('../integrations/github/actions/clone-repo.js');

    // Clone into the session's workdir (not /tmp). For plain repo scopes
    // we don't have a ref; githubCloneRepoAction falls back to main.
    const cloneParams: Record<string, unknown> = {
        repo: scope.repo,
        destDir: session.workdir,
    };
    if (scope.kind !== 'repo') cloneParams.ref = scope.ref;
    if (scope.kind === 'repo') cloneParams.depth = 1;
    else if (scope.kind === 'branch') cloneParams.depth = 50;

    const cloneCtx = {
        event: {
            source: 'chat' as const,
            event: 'chat.session.create',
            timestamp: new Date().toISOString(),
            payload: {},
            metadata: {
                repo: scope.repo,
                ...(scope.kind === 'pr' ? { prNumber: scope.prNumber } : {}),
            },
        },
        results: {},
        steps: {},
        integrationConfigs: deps.getConfig().integrations,
        ai: deps.getConfig().ai!,
        logger: log,
    };
    await githubCloneRepoAction(cloneParams, cloneCtx as never);
    log.info({ sessionId: session.id, workdir: session.workdir }, 'Chat session workdir cloned');

    const store = deps.getChatStore();

    // Seed the session with a system message describing the scope.
    const scopeBlurb = describeScope(scope);
    await store.appendMessage(session.id, { role: 'system', content: scopeBlurb });

    // For PR-scoped sessions, cache the diff as a system message so
    // `get_diff` can return it without a GitHub round-trip later.
    if (scope.kind === 'pr') {
        const { githubFetchDiffAction } = await import('../integrations/github/actions/fetch-diff.js');
        const fetchCtx = {
            ...cloneCtx,
            event: {
                ...cloneCtx.event,
                payload: {
                    pull_request: { number: scope.prNumber, head: { ref: scope.ref }, base: {} },
                },
                metadata: { ...cloneCtx.event.metadata, prNumber: scope.prNumber },
            },
        };
        try {
            const diffResult = await githubFetchDiffAction({ repo: scope.repo, pr_number: scope.prNumber }, fetchCtx as never);
            const diff = (diffResult as { diff?: string })?.diff;
            if (diff) {
                const { formatDiffCache } = await import('../core/chat-tools.js');
                await store.appendMessage(session.id, {
                    role: 'system',
                    content: formatDiffCache(diff),
                });
                log.info({ sessionId: session.id, diffLength: diff.length }, 'Cached PR diff for chat session');
            }
        } catch (err: any) {
            // Diff fetching is best-effort — a session without a cached diff
            // still works; get_diff will return an error the model can
            // relay to the user.
            log.warn({ sessionId: session.id, err: err?.message }, 'Failed to cache PR diff');
        }
    }
}

function describeScope(scope: SessionScope): string {
    if (scope.kind === 'repo') return `Session scoped to repo: ${scope.repo}${scope.ref ? ` @ ${scope.ref}` : ''}`;
    if (scope.kind === 'branch') return `Session scoped to branch: ${scope.ref} of ${scope.repo}`;
    return `Session scoped to PR #${scope.prNumber} of ${scope.repo} (branch ${scope.ref})${scope.title ? ` — "${scope.title}"` : ''}`;
}

// `ChatMessage` is re-exported for use in the API surface (e.g. GET session).
export type { ChatMessage };

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

    // Bridge the run-store's in-process emitter onto the SSE feed so
    // the dashboard's AI Reviews page refreshes when a new ai-review
    // record is written or labeled.
    void import('../core/run-store.js').then(({ runStoreEvents }) => {
        runStoreEvents.on('ai-review-run', (summary) => {
            deps.broadcastEvent({ type: 'ai-review-run', summary });
        });
        runStoreEvents.on('address-review-run', (summary) => {
            deps.broadcastEvent({ type: 'address-review-run', summary });
        });
    });

    // ─── Config ─────────────────────────────────────────────────────────

    server.get('/api/config', async () => {
        const raw = await deps.configStore.readRaw();
        const parsed = yaml.load(raw) as Record<string, unknown>;
        // `raw` is the source of truth for the Settings page editor —
        // the dashboard used to call its own hand-rolled YAML serializer
        // on `parsed`, which flattened nested object values inside array
        // items to one indent level (turning `trigger:\n  source: x`
        // into `trigger:\n  source: x` at the wrong column, eventually
        // corrupting workflows[].graph.nodes[].config and producing
        // duplicate-mapping-key errors on the next reload). Returning
        // the raw text lets the editor show exactly what's on disk.
        return { config: parsed, raw };
    });

    server.put('/api/config', async (request, reply) => {
        const body = request.body as Record<string, unknown>;

        try {
            if (typeof body.__raw_yaml === 'string') {
                await deps.configStore.writeRaw(body.__raw_yaml);
            } else if (body.config && typeof (body.config as any).__raw_yaml === 'string') {
                await deps.configStore.writeRaw((body.config as any).__raw_yaml as string);
            } else if (body.config) {
                await deps.configStore.write(body.config as Record<string, unknown>);
            } else {
                return reply.status(400).send({ error: 'Missing config in body' });
            }
        } catch (e: any) {
            // js-yaml throws `YAMLException` with messages like "duplicated
            // mapping key" or "bad indentation" that don't contain the
            // word "YAML" — checking the constructor name catches every
            // parse failure without false-positive on unrelated runtime
            // errors (disk full, EACCES, etc.) which should propagate
            // as 500.
            const isYamlError = e?.name === 'YAMLException' || e?.message?.includes('YAML');
            if (isYamlError) {
                return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
            }
            throw e;
        }

        logger.info('Config updated via dashboard');
        return { ok: true };
    });

    // ─── Deck ───────────────────────────────────────────────────────────

    server.get('/api/deck', async () => {
        const config = await deps.configStore.readRaw();
        const parsed = yaml.load(config) as Record<string, unknown>;
        const deck = (parsed.deck as string[]) ?? [];
        return { deck };
    });

    server.post('/api/deck/add', async (request, reply) => {
        const { id } = request.body as { id: string };
        if (!id) {
            return reply.status(400).send({ error: 'Missing id' });
        }

        const deck = await deps.configStore.updateRaw((config) => {
            const deck = ((config.deck as string[]) ?? []);
            if (!deck.includes(id)) {
                deck.push(id);
                config.deck = deck;
            }
            return deck;
        });

        logger.info({ id }, 'Added to deck');
        return { ok: true, deck };
    });

    server.delete('/api/deck/:id', async (request) => {
        const { id } = request.params as { id: string };

        const deck = await deps.configStore.updateRaw((config) => {
            const deck = ((config.deck as string[]) ?? []).filter(d => d !== id);
            config.deck = deck;
            return deck;
        });

        logger.info({ id }, 'Removed from deck');
        return { ok: true, deck };
    });

    // ─── Workflows ──────────────────────────────────────────────────────

    server.get('/api/workflows', async () => {
        const config = await deps.configStore.readRaw();
        const parsed = yaml.load(config) as Record<string, unknown>;
        const workflows = (parsed.workflows as unknown[]) ?? [];
        return { workflows };
    });

    server.post('/api/workflows', async (request, reply) => {
        const workflow = request.body as Record<string, unknown>;
        if (!workflow?.name) {
            return reply.status(400).send({ error: 'Workflow must have a name' });
        }

        const result = await deps.configStore.updateRaw((config) => {
            const workflows = ((config.workflows as unknown[]) ?? []) as Record<string, unknown>[];
            if (workflows.some((w) => w.name === workflow.name)) {
                return { duplicate: true as const };
            }
            workflows.push(workflow);
            config.workflows = workflows;
            return { duplicate: false as const };
        });

        if (result.duplicate) {
            return reply.status(409).send({ error: `Workflow "${workflow.name}" already exists` });
        }

        // Bring the engine's in-memory config into sync with the freshly-
        // written YAML. Without this, `GET /:name/details` (which reads
        // from `getConfig()`, not the raw YAML) would 404 on the workflow
        // the dashboard just created — making installed/duplicated
        // workflows un-editable until the next reload.
        await deps.reloadConfig();

        // Library install hook: when the dashboard tags a workflow with
        // `_libraryItem` it means "this workflow comes from a library
        // template". Walk that template's graph and replace any presets
        // we previously extracted for it with a fresh set — silent
        // auto-extraction so the security-audit prompt the template
        // author wrote becomes a drop-in palette node on next editor
        // open. Best-effort: a failure here logs but doesn't fail the
        // install (presets are a discoverability nicety, not core).
        const libraryItem = typeof workflow._libraryItem === 'string' ? workflow._libraryItem : null;
        const templateName = typeof workflow.template === 'string' ? workflow.template : null;
        if (libraryItem && templateName) {
            try {
                const { loadTemplates } = await import('../core/templates.js');
                const { extractPresetsFromTemplate } = await import('../core/preset-store.js');
                const templates = await loadTemplates(deps.getTemplateDir());
                const tmpl = templates[templateName];
                if (tmpl?.graph) {
                    const presets = extractPresetsFromTemplate(templateName, tmpl.graph, {});
                    await deps.getPresetStore().replaceBySource(`library:${libraryItem}`, presets);
                    logger.info({ workflow: workflow.name, libraryItem, count: presets.length }, 'Extracted node presets from library template');
                }
            } catch (err) {
                logger.warn({ err, workflow: workflow.name, libraryItem }, 'Failed to extract presets from library template');
            }
        }

        logger.info({ workflow: workflow.name }, 'Workflow created via dashboard');
        return { ok: true, workflow };
    });

    server.put('/api/workflows/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const update = request.body as Record<string, unknown>;

        const result = await deps.configStore.updateRaw((config) => {
            const workflows = ((config.workflows as unknown[]) ?? []) as Record<string, unknown>[];
            const idx = workflows.findIndex((w) => w.name === name);
            if (idx === -1) return { found: false as const, workflow: null as Record<string, unknown> | null };
            workflows[idx] = { ...update, name: update.name ?? name };
            config.workflows = workflows;
            return { found: true as const, workflow: workflows[idx] };
        });

        if (!result.found) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }

        await deps.reloadConfig();

        logger.info({ workflow: name }, 'Workflow updated via dashboard');
        return { ok: true, workflow: result.workflow };
    });

    // Quick enable/disable from the Workflows tab without opening the
    // editor. Body `{ enabled: bool }` sets it explicitly; an empty body
    // flips the current state (default is enabled, so a workflow with no
    // `enabled` field toggles to disabled).
    server.post('/api/workflows/:name/toggle', async (request, reply) => {
        const { name } = request.params as { name: string };
        const body = (request.body ?? {}) as { enabled?: unknown };
        // Only an explicit boolean sets the state; anything else (missing,
        // or a non-boolean like the string "true") flips the current state.
        // `name` is used purely as an equality lookup below — never as a
        // filesystem path — so no path-traversal surface.
        const explicitEnabled = body.enabled === true ? true : body.enabled === false ? false : null;

        const result = await deps.configStore.updateRaw((config) => {
            const workflows = ((config.workflows as unknown[]) ?? []) as Record<string, unknown>[];
            const wf = workflows.find((w) => w.name === name);
            if (!wf) return { found: false as const, enabled: false };
            const next = explicitEnabled !== null
                ? explicitEnabled
                : wf.enabled === false; // currently disabled → enable, else disable
            // Keep the YAML clean: an enabled workflow is the default, so
            // drop the field rather than writing `enabled: true`.
            if (next) delete wf.enabled;
            else wf.enabled = false;
            config.workflows = workflows;
            return { found: true as const, enabled: next };
        });

        if (!result.found) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }

        await deps.reloadConfig();
        logger.info({ workflow: name, enabled: result.enabled }, 'Workflow toggled via dashboard');
        return { ok: true, enabled: result.enabled };
    });

    server.delete('/api/workflows/:name', async (request, reply) => {
        const { name } = request.params as { name: string };

        // Capture the workflow's library origin BEFORE deletion so we
        // can cascade cleanup (deck + presets) afterwards. Without
        // this, manually deleting an installed workflow via the
        // workflows page would leave the library badge stuck on
        // "Installed" with no workflow behind it — and the auto-
        // extracted presets stranded with nothing to drop them onto.
        let libraryItem: string | null = null;
        const found = await deps.configStore.updateRaw((config) => {
            const workflows = ((config.workflows as unknown[]) ?? []) as Record<string, unknown>[];
            const target = workflows.find((w) => w.name === name);
            if (!target) return false;
            if (typeof target._libraryItem === 'string') libraryItem = target._libraryItem;
            const filtered = workflows.filter((w) => w.name !== name);
            config.workflows = filtered;
            return true;
        });

        if (!found) {
            return reply.status(404).send({ error: `Workflow "${name}" not found` });
        }

        await deps.reloadConfig();

        if (libraryItem) {
            // Remove the orphaned deck entry so the library card flips
            // back to "Install" instead of getting stuck on "Installed".
            try {
                await deps.configStore.updateRaw((config) => {
                    const deck = ((config.deck as string[]) ?? []).filter((d) => d !== libraryItem);
                    config.deck = deck;
                    return deck;
                });
            } catch (err) {
                logger.warn({ err, libraryItem }, 'Failed to clean deck entry after workflow delete');
            }
            // Drop any presets that came from this library template.
            try {
                const removed = await deps.getPresetStore().deleteBySource(`library:${libraryItem}`);
                if (removed > 0) logger.info({ libraryItem, removed }, 'Removed library-extracted presets on workflow delete');
            } catch (err) {
                logger.warn({ err, libraryItem }, 'Failed to clean presets after workflow delete');
            }
        }

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
        // Project the effective (merged) trigger back into the graph's
        // trigger node so the visual editor shows the truth — e.g. a
        // `source: gh-cli` + `author:` workflow whose graph node is a stale
        // `trigger.github` with no author. Read-path only; never persisted
        // unless the user saves.
        const { syncTriggerNodeFromWorkflow } = await import('../core/nodes/graph-trigger.js');
        return { workflow: syncTriggerNodeFromWorkflow(workflow) };
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
        const config = await deps.configStore.readRaw();
        const parsed = yaml.load(config) as Record<string, unknown>;
        const actions = (parsed.issueActions as unknown[]) ?? [];
        return { actions };
    });

    server.post('/api/issue-actions', async (request, reply) => {
        const action = request.body as Record<string, unknown>;
        if (!action?.id || !action?.name) {
            return reply.status(400).send({ error: 'Issue action must have id and name' });
        }

        const result = await deps.configStore.updateRaw((config) => {
            const actions = ((config.issueActions as unknown[]) ?? []) as Record<string, unknown>[];
            if (actions.some((a) => a.id === action.id)) {
                return { duplicate: true as const };
            }
            actions.push(action);
            config.issueActions = actions;
            return { duplicate: false as const };
        });

        if (result.duplicate) {
            return reply.status(409).send({ error: `Issue action "${action.id}" already exists` });
        }

        logger.info({ action: action.id }, 'Issue action created via dashboard');
        return { ok: true, action };
    });

    server.put('/api/issue-actions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const update = request.body as Record<string, unknown>;

        const result = await deps.configStore.updateRaw((config) => {
            const actions = ((config.issueActions as unknown[]) ?? []) as Record<string, unknown>[];
            const idx = actions.findIndex((a) => a.id === id);
            if (idx === -1) return { found: false as const, action: null as Record<string, unknown> | null };
            actions[idx] = { ...update, id: update.id ?? id };
            config.issueActions = actions;
            return { found: true as const, action: actions[idx] };
        });

        if (!result.found) {
            return reply.status(404).send({ error: `Issue action "${id}" not found` });
        }

        logger.info({ action: id }, 'Issue action updated via dashboard');
        return { ok: true, action: result.action };
    });

    server.delete('/api/issue-actions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        const found = await deps.configStore.updateRaw((config) => {
            const actions = ((config.issueActions as unknown[]) ?? []) as Record<string, unknown>[];
            const filtered = actions.filter((a) => a.id !== id);
            if (filtered.length === actions.length) return false;
            config.issueActions = filtered;
            return true;
        });

        if (!found) {
            return reply.status(404).send({ error: `Issue action "${id}" not found` });
        }

        logger.info({ action: id }, 'Issue action deleted via dashboard');
        return { ok: true };
    });

    server.post('/api/issue-actions/:id/run', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { owner: string; repo: string; issueNumber: number };

        if (!body?.owner || !body?.repo || !body?.issueNumber) {
            return reply.status(400).send({ error: 'Missing owner, repo, or issueNumber' });
        }

        const raw = await deps.configStore.readRaw();
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
                graph: parsed.graph,
                description: parsed.description,
                raw: content,
            });
        }

        return { templates };
    });

    // Library templates (separate from user templates). We surface the
    // parsed graph + trigger so the dashboard's recipe picker can render
    // graph-form templates as starter recipes without re-parsing YAML.
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
            let parsed: Record<string, unknown> = {};
            try { parsed = (yaml.load(content) as Record<string, unknown>) || {}; }
            catch { /* surface as content-only */ }
            templates.push({
                name,
                content,
                trigger: parsed.trigger,
                steps: parsed.steps,
                graph: parsed.graph,
                description: parsed.description,
                icon: parsed.icon,
            });
        }

        return { templates };
    });

    // Single library template lookup — used by library cards' "Edit in
    // Visual Editor" path. Returns the parsed graph (if any) so the editor
    // can stage the workflow without round-tripping YAML.
    server.get('/api/templates/library/:name/graph', async (request, reply) => {
        const { name } = request.params as { name: string };
        const safeName = sanitizeFileName(name);
        const dir = join(deps.getTemplateDir(), 'library');
        const filePath = join(dir, `${safeName}.yaml`);
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch {
            return reply.status(404).send({ error: `Library template "${safeName}" not found` });
        }
        let parsed: Record<string, unknown> = {};
        try { parsed = (yaml.load(content) as Record<string, unknown>) || {}; }
        catch (e: any) { return reply.status(400).send({ error: `Invalid YAML: ${e.message}` }); }
        return {
            name: safeName,
            description: parsed.description,
            icon: parsed.icon,
            trigger: parsed.trigger,
            graph: parsed.graph,
            steps: parsed.steps,
        };
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
        const safeName = sanitizeFileName(name);
        const body = request.body as { content: string };
        if (!body?.content) {
            return reply.status(400).send({ error: 'Template content required' });
        }

        const filePath = join(deps.getTemplateDir(), `${safeName}.yaml`);
        try {
            await readFile(filePath, 'utf-8');
        } catch {
            return reply.status(404).send({ error: `Template "${safeName}" not found` });
        }

        try {
            yaml.load(body.content);
        } catch (e: any) {
            return reply.status(400).send({ error: `Invalid YAML: ${e.message}` });
        }

        await writeFile(filePath, body.content, 'utf-8');
        logger.info({ template: safeName }, 'Template updated via dashboard');
        return { ok: true };
    });

    server.delete('/api/templates/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const safeName = sanitizeFileName(name);
        const filePath = join(deps.getTemplateDir(), `${safeName}.yaml`);

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

    // ─── Visual-editor node registry ────────────────────────────────────
    //
    // Returns the serialized definitions for every node type the engine
    // knows about. Drives the visual editor's palette and inspector form.
    // No body — the palette refreshes the whole list on open.

    server.get('/api/nodes', async () => {
        const { getNodeRegistry } = await import('../core/nodes/registry.js');
        return { nodes: getNodeRegistry().serialize() };
    });

    // ─── Node Presets ───────────────────────────────────────────────────
    //
    // Per-user preset store. Library installs auto-populate
    // `source: library:<id>` entries; the editor can also POST a
    // `source: user` preset when the user saves a configured node from
    // the inspector. The dashboard fetches the whole list on editor
    // open and slots them into the palette alongside built-in nodes.

    server.get('/api/node-presets', async () => {
        const presets = await deps.getPresetStore().list();
        return { presets };
    });

    server.post('/api/node-presets', async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (typeof body.name !== 'string' || !body.name.trim()) {
            return reply.status(400).send({ error: 'name is required' });
        }
        if (typeof body.nodeType !== 'string' || !body.nodeType.trim()) {
            return reply.status(400).send({ error: 'nodeType is required' });
        }
        const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
            ? body.config as Record<string, unknown>
            : {};
        const preset = await deps.getPresetStore().create({
            name: body.name.trim(),
            description: typeof body.description === 'string' ? body.description : undefined,
            icon: typeof body.icon === 'string' ? body.icon : undefined,
            nodeType: body.nodeType.trim(),
            config,
            // Manually-created presets are always tagged `user` to keep
            // them out of the library cascade cleanup. The library
            // import path uses `replaceBySource` directly and never
            // hits this endpoint.
            source: 'user',
        });
        return { ok: true, preset };
    });

    server.delete('/api/node-presets/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const removed = await deps.getPresetStore().deleteOne(id);
        if (!removed) return reply.status(404).send({ error: `Preset "${id}" not found` });
        return { ok: true };
    });

    // ─── System: autostart service + updates ────────────────────────────
    //
    // These routes mirror the `sokuza service` / `sokuza update` CLI
    // subcommands so the dashboard has parity with the terminal. They sit
    // under /api/system/* to group meta-management of the sokuza install
    // itself (distinct from the engine's runtime config). All routes are
    // already gated by the bearer-token auth layer registered in engine.ts.

    server.get('/api/system/info', async () => {
        return {
            version: VERSION,
            platform: process.platform,
            nodeVersion: process.version,
            pid: process.pid,
            configPath: deps.configStore.getPath(),
        };
    });

    server.get('/api/system/service', async () => {
        return { status: await serviceStatus() };
    });

    server.post('/api/system/service/enable', async (_request, reply) => {
        try {
            const result = await installService({ configPath: deps.configStore.getPath() });
            logger.info({ platform: result.platform, unitPath: result.unitPath }, 'Autostart enabled via dashboard');
            return { ok: true, result };
        } catch (err: any) {
            logger.error({ err }, 'Autostart enable via dashboard failed');
            return reply.status(500).send({ error: err.message ?? 'Failed to enable autostart' });
        }
    });

    server.post('/api/system/service/disable', async (_request, reply) => {
        try {
            const result = await uninstallService();
            logger.info({ platform: result.platform }, 'Autostart disabled via dashboard');
            return { ok: true, result };
        } catch (err: any) {
            logger.error({ err }, 'Autostart disable via dashboard failed');
            return reply.status(500).send({ error: err.message ?? 'Failed to disable autostart' });
        }
    });

    server.post('/api/system/service/restart', async (_request, reply) => {
        // Pre-check synchronously so an uninstalled service yields a clear
        // 400 instead of a dishonest "restart scheduled" ACK. `isServiceInstalled`
        // is a pure fs lookup — no subprocess spawns — which keeps this hot
        // path cheap and avoids the ~200ms `systemctl is-enabled` + `is-active`
        // round-trip that a full `serviceStatus()` would do.
        if (!isServiceInstalled()) {
            return reply.status(400).send({
                error:
                    `Service is not installed — run \`sokuza service enable\` first ` +
                    `before restarting.`,
            });
        }

        // Issue the actual restart on a later tick. systemd / launchd / Task
        // Scheduler will deliver SIGTERM to *this* process the moment the
        // restart fires; deferring lets Fastify finish writing this 202 and
        // flush the socket so the dashboard can distinguish "restart
        // accepted" from "server crashed mid-request" and start its poll
        // loop for the new instance.
        setImmediate(() => {
            restartService()
                .then((r) => logger.info(
                    { platform: r.platform, unitPath: r.unitPath },
                    'Service restart issued via dashboard',
                ))
                .catch((err: any) => logger.error(
                    { err }, 'Service restart via dashboard failed',
                ));
        });

        return reply.status(202).send({ scheduled: true, platform: process.platform });
    });

    /** Shape both `/update` GETs return so the UI can render one code path. */
    function buildUpdateSnapshot(cache: { checkedAt: number; latest: string } | null) {
        const latest = cache?.latest ?? null;
        return {
            current: VERSION,
            latest,
            checkedAt: cache?.checkedAt ?? null,
            updateAvailable: latest ? isNewer(latest, VERSION) : false,
        };
    }

    server.get('/api/system/update', async () => {
        return buildUpdateSnapshot(await readUpdateCache());
    });

    server.post('/api/system/update/check', async () => {
        const result = await refreshUpdateCache({ force: true });
        return {
            ...buildUpdateSnapshot(await readUpdateCache()),
            checkOk: result.ok,
            checkError: result.error ?? null,
        };
    });

    server.post('/api/system/update', async (_request, reply) => {
        try {
            const result = await runUpdateCommand({
                entryPath: resolveEntryPath(process.argv[1]),
                captureOutput: true,
            });
            logger.info(
                { installer: result.installer.name, ok: result.ok, exitCode: result.exitCode },
                'Update run via dashboard',
            );
            return {
                ok: result.ok,
                reason: result.reason,
                installer: {
                    name: result.installer.name,
                    label: result.installer.label,
                    command: result.installer.command,
                    args: result.installer.args,
                },
                exitCode: result.exitCode,
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
                error: result.error,
            };
        } catch (err: any) {
            logger.error({ err }, 'Update run via dashboard failed');
            return reply.status(500).send({ error: err.message ?? 'Update failed' });
        }
    });

    // ─── Webhook Deliveries ──────────────────────────────────────────────

    server.get('/api/webhooks/deliveries', async (request) => {
        const { workflow } = (request.query ?? {}) as { workflow?: string };
        return { deliveries: deps.getWebhookDeliveries(workflow) };
    });

    // ─── AI Provider Test ────────────────────────────────────────────────

    server.post('/api/ai/test', async (request, reply) => {
        const body = (request.body ?? {}) as { provider?: string; prompt?: string };
        const config = deps.getConfig();
        if (!config.ai) {
            return reply.status(503).send({ error: 'No AI providers configured' });
        }

        const { resolveProvider, runCompletionWithFallback } = await import('../core/ai-providers.js');

        let provider;
        try {
            provider = resolveProvider(config.ai, body.provider);
        } catch (err: any) {
            return reply.status(400).send({ error: err.message });
        }

        const prompt = body.prompt ?? 'Reply with exactly: OK';
        const start = Date.now();

        try {
            const result = await runCompletionWithFallback(config.ai, body.provider, {
                systemPrompt: 'You are a test assistant. Follow instructions exactly.',
                userMessage: prompt,
                logger,
            });

            return {
                ok: true,
                provider: result.provider,
                model: result.model,
                response: result.text.slice(0, 500),
                durationMs: Date.now() - start,
                usage: result.usage,
            };
        } catch (err: any) {
            return {
                ok: false,
                provider: provider.name,
                kind: provider.kind,
                error: err.message,
                durationMs: Date.now() - start,
            };
        }
    });

    // ─── AI Provider CRUD ────────────────────────────────────────────────
    //
    // All mutations are performed via configStore.update so the config
    // file is the source of truth; after any write we call reloadConfig()
    // so the in-memory registry picks up the change immediately (no
    // restart required).
    //
    // Secrets: api_key values that the dashboard sends in plaintext are
    // written to the YAML as-is. The config file is chmod 0600 (see
    // ConfigStore.atomicWrite) so keys stay owner-only. `${VAR}` env
    // references are preserved verbatim — power users can still wire
    // secrets through environment variables if they prefer.

    /** Providers that ship built-in — cannot be deleted, only their settings edited. */
    const BUILTIN_PROVIDERS = new Set(['claude-code', 'anthropic']);

    function getAiSection(config: Record<string, unknown>): Record<string, unknown> {
        const existing = config.ai;
        if (existing && typeof existing === 'object') return existing as Record<string, unknown>;
        const fresh = {};
        config.ai = fresh;
        return fresh;
    }

    function getAiProviders(config: Record<string, unknown>): Record<string, unknown> {
        const ai = getAiSection(config);
        const existing = ai.providers;
        if (existing && typeof existing === 'object') return existing as Record<string, unknown>;
        const fresh = {};
        ai.providers = fresh;
        return fresh;
    }

    /** Return the dashboard-safe JSON for one provider entry — masks secrets. */
    async function maskProviderEntry(
        name: string,
        entry: Record<string, unknown>,
        isBuiltin = BUILTIN_PROVIDERS.has(name),
    ): Promise<Record<string, unknown>> {
        const { maskSecret, isCliInstalled } = await import('../core/ai-providers.js');
        const apiKey = entry.api_key as string | undefined;
        let keyStatus: 'plaintext' | 'env-var' | 'empty' = 'empty';
        if (apiKey) {
            keyStatus = apiKey.startsWith('${') && apiKey.endsWith('}') ? 'env-var' : 'plaintext';
        }

        let cliInstalled: boolean | undefined;
        if (entry.kind === 'cli' && typeof entry.command === 'string') {
            cliInstalled = await isCliInstalled(entry.command);
        }

        return {
            name,
            kind: entry.kind,
            default_model: entry.default_model,
            command: entry.command,
            args_style: entry.args_style,
            base_url: entry.base_url,
            headers: entry.headers,
            env: entry.env,
            api_key_masked: maskSecret(apiKey),
            key_status: keyStatus,
            cli_installed: cliInstalled,
            is_builtin: isBuiltin,
        };
    }

    /**
     * Validate a provider body from the dashboard. Returns a cleaned YAML
     * entry (snake_case keys) or an Error.
     */
    function validateProviderBody(body: Record<string, unknown>): Record<string, unknown> | Error {
        const kind = body.kind;
        if (kind !== 'anthropic-api' && kind !== 'openai-compatible-api' && kind !== 'cli') {
            return new Error('kind must be "anthropic-api", "openai-compatible-api", or "cli"');
        }

        const entry: Record<string, unknown> = { kind };
        if (typeof body.default_model === 'string' && body.default_model.trim()) {
            entry.default_model = body.default_model.trim();
        }

        if (kind === 'anthropic-api' || kind === 'openai-compatible-api') {
            if (typeof body.api_key === 'string' && body.api_key.trim()) {
                entry.api_key = body.api_key.trim();
            }
            if (typeof body.base_url === 'string' && body.base_url.trim()) {
                entry.base_url = body.base_url.trim();
            }
            if (kind === 'openai-compatible-api' && !entry.base_url) {
                return new Error('openai-compatible-api providers require base_url');
            }
            if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
                const cleanHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
                    if (typeof v === 'string' && v.length > 0) cleanHeaders[k] = v;
                }
                if (Object.keys(cleanHeaders).length > 0) entry.headers = cleanHeaders;
            }
        }

        if (kind === 'cli') {
            entry.command = (typeof body.command === 'string' && body.command.trim())
                ? body.command.trim()
                : 'claude';
            const argsStyle = body.args_style;
            if (typeof argsStyle !== 'string' || !(ARGS_STYLES as readonly string[]).includes(argsStyle)) {
                return new Error(`args_style must be one of: ${ARGS_STYLES.join(', ')}`);
            }
            entry.args_style = argsStyle;
            if (body.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
                const envObj = body.env as Record<string, unknown>;
                const cleanEnv: Record<string, string> = {};
                for (const [k, v] of Object.entries(envObj)) {
                    if (typeof v === 'string' && v.length > 0) cleanEnv[k] = v;
                }
                if (Object.keys(cleanEnv).length > 0) entry.env = cleanEnv;
            }
        }

        return entry;
    }

    // Named default prompts the visual editor can surface as "Load default"
    // affordances in the inspector. Returns the actual TypeScript-generated
    // text so the user sees what the action runs when their override port
    // is empty — and gets a sane starting point if they want to customise.
    server.get('/api/ai/defaults/:source', async (request, reply) => {
        const { source } = request.params as { source: string };
        try {
            const { getDefaultPrompt } = await import('../actions/default-prompts.js');
            const text = getDefaultPrompt(source);
            if (text == null) {
                return reply.status(404).send({ error: `Unknown default prompt source "${source}"` });
            }
            return { source, text };
        } catch (err) {
            return reply.status(500).send({ error: (err as Error).message });
        }
    });

    server.get('/api/ai/providers', async () => {
        const config = await deps.configStore.read();
        const providersRaw = (config.ai as Record<string, unknown> | undefined)?.providers;
        const providers = providersRaw && typeof providersRaw === 'object'
            ? providersRaw as Record<string, unknown>
            : {};
        const defaultProvider = (config.ai as Record<string, unknown> | undefined)?.default_provider as string | undefined;

        const masked = await Promise.all(
            Object.entries(providers).map(([name, entry]) =>
                maskProviderEntry(name, (entry ?? {}) as Record<string, unknown>),
            ),
        );

        // Surface built-in + auto-detected CLI providers (gemini, codex,
        // opencode found on PATH, plus the always-on claude-code/anthropic)
        // that the user hasn't explicitly configured, so they "just show
        // up". Config-declared providers above win on name collision.
        const { listImplicitProviders } = await import('../core/ai-providers.js');
        const present = new Set(Object.keys(providers));
        for (const imp of listImplicitProviders()) {
            if (present.has(imp.name)) continue;
            masked.push(await maskProviderEntry(imp.name, imp.entry, true));
        }

        return {
            providers: masked,
            default_provider: defaultProvider ?? null,
        };
    });

    server.post('/api/ai/providers', async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
            return reply.status(400).send({ error: 'name is required (letters, digits, underscore, dash)' });
        }
        const validated = validateProviderBody(body);
        if (validated instanceof Error) {
            return reply.status(400).send({ error: validated.message });
        }

        await deps.configStore.update((config) => {
            const providers = getAiProviders(config);
            if (providers[name]) {
                throw new Error(`Provider "${name}" already exists — use PUT to update`);
            }
            providers[name] = validated;
        }).catch((err: Error) => {
            reply.status(409).send({ error: err.message });
            throw err;
        });

        await deps.reloadConfig();
        logger.info({ provider: name, kind: validated.kind }, 'AI provider added via dashboard');
        return { ok: true, name };
    });

    server.put('/api/ai/providers/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const validated = validateProviderBody(body);
        if (validated instanceof Error) {
            return reply.status(400).send({ error: validated.message });
        }

        let existed = true;
        await deps.configStore.update((config) => {
            const providers = getAiProviders(config);
            const prev = providers[name] as Record<string, unknown> | undefined;
            if (!prev) {
                existed = false;
                return;
            }
            // Preserve the existing api_key when the client didn't send a new
            // one (UI "edit without retyping the key" flow).
            if (
                (validated.kind === 'anthropic-api' || validated.kind === 'openai-compatible-api')
                && !('api_key' in validated)
                && typeof prev.api_key === 'string'
            ) {
                validated.api_key = prev.api_key;
            }
            providers[name] = validated;
        });

        if (!existed) {
            return reply.status(404).send({ error: `Provider "${name}" not found` });
        }

        await deps.reloadConfig();
        logger.info({ provider: name, kind: validated.kind }, 'AI provider updated via dashboard');
        return { ok: true, name };
    });

    server.delete('/api/ai/providers/:name', async (request, reply) => {
        const { name } = request.params as { name: string };
        if (BUILTIN_PROVIDERS.has(name)) {
            return reply.status(400).send({ error: `Built-in provider "${name}" cannot be deleted` });
        }

        let existed = true;
        let wasDefault = false;
        await deps.configStore.update((config) => {
            const providers = getAiProviders(config);
            if (!providers[name]) {
                existed = false;
                return;
            }
            delete providers[name];
            const ai = getAiSection(config);
            if (ai.default_provider === name) {
                wasDefault = true;
                delete ai.default_provider;
            }
        });

        if (!existed) {
            return reply.status(404).send({ error: `Provider "${name}" not found` });
        }

        await deps.reloadConfig();
        logger.info({ provider: name, wasDefault }, 'AI provider deleted via dashboard');
        return { ok: true, wasDefault };
    });

    server.post('/api/ai/default', async (request, reply) => {
        const body = (request.body ?? {}) as { provider?: string };
        const name = typeof body.provider === 'string' ? body.provider.trim() : '';
        if (!name) {
            return reply.status(400).send({ error: 'provider name is required' });
        }

        let found = true;
        await deps.configStore.update((config) => {
            const providers = getAiProviders(config);
            const isBuiltin = BUILTIN_PROVIDERS.has(name);
            if (!providers[name] && !isBuiltin) {
                found = false;
                return;
            }
            const ai = getAiSection(config);
            ai.default_provider = name;
        });

        if (!found) {
            return reply.status(404).send({ error: `Provider "${name}" not registered` });
        }

        await deps.reloadConfig();
        logger.info({ provider: name }, 'AI default provider changed via dashboard');
        return { ok: true, default_provider: name };
    });

    // ─── AI Run Records ─────────────────────────────────────────────────
    //
    // Browse and drill into the on-disk run log written by the ai-review
    // action (see src/core/run-store.ts). Used by the dashboard's "AI
    // Reviews" page to evaluate truncation behavior and review outcomes.

    server.get('/api/ai/runs', async (request, reply) => {
        const { listAiReviewRuns } = await import('../core/run-store.js');
        const q = (request.query ?? {}) as {
            limit?: string;
            since?: string;
            until?: string;
            workflow?: string;
            repo?: string;
            decision?: string;
            truncated?: string;
            parse_failed?: string;
            errored?: string;
        };
        try {
            const runs = await listAiReviewRuns({
                limit: q.limit ? parseInt(q.limit, 10) : undefined,
                since: q.since,
                until: q.until,
                workflowName: q.workflow,
                repo: q.repo,
                decision: q.decision,
                truncatedOnly: q.truncated === 'true',
                parseFailedOnly: q.parse_failed === 'true',
                erroredOnly: q.errored === 'true',
            });
            return { runs };
        } catch (err: any) {
            logger.error({ err }, 'Failed to list ai-review runs');
            return reply.status(500).send({ error: err.message ?? 'failed to list runs' });
        }
    });

    server.get('/api/ai/runs/stats', async (request, reply) => {
        const { aggregateAiReviewStats } = await import('../core/run-store.js');
        const q = (request.query ?? {}) as { since?: string; until?: string };
        // Default window: last 30 days. Computed at request time so the
        // stats follow the wall clock without redeploys.
        const since = q.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
        try {
            return await aggregateAiReviewStats({ since, until: q.until });
        } catch (err: any) {
            logger.error({ err }, 'Failed to aggregate ai-review stats');
            return reply.status(500).send({ error: err.message ?? 'failed to aggregate stats' });
        }
    });

    server.get('/api/ai/runs/:id', async (request, reply) => {
        const { getAiReviewRunById } = await import('../core/run-store.js');
        const { id } = request.params as { id: string };
        // The id flows into a filesystem path. Fastify URL-decodes route
        // params, so a crafted `%2F..` could otherwise escape the runs
        // root. Run ids generated by `generateRunId` are base36+hex with
        // a single dash, so this allowlist is strict but lossless.
        if (!/^[a-z0-9-]{1,128}$/.test(id)) {
            return reply.status(400).send({ error: 'invalid run id' });
        }
        try {
            const record = await getAiReviewRunById(id);
            if (!record) return reply.status(404).send({ error: 'run not found' });
            return record;
        } catch (err: any) {
            logger.error({ err, id }, 'Failed to read ai-review run');
            return reply.status(500).send({ error: err.message ?? 'failed to read run' });
        }
    });

    server.put('/api/ai/runs/:id/label', async (request, reply) => {
        const { setAiReviewLabel } = await import('../core/run-store.js');
        const { id } = request.params as { id: string };
        if (!/^[a-z0-9-]{1,128}$/.test(id)) {
            return reply.status(400).send({ error: 'invalid run id' });
        }
        const body = (request.body ?? {}) as { verdict?: string; note?: string };
        if (body.verdict !== 'good' && body.verdict !== 'bad') {
            return reply.status(400).send({ error: 'verdict must be "good" or "bad"' });
        }
        if (body.note !== undefined && typeof body.note !== 'string') {
            return reply.status(400).send({ error: 'note must be a string' });
        }
        try {
            const record = await setAiReviewLabel(id, { verdict: body.verdict, note: body.note }, logger);
            if (!record) return reply.status(404).send({ error: 'run not found' });
            return record;
        } catch (err: any) {
            logger.error({ err, id }, 'Failed to label ai-review run');
            return reply.status(500).send({ error: err.message ?? 'failed to label run' });
        }
    });

    server.delete('/api/ai/runs/:id/label', async (request, reply) => {
        const { clearAiReviewLabel } = await import('../core/run-store.js');
        const { id } = request.params as { id: string };
        if (!/^[a-z0-9-]{1,128}$/.test(id)) {
            return reply.status(400).send({ error: 'invalid run id' });
        }
        try {
            const record = await clearAiReviewLabel(id, logger);
            if (!record) return reply.status(404).send({ error: 'run not found' });
            return record;
        } catch (err: any) {
            logger.error({ err, id }, 'Failed to clear label');
            return reply.status(500).send({ error: err.message ?? 'failed to clear label' });
        }
    });

    // ─── Auto-fix workdirs ──────────────────────────────────────────────
    //
    // List, inspect, and evict the persistent per-PR git workdirs that
    // back the address-review action (see src/core/workdir-store.ts).
    // The `id` regex ensures path segments can't escape the workdir root.

    const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

    server.get('/api/auto-fix/workdirs', async (_request, reply) => {
        try {
            const list = await deps.getWorkdirManager().list();
            const totalBytes = list.reduce((s, w) => s + w.sizeBytes, 0);
            return { workdirs: list, totalBytes };
        } catch (err: any) {
            logger.error({ err }, 'Failed to list workdirs');
            return reply.status(500).send({ error: err.message ?? 'failed to list workdirs' });
        }
    });

    server.get('/api/auto-fix/pricing', async (_request, reply) => {
        const { loadPricing } = await import('../core/pricing.js');
        try {
            return await loadPricing();
        } catch (err: any) {
            logger.error({ err }, 'Failed to load pricing');
            return reply.status(500).send({ error: err.message ?? 'failed to load pricing' });
        }
    });

    server.get('/api/auto-fix/pr/:owner/:repo/:pr/timeline', async (request, reply) => {
        const { listAiReviewRuns, listAddressReviewRuns } = await import('../core/run-store.js');
        const { owner, repo, pr } = request.params as { owner: string; repo: string; pr: string };
        const ID = /^[A-Za-z0-9_.-]{1,128}$/;
        if (!ID.test(owner) || !ID.test(repo) || !/^\d{1,8}$/.test(pr)) {
            return reply.status(400).send({ error: 'invalid owner/repo/pr' });
        }
        const repoFull = `${owner}/${repo}`;
        const prNumber = parseInt(pr, 10);
        try {
            const [reviews, addressRuns] = await Promise.all([
                listAiReviewRuns({ limit: 200 }),
                listAddressReviewRuns({ limit: 200, repo: repoFull, prNumber }),
            ]);
            // ai-review records aren't filterable by PR in the existing
            // signature; trim to this PR here. Cheap on a 200-record cap.
            const prReviews = reviews.filter((r) => r.event.repo === repoFull && r.event.prNumber === prNumber);
            return { repo: repoFull, prNumber, reviews: prReviews, addressRuns };
        } catch (err: any) {
            logger.error({ err, repoFull, prNumber }, 'Failed to load PR timeline');
            return reply.status(500).send({ error: err.message ?? 'failed to load timeline' });
        }
    });

    server.get('/api/auto-fix/address-runs', async (request, reply) => {
        const { listAddressReviewRuns } = await import('../core/run-store.js');
        const q = (request.query ?? {}) as {
            limit?: string; since?: string; until?: string;
            repo?: string; pr?: string; mode?: string;
        };
        try {
            const runs = await listAddressReviewRuns({
                limit: q.limit ? parseInt(q.limit, 10) : undefined,
                since: q.since,
                until: q.until,
                repo: q.repo,
                prNumber: q.pr ? parseInt(q.pr, 10) : undefined,
                mode: (q.mode === 'suggest' || q.mode === 'push') ? q.mode : undefined,
            });
            return { runs };
        } catch (err: any) {
            logger.error({ err }, 'Failed to list address-review runs');
            return reply.status(500).send({ error: err.message ?? 'failed to list address runs' });
        }
    });

    server.get('/api/auto-fix/address-runs/:id', async (request, reply) => {
        const { getAddressReviewRunById } = await import('../core/run-store.js');
        const { id } = request.params as { id: string };
        if (!/^[a-z0-9-]{1,128}$/.test(id)) {
            return reply.status(400).send({ error: 'invalid run id' });
        }
        try {
            const record = await getAddressReviewRunById(id);
            if (!record) return reply.status(404).send({ error: 'run not found' });
            return record;
        } catch (err: any) {
            logger.error({ err, id }, 'Failed to read address-review run');
            return reply.status(500).send({ error: err.message ?? 'failed to read run' });
        }
    });

    /**
     * Manually trigger an address-review run.
     *
     * The server enqueues a `manual` workflow that wraps the
     * `address-review` action with the user's chosen mode. The
     * `review_run_id` (or "latest") flows through params; the engine
     * resolves the source review record and the rest of the loop guard
     * stack runs as it would for an auto-trigger.
     */
    server.post('/api/auto-fix/address-runs', async (request, reply) => {
        const body = (request.body ?? {}) as {
            owner?: string;
            repo?: string;
            pr_number?: number;
            review_run_id?: string;
            mode?: 'suggest' | 'push';
            max_iterations?: number;
        };
        if (!body.owner || !body.repo || typeof body.pr_number !== 'number') {
            return reply.status(400).send({ error: 'owner, repo, pr_number required' });
        }
        const mode = body.mode ?? 'suggest';
        if (mode !== 'suggest' && mode !== 'push') {
            return reply.status(400).send({ error: 'mode must be "suggest" or "push"' });
        }

        const engine = deps.getEngine();
        const event = {
            source: 'manual' as const,
            event: 'manual',
            timestamp: new Date().toISOString(),
            payload: {},
            metadata: {
                repo: `${body.owner}/${body.repo}`,
                owner: body.owner,
                repoName: body.repo,
                prNumber: body.pr_number,
            },
        };
        try {
            await engine['actions'].get('address-review')?.(
                {
                    mode,
                    review_run_id: body.review_run_id ?? 'latest',
                    max_iterations: body.max_iterations,
                    owner: body.owner,
                    repo_name: body.repo,
                    pr_number: body.pr_number,
                },
                {
                    event,
                    results: {},
                    steps: {},
                    integrationConfigs: deps.getConfig().integrations,
                    ai: deps.getConfig().ai!,
                    logger,
                    workdirManager: deps.getWorkdirManager(),
                },
            );
            return { ok: true };
        } catch (err: any) {
            logger.error({ err, body }, 'Manual address-review failed');
            return reply.status(500).send({ error: err.message ?? 'address-review failed' });
        }
    });

    server.delete('/api/auto-fix/workdirs/:owner/:repo/:pr', async (request, reply) => {
        const { owner, repo, pr } = request.params as { owner: string; repo: string; pr: string };
        const { force } = (request.query ?? {}) as { force?: string };
        if (!ID_RE.test(owner) || !ID_RE.test(repo) || !/^\d{1,8}$/.test(pr)) {
            return reply.status(400).send({ error: 'invalid owner/repo/pr' });
        }
        try {
            const evicted = await deps.getWorkdirManager().evict(
                owner, repo, parseInt(pr, 10), { force: force === 'true' },
            );
            return { evicted };
        } catch (err: any) {
            // Lock conflicts come back as 409 so the client can offer "force".
            if (/locked/.test(err.message ?? '')) {
                return reply.status(409).send({ error: err.message });
            }
            logger.error({ err, owner, repo, pr }, 'Failed to evict workdir');
            return reply.status(500).send({ error: err.message ?? 'failed to evict' });
        }
    });

    server.get('/api/ai/cli-status', async () => {
        const { isCliInstalled } = await import('../core/ai-providers.js');
        const [claude, opencode] = await Promise.all([
            isCliInstalled('claude'),
            isCliInstalled('opencode'),
        ]);
        return { claude, opencode };
    });

    server.post('/api/ai/models', async (request, reply) => {
        const body = (request.body ?? {}) as {
            kind?: string;
            command?: string;
            base_url?: string;
            api_key?: string;
            env?: Record<string, string>;
            // For an existing provider, let the client pass its name instead
            // of re-sending the api_key (so plaintext keys never bounce
            // through the browser just to list models).
            name?: string;
        };

        let kind = body.kind;
        let command = body.command;
        let baseUrl = body.base_url;
        let apiKey = body.api_key;
        let env = body.env;

        if (body.name && !kind) {
            const config = await deps.configStore.read();
            const providers = (config.ai as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined;
            const entry = providers?.[body.name] as Record<string, unknown> | undefined;
            if (entry) {
                kind = entry.kind as string;
                command = entry.command as string | undefined;
                baseUrl = entry.base_url as string | undefined;
                apiKey = entry.api_key as string | undefined;
                env = entry.env as Record<string, string> | undefined;
            }
        }

        if (kind !== 'anthropic-api' && kind !== 'openai-compatible-api' && kind !== 'cli') {
            return reply.status(400).send({ error: 'kind must be anthropic-api, openai-compatible-api, or cli' });
        }

        const { listModelSuggestions } = await import('../core/ai-providers.js');
        const result = await listModelSuggestions({ kind, command, base_url: baseUrl, api_key: apiKey, env });
        return result;
    });

    // ─── Chat sessions ──────────────────────────────────────────────────
    //
    // Six endpoints: list, create, get, patch (rename/archive), delete,
    // and the SSE message-send. Sessions live on disk under
    // ~/.sokuza/chat-sessions/ via ChatStore; the message-send endpoint
    // streams agent events back to the browser as they happen.

    server.get('/api/chat/sessions', async () => {
        const store = deps.getChatStore();
        const sessions = await store.listSessions();
        return { sessions };
    });

    server.post('/api/chat/sessions', async (request, reply) => {
        const body = (request.body ?? {}) as {
            scope?: unknown;
            provider?: string;
            title?: string;
        };

        // ─── Validate scope ─────────────────────────────────────────
        const scope = parseSessionScope(body.scope);
        if (scope instanceof Error) {
            return reply.status(400).send({ error: scope.message });
        }

        // ─── Resolve provider (must be anthropic-api kind for MVP) ──
        const config = deps.getConfig();
        const registry = config.ai;
        if (!registry) {
            return reply.status(503).send({ error: 'AI provider registry not configured' });
        }
        const requestedProvider = body.provider?.trim() || registry.defaultProvider;
        const provider = registry.providers.get(requestedProvider);
        if (!provider) {
            return reply.status(400).send({
                error: `Unknown provider "${requestedProvider}". Known: ${[...registry.providers.keys()].join(', ')}`,
            });
        }
        if (provider.kind !== 'anthropic-api') {
            return reply.status(400).send({
                error: `Chat requires an anthropic-api provider; "${requestedProvider}" is kind="${provider.kind}". Pick or add an Anthropic-compatible provider (e.g. zai-glm) in the Integrations page.`,
            });
        }
        if (!provider.apiKey) {
            return reply.status(400).send({
                error: `Provider "${requestedProvider}" has no api_key. Configure it on the Integrations page.`,
            });
        }

        // ─── Create session record ──────────────────────────────────
        const store = deps.getChatStore();
        const session = await store.createSession({
            scope,
            provider: requestedProvider,
            title: body.title,
        });

        // ─── Gather context (clone repo, fetch diff) ────────────────
        // We run this inline so failures surface cleanly on the POST —
        // a session with no workdir is broken in ways the user can't
        // fix from the UI. If cloning fails we delete the session
        // record and return the error.
        try {
            await gatherSessionContext(session, scope, deps, logger);
            return reply.status(201).send({ session });
        } catch (err: any) {
            logger.error({ sessionId: session.id, err: err?.message }, 'Chat session context gathering failed');
            await deps.getChatStore().deleteSession(session.id).catch(() => undefined);
            return reply.status(500).send({
                error: `Failed to set up session: ${err?.message ?? 'unknown error'}`,
            });
        }
    });

    server.get('/api/chat/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const store = deps.getChatStore();
        const session = await store.getSession(id);
        if (!session) return reply.status(404).send({ error: 'Session not found' });
        const messages = await store.getMessages(id);
        return { session, messages };
    });

    server.patch('/api/chat/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { title?: string; status?: string };
        const patch: { title?: string; status?: 'active' | 'archived' } = {};
        if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
        if (body.status === 'active' || body.status === 'archived') patch.status = body.status;
        if (Object.keys(patch).length === 0) {
            return reply.status(400).send({ error: 'Nothing to update (send { title? } or { status? })' });
        }
        const updated = await deps.getChatStore().updateSession(id, patch);
        if (!updated) return reply.status(404).send({ error: 'Session not found' });
        return { session: updated };
    });

    server.delete('/api/chat/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const ok = await deps.getChatStore().deleteSession(id);
        if (!ok) return reply.status(404).send({ error: 'Session not found' });
        return { ok: true };
    });

    /**
     * Send a user message and stream the agent's response as SSE.
     *
     * Response is `text/event-stream`; each event is a JSON object with
     * `type: 'assistant_text' | 'tool_call' | 'tool_result' | 'error' | 'done'`
     * plus whatever payload fits. The connection closes after `done`.
     */
    server.post('/api/chat/sessions/:id/messages', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { message?: string };
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message.trim()) {
            return reply.status(400).send({ error: 'message is required' });
        }

        const store = deps.getChatStore();
        const session = await store.getSession(id);
        if (!session) return reply.status(404).send({ error: 'Session not found' });

        // Hijack for SSE — same pattern the events/logs streams use.
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.raw.flushHeaders();
        reply.hijack();

        const write = (event: Record<string, unknown>) => {
            try {
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
                // Client disconnected mid-stream; the runChatTurn loop
                // will keep running (we want the DB writes) but further
                // writes will no-op.
            }
        };

        const { runChatTurn } = await import('../core/chat-agent.js');
        await runChatTurn({
            session,
            userMessage: message,
            engine: deps.getEngine(),
            logger,
            store,
            emit: (ev) => write(ev as unknown as Record<string, unknown>),
        }).catch((err) => {
            logger.error({ sessionId: id, err: err?.message }, 'Unhandled chat agent error');
            write({ type: 'error', error: err?.message ?? String(err) });
            write({ type: 'done' });
        });

        try { reply.raw.end(); } catch { /* already closed */ }
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

    server.post('/api/events/preview', async (request, reply) => {
        const body = request.body as { event?: EventPayload } | null;
        if (!body?.event?.source || !body?.event?.event) {
            return reply.status(400).send({ error: 'event.source and event.event are required' });
        }
        return deps.previewEvent(body.event);
    });

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

    server.post('/api/events/:index/replay', async (request, reply) => {
        const { index } = request.params as { index: string };
        const idx = parseInt(index, 10);
        if (isNaN(idx)) {
            return reply.status(400).send({ error: 'Invalid event index' });
        }
        const result = deps.replayEvent(idx);
        if (!result.ok) {
            return reply.status(404).send({ error: result.error });
        }
        return { ok: true, message: `Event ${idx} replayed` };
    });

    server.get('/api/events/stream', async (request, reply) => {
        reply.hijack();

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        let alive = true;

        const cleanup = () => {
            if (!alive) return;
            alive = false;
            unsubscribe();
            clearInterval(heartbeat);
        };

        reply.raw.on('error', cleanup);

        reply.raw.write('data: {"type":"connected"}\n\n');

        const unsubscribe = deps.addEventSubscriber((event) => {
            if (!alive) return;
            try {
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
                cleanup();
            }
        });

        const heartbeat = setInterval(() => {
            if (!alive) { clearInterval(heartbeat); return; }
            try { reply.raw.write(': heartbeat\n\n'); } catch {
                cleanup();
            }
        }, 30_000);

        request.raw.on('close', cleanup);

        setTimeout(() => {
            if (alive) {
                cleanup();
                try { reply.raw.end(); } catch { /* */ }
            }
        }, 86_400_000);
    });

    // ─── Logs ──────────────────────────────────────────────────────────

    server.get('/api/logs', async (request) => {
        const query = (request.query ?? {}) as { since?: string; level?: string; limit?: string };
        const since = query.since ? Number(query.since) : undefined;
        const limit = query.limit ? Math.min(Number(query.limit), 1000) : 200;
        const entries = deps.logStore.getEntries(since, query.level, limit);
        return { logs: entries, count: entries.length };
    });

    server.get('/api/logs/stream', async (request, reply) => {
        reply.hijack();

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        let alive = true;

        const cleanup = () => {
            if (!alive) return;
            alive = false;
            unsubscribe();
            clearInterval(heartbeat);
        };

        reply.raw.on('error', cleanup);

        reply.raw.write('data: {"type":"connected"}\n\n');

        const unsubscribe = deps.logStore.subscribe((entry) => {
            if (!alive) return;
            try {
                reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
            } catch {
                cleanup();
            }
        });

        const heartbeat = setInterval(() => {
            if (!alive) { clearInterval(heartbeat); return; }
            try { reply.raw.write(': heartbeat\n\n'); } catch {
                cleanup();
            }
        }, 30_000);

        request.raw.on('close', cleanup);

        setTimeout(() => {
            if (alive) {
                cleanup();
                try { reply.raw.end(); } catch { /* */ }
            }
        }, 86_400_000);
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

    // Shape a raw GitHub PR record into the format the UI expects.
    function shapePr(pr: Record<string, unknown>) {
        return {
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
            html_url: pr.html_url,
        };
    }

    // List PRs for a repo (state: open|closed|all, optional author filter)
    server.get('/api/github/:owner/:repo/pulls', async (request, reply) => {
        const { owner, repo } = request.params as { owner: string; repo: string };
        const { state, author } = (request.query ?? {}) as { state?: string; author?: string };
        try {
            // When filtering by author, use search API (pulls endpoint doesn't support author filter).
            if (author) {
                const q = [
                    'is:pr',
                    `repo:${owner}/${repo}`,
                    `author:${author}`,
                    state && state !== 'all' ? `is:${state === 'open' ? 'open' : 'closed'}` : '',
                ].filter(Boolean).join('+');
                const search = await githubProxyGet(
                    '/search/issues',
                    { q, sort: 'updated', order: 'desc', per_page: '30' },
                ) as { items?: Array<Record<string, unknown>> };
                return {
                    items: (search.items ?? []).map((item) => ({
                        number: item.number,
                        title: item.title,
                        state: item.state,
                        author: (item.user as Record<string, unknown>)?.login,
                        head: { ref: null, sha: null }, // not in search response; frontend resolves on select
                        base: { ref: null },
                        labels: ((item.labels as Array<Record<string, unknown>>) ?? []).map((l) => l.name),
                        created_at: item.created_at,
                        updated_at: item.updated_at,
                        draft: item.draft,
                        html_url: item.html_url,
                    })),
                };
            }

            const prs = await githubProxyGet(
                `/repos/${owner}/${repo}/pulls`,
                { state: state ?? 'open', sort: 'updated', direction: 'desc', per_page: '30' },
            ) as Array<Record<string, unknown>>;
            return { items: prs.map(shapePr) };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // Fetch a single PR (needed to resolve head.ref for URL pastes / My-PRs selection)
    server.get('/api/github/:owner/:repo/pulls/:number', async (request, reply) => {
        const { owner, repo, number } = request.params as { owner: string; repo: string; number: string };
        const n = Number(number);
        if (!Number.isFinite(n) || n <= 0) {
            return reply.status(400).send({ error: 'Invalid PR number' });
        }
        try {
            const pr = await githubProxyGet(`/repos/${owner}/${repo}/pulls/${n}`) as Record<string, unknown>;
            return { pr: shapePr(pr) };
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

    // List repos from config + user's accessible repos (includes owner info for grouping).
    server.get('/api/github/repos', async (_request, reply) => {
        try {
            const config = deps.getConfig();
            // Gather repos from integrations config
            const configRepos = new Set<string>();
            const ghPoll = config.integrations?.['github-poll'] as Record<string, unknown> | undefined;
            if (ghPoll?.repos && Array.isArray(ghPoll.repos)) {
                for (const r of ghPoll.repos) configRepos.add(r as string);
            }
            for (const wf of config.workflows ?? []) {
                const repos = Array.isArray(wf.trigger?.repo) ? wf.trigger.repo : wf.trigger?.repo ? [wf.trigger.repo] : [];
                for (const r of repos) configRepos.add(r);
            }

            // Fetch user's repos from GitHub (all affiliations, most-recently-pushed first).
            let apiRepos: Array<{
                full_name: string;
                description: string | null;
                owner_login: string | null;
                owner_type: string | null;
                private: boolean;
                fork: boolean;
            }> = [];
            try {
                const userRepos = await githubProxyGet(
                    '/user/repos',
                    { sort: 'pushed', direction: 'desc', per_page: '100', affiliation: 'owner,collaborator,organization_member' },
                ) as Array<Record<string, unknown>>;
                apiRepos = userRepos.map((r) => {
                    const owner = (r.owner as Record<string, unknown>) ?? {};
                    return {
                        full_name: r.full_name as string,
                        description: (r.description as string | null) ?? null,
                        owner_login: (owner.login as string | null) ?? null,
                        owner_type: (owner.type as string | null) ?? null,
                        private: Boolean(r.private),
                        fork: Boolean(r.fork),
                    };
                });
            } catch { /* token may not have user scope - that's fine */ }

            // Merge: config repos first (marked source=config), then API repos.
            const seen = new Set<string>();
            const items: Array<Record<string, unknown>> = [];

            for (const r of configRepos) {
                seen.add(r);
                const [ownerLogin] = r.split('/');
                items.push({
                    full_name: r,
                    source: 'config',
                    owner_login: ownerLogin ?? null,
                    owner_type: null,
                });
            }
            for (const r of apiRepos) {
                if (!seen.has(r.full_name)) {
                    seen.add(r.full_name);
                    items.push({
                        full_name: r.full_name,
                        description: r.description,
                        source: 'github',
                        owner_login: r.owner_login,
                        owner_type: r.owner_type,
                        private: r.private,
                        fork: r.fork,
                    });
                }
            }

            return { items };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // Authenticated user (used by the UI to label "My PRs" and group personal repos).
    server.get('/api/github/me', async (_request, reply) => {
        try {
            const user = await githubProxyGet('/user') as Record<string, unknown>;
            return {
                login: user.login as string,
                name: (user.name as string | null) ?? null,
                avatar_url: (user.avatar_url as string | null) ?? null,
            };
        } catch (err: any) {
            return reply.status(502).send({ error: err.message });
        }
    });

    // PRs authored by the authenticated user across all repos (via search API).
    server.get('/api/github/my-prs', async (request, reply) => {
        const { state } = (request.query ?? {}) as { state?: string };
        const qualifiers = ['is:pr', 'author:@me'];
        if (!state || state === 'open') qualifiers.push('is:open');
        else if (state === 'closed') qualifiers.push('is:closed');
        // state='all' adds no qualifier

        try {
            const result = await githubProxyGet(
                '/search/issues',
                { q: qualifiers.join('+'), sort: 'updated', order: 'desc', per_page: '50' },
            ) as { items?: Array<Record<string, unknown>> };

            const items = (result.items ?? []).map((pr) => {
                // html_url: https://github.com/<owner>/<repo>/pull/<number>
                const html = (pr.html_url as string) ?? '';
                const m = html.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
                const repo = m ? `${m[1]}/${m[2]}` : null;
                return {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    repo,
                    author: (pr.user as Record<string, unknown>)?.login,
                    labels: ((pr.labels as Array<Record<string, unknown>>) ?? []).map((l) => l.name),
                    created_at: pr.created_at,
                    updated_at: pr.updated_at,
                    draft: pr.draft,
                    html_url: html,
                };
            }).filter((item) => item.repo);
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
        configHash: job.configHash,
        workflowSnapshot: {
            name: job.workflow.name,
            trigger: job.workflow.trigger,
            stepCount: job.workflow.steps?.length ?? job.workflow.graph?.nodes.length ?? 0,
            stepActions: job.workflow.steps?.map(s => s.action) ?? job.workflow.graph?.nodes.map(n => n.type) ?? [],
        },
        event: {
            source: job.event.source,
            event: job.event.event,
            action: job.event.action,
        },
    };
}
