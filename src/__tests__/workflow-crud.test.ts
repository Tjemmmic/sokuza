import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server/server.js';
import { registerApiRoutes } from '../server/api.js';
import { ConfigStore } from '../core/config-store.js';
import { PresetStore } from '../core/preset-store.js';
import type { SokuzaConfig } from '../core/types.js';

const TMP_DIR = join(tmpdir(), `sokuza-workflow-crud-test-${Date.now()}`);
const logger = pino({ level: 'silent' });

// The dashboard's flow when a user installs a library workflow is:
//   POST /api/workflows          → writes the new entry to YAML on disk
//   GET  /api/workflows/:name/details  → reads from the engine's in-memory config
//
// Without `reloadConfig()` after the POST, the in-memory config never sees
// the new workflow and the GET 404s — making installed/duplicated
// workflows un-editable. These tests pin that contract.

describe('/api/workflows CRUD reloads in-memory config', () => {
    let server: FastifyInstance;
    let configPath: string;
    let cachedConfig: SokuzaConfig;
    let configStore: ConfigStore;
    let presetStore: PresetStore;
    let templateDir: string;

    beforeAll(async () => {
        await mkdir(TMP_DIR, { recursive: true });
    });

    afterAll(async () => {
        await server?.close();
        await rm(TMP_DIR, { recursive: true, force: true });
    });

    beforeEach(async () => {
        const slug = Math.random().toString(36).slice(2, 8);
        configPath = join(TMP_DIR, `config-${slug}.yaml`);
        await writeFile(configPath, 'server:\n  port: 0\nworkflows: []\n', 'utf-8');
        configStore = new ConfigStore(configPath, logger);
        // Per-test preset store path so cascade tests don't bleed.
        presetStore = new PresetStore(logger, join(TMP_DIR, `presets-${slug}.json`));
        templateDir = join(TMP_DIR, `tpl-${slug}`);
        await mkdir(join(templateDir, 'library'), { recursive: true });
        // The template loader caches in-process; if we don't reset, the
        // first test's templates win for the rest of the suite.
        const { resetTemplateCache } = await import('../core/templates.js');
        resetTemplateCache();

        // Mirror the engine: getConfig returns a cached snapshot;
        // reloadConfig refreshes it from disk. The two diverge until
        // someone calls reloadConfig.
        cachedConfig = { server: { port: 0 }, integrations: {}, workflows: [] };

        if (server) await server.close();
        server = createServer(logger);
        registerApiRoutes(server, {
            logger,
            configStore,
            getTemplateDir: () => templateDir,
            getIntegrationStatus: () => ({}),
            getRecentEvents: () => [],
            addEventSubscriber: () => () => undefined,
            getRegisteredActions: () => [],
            runWorkflow: async () => ({ ok: false, error: 'unused' }),
            rerunWorkflow: async () => ({ ok: false, error: 'unused' }),
            replayEvent: () => ({ ok: false, error: 'unused' }),
            getRunHistory: () => [],
            getConfig: () => cachedConfig,
            previewEvent: () => ({ matched: [], unmatched: [] }),
            getWebhookDeliveries: () => [],
            reloadConfig: async () => {
                const raw = await configStore.readRaw();
                const parsed = yaml.load(raw) as Record<string, unknown>;
                cachedConfig = {
                    server: { port: 0 },
                    integrations: {},
                    workflows: ((parsed.workflows as Array<Record<string, unknown>>) ?? []).map((w) => ({
                        name: w.name as string,
                        trigger: w.trigger as { source: string; event: string },
                        steps: w.steps as never,
                        graph: w.graph as never,
                        template: w.template as string | undefined,
                    })),
                };
            },
            getPresetStore: () => presetStore,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    it('POST → GET /:name/details: a freshly-created workflow is immediately editable (regression: in-memory config used to lag the YAML)', async () => {
        const create = await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'my-new-flow', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });
        expect(create.statusCode).toBe(200);

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/my-new-flow/details',
        });
        expect(detail.statusCode).toBe(200);
        const body = JSON.parse(detail.payload);
        expect(body.workflow?.name).toBe('my-new-flow');
    });

    it('PUT → GET /:name/details: edits land in the in-memory config without a manual reload', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'edit-me', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [{ id: 'n1' }], edges: [] } },
        });

        await server.inject({
            method: 'PUT',
            url: '/api/workflows/edit-me',
            payload: { name: 'edit-me', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] } },
        });

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/edit-me/details',
        });
        expect(detail.statusCode).toBe(200);
        const body = JSON.parse(detail.payload);
        expect(body.workflow?.graph?.nodes?.length).toBe(2);
    });

    it('PUT must not rename — the name is forced to the route param so it cannot bypass the rename migration', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'immutable', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });

        // A PUT body that tries to change the name must be ignored.
        const put = await server.inject({
            method: 'PUT',
            url: '/api/workflows/immutable',
            payload: { name: 'sneaky-rename', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });
        expect(put.statusCode).toBe(200);

        // The workflow is still under the original name; no phantom created.
        expect((await server.inject({ method: 'GET', url: '/api/workflows/immutable/details' })).statusCode).toBe(200);
        expect((await server.inject({ method: 'GET', url: '/api/workflows/sneaky-rename/details' })).statusCode).toBe(404);
    });

    it('DELETE → GET /:name/details: a deleted workflow is no longer in the in-memory config', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'to-delete', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });

        const del = await server.inject({
            method: 'DELETE',
            url: '/api/workflows/to-delete',
        });
        expect(del.statusCode).toBe(200);

        const detail = await server.inject({
            method: 'GET',
            url: '/api/workflows/to-delete/details',
        });
        expect(detail.statusCode).toBe(404);
    });

    // ── Rename ─────────────────────────────────────────────────────────────
    it('POST /:name/rename moves the workflow to the new name', async () => {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'old-name', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });

        const res = await server.inject({
            method: 'POST',
            url: '/api/workflows/old-name/rename',
            payload: { newName: 'new-name' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).name).toBe('new-name');

        // Old gone, new present.
        expect((await server.inject({ method: 'GET', url: '/api/workflows/old-name/details' })).statusCode).toBe(404);
        const moved = await server.inject({ method: 'GET', url: '/api/workflows/new-name/details' });
        expect(moved.statusCode).toBe(200);
        expect(JSON.parse(moved.payload).workflow?.name).toBe('new-name');
    });

    it('POST /:name/rename rejects a name that already exists (409)', async () => {
        for (const name of ['flow-a', 'flow-b']) {
            await server.inject({
                method: 'POST',
                url: '/api/workflows',
                payload: { name, trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
            });
        }
        const res = await server.inject({
            method: 'POST',
            url: '/api/workflows/flow-a/rename',
            payload: { newName: 'flow-b' },
        });
        expect(res.statusCode).toBe(409);
        // flow-a must be untouched after a rejected rename.
        expect((await server.inject({ method: 'GET', url: '/api/workflows/flow-a/details' })).statusCode).toBe(200);
    });

    it('POST /:name/rename returns 404 for an unknown workflow and 400 for an invalid name', async () => {
        expect((await server.inject({
            method: 'POST', url: '/api/workflows/ghost/rename', payload: { newName: 'whatever' },
        })).statusCode).toBe(404);

        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'rename-bad', trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [], edges: [] } },
        });
        const bad = await server.inject({
            method: 'POST', url: '/api/workflows/rename-bad/rename', payload: { newName: 'has spaces!' },
        });
        expect(bad.statusCode).toBe(400);
    });

    // ── Library install cascade ────────────────────────────────────────────
    // The dashboard "Install" flow POSTs the workflow with a `_libraryItem`
    // tag and a `template:` reference. The server walks the template's
    // graph and saves any AI-node config as a preset tagged
    // `library:<itemId>` — so installing "security-audit" silently
    // surfaces a pre-prompted ai.agent in the editor palette.
    it('POST with _libraryItem auto-extracts presets from the referenced library template', async () => {
        await writeFile(
            join(templateDir, 'library', 'security-audit.yaml'),
            `description: Security audit
icon: 🔒
graph:
  nodes:
    - id: audit
      type: ai.agent
      config:
        prompt: Run a security audit of this PR
        max_turns: 5
    - id: clone
      type: github.clone-repo
      config: {}
  edges: []
`,
            'utf-8',
        );

        const res = await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: {
                name: 'my-security-audit',
                template: 'security-audit',
                _libraryItem: 'security-audit',
                trigger: { source: 'manual', event: 'manual' },
            },
        });
        expect(res.statusCode).toBe(200);

        const presets = await presetStore.list();
        expect(presets).toHaveLength(1);
        expect(presets[0].nodeType).toBe('ai.agent');
        expect(presets[0].source).toBe('library:security-audit');
        expect(presets[0].config.prompt).toBe('Run a security audit of this PR');
    });

    it('re-installing the same library item replaces existing presets (idempotent)', async () => {
        await writeFile(
            join(templateDir, 'library', 'audit.yaml'),
            `graph:
  nodes:
    - id: a
      type: ai.agent
      config: { prompt: v1 }
  edges: []
`,
            'utf-8',
        );
        // First install
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: {
                name: 'my-audit-1',
                template: 'audit',
                _libraryItem: 'audit',
                trigger: { source: 'manual', event: 'manual' },
            },
        });
        expect((await presetStore.list())[0]?.config.prompt).toBe('v1');

        // Rewrite the template, install again under a new name —
        // shouldn't duplicate; should reflect the latest template.
        const { resetTemplateCache } = await import('../core/templates.js');
        resetTemplateCache();
        await writeFile(
            join(templateDir, 'library', 'audit.yaml'),
            `graph:
  nodes:
    - id: a
      type: ai.agent
      config: { prompt: v2 }
  edges: []
`,
            'utf-8',
        );
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: {
                name: 'my-audit-2',
                template: 'audit',
                _libraryItem: 'audit',
                trigger: { source: 'manual', event: 'manual' },
            },
        });
        const after = await presetStore.list();
        expect(after).toHaveLength(1);
        expect(after[0].config.prompt).toBe('v2');
    });

    it('DELETE of an installed workflow cascades: removes deck entry AND library-extracted presets', async () => {
        await writeFile(
            join(templateDir, 'library', 'audit.yaml'),
            `graph:
  nodes:
    - id: a
      type: ai.agent
      config: { prompt: clean me }
  edges: []
`,
            'utf-8',
        );
        const { resetTemplateCache } = await import('../core/templates.js');
        resetTemplateCache();

        // Seed deck (mirrors what the dashboard does after install).
        await configStore.updateRaw((config) => {
            config.deck = ['audit'];
        });
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: {
                name: 'my-audit',
                template: 'audit',
                _libraryItem: 'audit',
                trigger: { source: 'manual', event: 'manual' },
            },
        });
        expect(await presetStore.list()).toHaveLength(1);

        // Manual delete via workflows page (the bug path: bypasses
        // library uninstall, used to leave deck + presets stranded).
        const del = await server.inject({
            method: 'DELETE',
            url: '/api/workflows/my-audit',
        });
        expect(del.statusCode).toBe(200);

        // Deck cleaned → library card flips back to "Install".
        const finalRaw = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        expect((finalRaw.deck as string[]) ?? []).toEqual([]);
        // Presets cleaned → no orphans in the palette.
        expect(await presetStore.list()).toEqual([]);
    });

    it('DELETE of ONE instance keeps deck + presets while siblings from the same template remain', async () => {
        await writeFile(
            join(templateDir, 'library', 'audit2.yaml'),
            `graph:
  nodes:
    - id: a
      type: ai.agent
      config: { prompt: shared }
  edges: []
`,
            'utf-8',
        );
        const { resetTemplateCache } = await import('../core/templates.js');
        resetTemplateCache();

        await configStore.updateRaw((config) => {
            config.deck = ['audit2'];
        });
        // Two instances of the same library item ("Use Template" twice).
        for (const name of ['my-audit2', 'my-audit2-2']) {
            await server.inject({
                method: 'POST',
                url: '/api/workflows',
                payload: { name, template: 'audit2', _libraryItem: 'audit2', trigger: { source: 'manual', event: 'manual' } },
            });
        }

        // Delete just the first instance.
        const del = await server.inject({ method: 'DELETE', url: '/api/workflows/my-audit2' });
        expect(del.statusCode).toBe(200);

        // The sibling still exists → deck entry and shared presets must survive.
        const raw = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        expect((raw.deck as string[]) ?? []).toContain('audit2');
        expect((await presetStore.list()).length).toBeGreaterThan(0);

        // Deleting the last instance now cascades the cleanup.
        await server.inject({ method: 'DELETE', url: '/api/workflows/my-audit2-2' });
        const rawAfter = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        expect((rawAfter.deck as string[]) ?? []).not.toContain('audit2');
        expect(await presetStore.list()).toEqual([]);
    });

    it('DELETE keeps deck while a LEGACY (untagged) sibling created from the same recipe remains', async () => {
        await writeFile(
            join(templateDir, 'library', 'audit3.yaml'),
            `graph:
  nodes:
    - id: a
      type: ai.agent
      config: { prompt: shared }
  edges: []
`,
            'utf-8',
        );
        const { resetTemplateCache } = await import('../core/templates.js');
        resetTemplateCache();

        await configStore.updateRaw((config) => {
            config.deck = ['audit3'];
        });
        // A tagged instance plus a legacy one matched only by the `my-<id>`
        // name convention (no `_libraryItem` tag, as pre-provenance installs).
        await server.inject({
            method: 'POST', url: '/api/workflows',
            payload: { name: 'tagged-audit3', template: 'audit3', _libraryItem: 'audit3', trigger: { source: 'manual', event: 'manual' } },
        });
        await server.inject({
            method: 'POST', url: '/api/workflows',
            payload: { name: 'my-audit3', template: 'audit3', trigger: { source: 'manual', event: 'manual' } },
        });

        // Delete the tagged one — the legacy sibling should keep the deck entry.
        await server.inject({ method: 'DELETE', url: '/api/workflows/tagged-audit3' });
        const raw = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        expect((raw.deck as string[]) ?? []).toContain('audit3');

        // Now delete the LAST instance — an untagged legacy one. The library id
        // is inferred from its `my-<id>` name (confirmed against the deck), so
        // the cascade still fires and the deck entry is cleaned.
        await server.inject({ method: 'DELETE', url: '/api/workflows/my-audit3' });
        const rawFinal = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        expect((rawFinal.deck as string[]) ?? []).not.toContain('audit3');
    });

    // ─── POST /api/workflows/:name/toggle ───────────────────────────────

    const readWf = async (name: string): Promise<Record<string, unknown> | undefined> => {
        const raw = yaml.load(await configStore.readRaw()) as Record<string, unknown>;
        return ((raw.workflows as Record<string, unknown>[]) ?? []).find((w) => w.name === name);
    };

    async function createWf(name: string): Promise<void> {
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name, trigger: { source: 'manual', event: 'manual' }, graph: { nodes: [{ id: 'n1' }], edges: [] } },
        });
    }

    it('toggle with no body flips enabled→disabled then disabled→enabled', async () => {
        await createWf('flip-me');

        const off = await server.inject({ method: 'POST', url: '/api/workflows/flip-me/toggle' });
        expect(off.statusCode).toBe(200);
        expect(JSON.parse(off.payload).enabled).toBe(false);
        expect((await readWf('flip-me'))?.enabled).toBe(false); // persisted

        const on = await server.inject({ method: 'POST', url: '/api/workflows/flip-me/toggle' });
        expect(JSON.parse(on.payload).enabled).toBe(true);
        // Re-enabled → the `enabled` field is dropped (enabled is the default).
        expect((await readWf('flip-me'))?.enabled).toBeUndefined();
    });

    it('toggle with explicit { enabled } sets the state directly', async () => {
        await createWf('set-me');

        const disable = await server.inject({
            method: 'POST', url: '/api/workflows/set-me/toggle', payload: { enabled: false },
        });
        expect(JSON.parse(disable.payload).enabled).toBe(false);
        expect((await readWf('set-me'))?.enabled).toBe(false);

        const enable = await server.inject({
            method: 'POST', url: '/api/workflows/set-me/toggle', payload: { enabled: true },
        });
        expect(JSON.parse(enable.payload).enabled).toBe(true);
        expect((await readWf('set-me'))?.enabled).toBeUndefined();
    });

    it('a non-boolean enabled value flips rather than coercing to a truthy set', async () => {
        await createWf('coerce-me'); // starts enabled (no field)
        const res = await server.inject({
            method: 'POST', url: '/api/workflows/coerce-me/toggle', payload: { enabled: 'true' },
        });
        // "true" is not a boolean → flip (enabled default → disabled).
        expect(JSON.parse(res.payload).enabled).toBe(false);
        expect((await readWf('coerce-me'))?.enabled).toBe(false);
    });

    it('toggle on a missing workflow → 404', async () => {
        const res = await server.inject({ method: 'POST', url: '/api/workflows/nope/toggle' });
        expect(res.statusCode).toBe(404);
    });

    // ─── GET /:name/details applies syncTriggerNodeFromWorkflow ──────────

    it('details endpoint projects the merged trigger into the graph trigger node', async () => {
        // Mismatched: top-level trigger is gh-cli + author, but the graph
        // trigger node is a stale trigger.github with no author — the exact
        // shape that rendered wrong in the visual editor.
        await server.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: {
                name: 'sync-it',
                trigger: { source: 'gh-cli', event: ['pull_request.opened'], author: 'Tjemmmic' },
                graph: {
                    nodes: [
                        { id: 'trigger', type: 'trigger.github', config: { events: ['pull_request.opened'] } },
                        { id: 'fetch', type: 'github.fetch-diff', config: {} },
                    ],
                    edges: [],
                },
            },
        });

        const detail = await server.inject({ method: 'GET', url: '/api/workflows/sync-it/details' });
        expect(detail.statusCode).toBe(200);
        const node = JSON.parse(detail.payload).workflow.graph.nodes.find((n: { id: string }) => n.id === 'trigger');
        expect(node.type).toBe('trigger.gh-cli');
        expect(node.config.authors).toEqual(['Tjemmmic']);
        // The non-trigger node is untouched.
        const fetch = JSON.parse(detail.payload).workflow.graph.nodes.find((n: { id: string }) => n.id === 'fetch');
        expect(fetch.type).toBe('github.fetch-diff');
    });
});
