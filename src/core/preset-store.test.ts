import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore, extractPresetsFromTemplate } from './preset-store.js';

const logger = pino({ level: 'silent' });

describe('PresetStore', () => {
    let dir: string;
    let store: PresetStore;
    let filePath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'sokuza-presets-'));
        filePath = join(dir, 'node-presets.json');
        store = new PresetStore(logger, filePath);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('returns an empty list when no file exists', async () => {
        expect(await store.list()).toEqual([]);
    });

    it('persists a created preset to disk with id + timestamp', async () => {
        const p = await store.create({
            name: 'Security Audit Agent',
            nodeType: 'ai.agent',
            config: { prompt: 'audit', max_turns: 5 },
            source: 'library:security-audit',
        });
        expect(p.id).toMatch(/^preset_[0-9a-f]+$/);
        expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const raw = JSON.parse(await readFile(filePath, 'utf-8'));
        expect(raw.presets).toHaveLength(1);
        expect(raw.presets[0].name).toBe('Security Audit Agent');
    });

    it('deleteOne returns false for an unknown id and true for a known one', async () => {
        const p = await store.create({ name: 'x', nodeType: 'ai.agent', config: { a: 1 }, source: 'user' });
        expect(await store.deleteOne('bogus')).toBe(false);
        expect(await store.deleteOne(p.id)).toBe(true);
        expect(await store.list()).toEqual([]);
    });

    it('deleteBySource removes every preset of that source and reports the count (cascade-on-uninstall)', async () => {
        await store.create({ name: 'a', nodeType: 'ai.agent', config: { p: 1 }, source: 'library:foo' });
        await store.create({ name: 'b', nodeType: 'ai.review', config: { p: 2 }, source: 'library:foo' });
        await store.create({ name: 'c', nodeType: 'ai.agent', config: { p: 3 }, source: 'library:other' });
        await store.create({ name: 'd', nodeType: 'ai.agent', config: { p: 4 }, source: 'user' });

        const removed = await store.deleteBySource('library:foo');
        expect(removed).toBe(2);
        const remaining = await store.list();
        expect(remaining.map((p) => p.name).sort()).toEqual(['c', 'd']);
    });

    it('replaceBySource swaps the set for a source — used to keep re-installs idempotent', async () => {
        await store.create({ name: 'old-1', nodeType: 'ai.agent', config: { p: 1 }, source: 'library:foo' });
        await store.create({ name: 'old-2', nodeType: 'ai.agent', config: { p: 2 }, source: 'library:foo' });
        await store.create({ name: 'user-keep', nodeType: 'ai.agent', config: { p: 3 }, source: 'user' });

        const fresh = await store.replaceBySource('library:foo', [
            { name: 'new-1', nodeType: 'ai.agent', config: { p: 'X' } },
        ]);
        expect(fresh).toHaveLength(1);

        const remaining = await store.list();
        const names = remaining.map((p) => p.name).sort();
        expect(names).toEqual(['new-1', 'user-keep']);
    });

    it('writes the file with 0600 permissions (preset configs may carry sensitive defaults from templates)', async () => {
        await store.create({ name: 'x', nodeType: 'ai.agent', config: { p: 1 }, source: 'user' });
        const s = await stat(filePath);
        // Mask off the file-type bits; only the perm bits matter.
        // Skip on platforms where chmod is a no-op (Windows): the
        // store swallows chmod errors so this only enforces the
        // contract where it can actually be enforced.
        if (process.platform !== 'win32') {
            expect(s.mode & 0o777).toBe(0o600);
        }
    });

    it('survives a corrupt JSON file by treating it as empty', async () => {
        const path = join(dir, 'corrupt.json');
        const store2 = new PresetStore(logger, path);
        // Write junk before any list/create.
        await (await import('node:fs/promises')).writeFile(path, '{not json', 'utf-8');
        expect(await store2.list()).toEqual([]);
        // create() should still work — it'll overwrite the garbage.
        await store2.create({ name: 'x', nodeType: 'ai.agent', config: { p: 1 }, source: 'user' });
        expect((await store2.list())).toHaveLength(1);
    });
});

// The library install flow runs `extractPresetsFromTemplate` against the
// template's graph. The contract: only `ai.*` nodes with non-empty
// configs become presets (anything else is either the base node type
// providing zero customisation, or a non-AI node where a preset adds
// no value over the palette node).

describe('extractPresetsFromTemplate', () => {
    it('extracts ai.agent nodes with non-empty configs and skips bare nodes', () => {
        const graph = {
            nodes: [
                { id: 't', type: 'trigger.github', config: {} },
                { id: 'clone', type: 'github.clone-repo', config: {} },
                { id: 'audit', type: 'ai.agent', config: { prompt: 'Run a security audit', max_turns: 5 } },
                { id: 'bare', type: 'ai.agent', config: {} }, // skipped — no customisation
            ],
        };
        const out = extractPresetsFromTemplate('security-audit', graph, { description: 'audit', icon: '🔒' });
        expect(out).toHaveLength(1);
        expect(out[0].nodeType).toBe('ai.agent');
        expect(out[0].config.prompt).toBe('Run a security audit');
        expect(out[0].icon).toBe('🔒');
    });

    it('extracts ai.review nodes too — and picks a fallback icon when the template has none', () => {
        const graph = {
            nodes: [
                { id: 'r', type: 'ai.review', config: { prompt: 'Be strict' } },
            ],
        };
        const out = extractPresetsFromTemplate('strict-review', graph, {});
        expect(out).toHaveLength(1);
        expect(out[0].icon).toBe('🤖');
    });

    it('disambiguates multi-node-of-same-type templates with the node id', () => {
        const graph = {
            nodes: [
                { id: 'a', type: 'ai.agent', config: { prompt: 'A' } },
                { id: 'b', type: 'ai.agent', config: { prompt: 'B' } },
            ],
        };
        const out = extractPresetsFromTemplate('multi-step', graph, {});
        expect(out.map((p) => p.name)).toEqual(['Multi Step (a)', 'Multi Step (b)']);
    });

    it('skips non-preset-worthy node types (only AI nodes carry meaningful customisation)', () => {
        const graph = {
            nodes: [
                { id: 'c', type: 'github.comment', config: { body: 'Hello' } },
                { id: 'l', type: 'utility.log', config: { message: 'x' } },
            ],
        };
        expect(extractPresetsFromTemplate('chatty', graph, {})).toEqual([]);
    });

    it('returns [] for an empty or missing graph', () => {
        expect(extractPresetsFromTemplate('x', undefined, {})).toEqual([]);
        expect(extractPresetsFromTemplate('x', { nodes: [] }, {})).toEqual([]);
    });
});
