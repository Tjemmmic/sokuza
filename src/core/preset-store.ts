/**
 * Per-user store for node presets — pre-configured drop-in instances of
 * registered node types that surface as their own group in the visual
 * editor's palette.
 *
 * A preset is `(nodeType, config)` plus display metadata. Dragging a
 * preset spawns the underlying node type with the preset's config
 * pre-applied; there's no new runtime code or new ports.
 *
 * Two origins:
 *   - `library:<itemId>`  — auto-extracted on library install (e.g. the
 *                            `security-audit` template's `ai.agent` node
 *                            with its security-audit prompt becomes a
 *                            "Security Audit" preset). Auto-cleaned on
 *                            uninstall, so the user never has to manage
 *                            presets manually.
 *   - `user`              — saved manually from the editor's "Save as
 *                            preset" affordance (future work — the
 *                            store already supports it).
 *
 * Persisted to `~/.sokuza/node-presets.json` with the same atomic-write
 * pattern as `config-store.ts`. Per-user (not per-config) so a fresh
 * checkout doesn't lose customisations.
 */

import { readFile, writeFile, rename, unlink, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

export interface NodePreset {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    nodeType: string;
    config: Record<string, unknown>;
    /** Origin marker — `library:<id>` for auto-extracted, `user` for manual. */
    source: string;
    createdAt: string;
}

export type NewPreset = Omit<NodePreset, 'id' | 'createdAt'>;

interface PresetFile {
    presets: NodePreset[];
}

function defaultPresetPath(): string {
    return process.env.SOKUZA_PRESET_PATH ?? join(homedir(), '.sokuza', 'node-presets.json');
}

export class PresetStore {
    private readonly filePath: string;
    private readonly logger: Logger;
    private writeLock: Promise<void> = Promise.resolve();

    constructor(logger: Logger, filePath?: string) {
        this.logger = logger;
        this.filePath = filePath ?? defaultPresetPath();
    }

    getPath(): string { return this.filePath; }

    async list(): Promise<NodePreset[]> {
        if (!existsSync(this.filePath)) return [];
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as PresetFile;
            return Array.isArray(parsed.presets) ? parsed.presets : [];
        } catch (err) {
            this.logger.warn({ err, filePath: this.filePath }, 'Failed to read presets — returning empty list');
            return [];
        }
    }

    async create(input: NewPreset): Promise<NodePreset> {
        const preset: NodePreset = {
            ...input,
            id: generateId(),
            createdAt: new Date().toISOString(),
        };
        await this.mutate((file) => { file.presets.push(preset); });
        return preset;
    }

    async deleteOne(id: string): Promise<boolean> {
        let removed = false;
        await this.mutate((file) => {
            const before = file.presets.length;
            file.presets = file.presets.filter((p) => p.id !== id);
            removed = file.presets.length !== before;
        });
        return removed;
    }

    /** Remove every preset whose `source` matches — used to cascade
     *  library-uninstall cleanups so the palette doesn't accumulate
     *  presets for templates the user no longer has installed. */
    async deleteBySource(source: string): Promise<number> {
        let removed = 0;
        await this.mutate((file) => {
            const before = file.presets.length;
            file.presets = file.presets.filter((p) => p.source !== source);
            removed = before - file.presets.length;
        });
        return removed;
    }

    /** Replace every preset of a given source. Used by library extraction
     *  so re-installing the same template doesn't duplicate presets and
     *  picks up any edits the template author made between installs. */
    async replaceBySource(source: string, newPresets: Omit<NewPreset, 'source'>[]): Promise<NodePreset[]> {
        const created: NodePreset[] = newPresets.map((p) => ({
            ...p,
            source,
            id: generateId(),
            createdAt: new Date().toISOString(),
        }));
        await this.mutate((file) => {
            file.presets = file.presets.filter((p) => p.source !== source).concat(created);
        });
        return created;
    }

    private async mutate(fn: (file: PresetFile) => void): Promise<void> {
        // Serialise writes against ourselves so two near-simultaneous
        // installs don't race on the read-modify-write.
        const previous = this.writeLock;
        let release!: () => void;
        const next = new Promise<void>((r) => { release = r; });
        this.writeLock = previous.then(() => next);
        try {
            await previous;
            const file = await this.readFile();
            fn(file);
            await this.writeFile(file);
        } finally {
            release();
        }
    }

    private async readFile(): Promise<PresetFile> {
        if (!existsSync(this.filePath)) return { presets: [] };
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as PresetFile;
            if (!parsed || !Array.isArray(parsed.presets)) return { presets: [] };
            return parsed;
        } catch {
            return { presets: [] };
        }
    }

    private async writeFile(file: PresetFile): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmpPath = this.filePath + '.tmp';
        const json = JSON.stringify(file, null, 2);
        try {
            await writeFile(tmpPath, json, 'utf-8');
            await rename(tmpPath, this.filePath);
            // Same restrictive perms as config.yaml — preset configs may
            // include sensitive defaults that survived from a template
            // (e.g. an API host in a template's `base_url`).
            await chmod(this.filePath, 0o600).catch(() => undefined);
        } catch (err) {
            try { await unlink(tmpPath); } catch { /* ignore */ }
            throw err;
        }
    }
}

function generateId(): string {
    return 'preset_' + randomBytes(8).toString('hex');
}

// ─── Library template → presets extraction ──────────────────────────────────

/**
 * Pull AI-node configurations out of a library template's graph and shape
 * them as preset candidates. Skips nodes with empty configs (would be a
 * useless preset) and skips non-AI node types (a github.fetch-diff
 * preset adds zero value over the base node — the AI nodes' prompts
 * are the customisation that's worth preserving).
 */
const PRESET_WORTHY_TYPES = new Set(['ai.agent', 'ai.review', 'ai.address-review']);

export function extractPresetsFromTemplate(
    templateName: string,
    templateGraph: { nodes?: Array<{ id?: string; type?: string; config?: Record<string, unknown> }> } | undefined,
    templateMeta: { description?: string; icon?: string } = {},
): Omit<NewPreset, 'source'>[] {
    const nodes = templateGraph?.nodes ?? [];
    const presets: Omit<NewPreset, 'source'>[] = [];
    for (const node of nodes) {
        if (!node.type || !PRESET_WORTHY_TYPES.has(node.type)) continue;
        const config = node.config ?? {};
        // Skip empty-config nodes — they're just the base node type,
        // not a customisation worth surfacing as a preset.
        if (Object.keys(config).length === 0) continue;
        presets.push({
            // "<Template Title>: <Node Type>" reads well in the palette.
            // If there are multiple presetable nodes in one template, the
            // node id disambiguates them.
            name: presetName(templateName, node.id, node.type, nodes),
            description: templateMeta.description,
            icon: templateMeta.icon || iconForNodeType(node.type),
            nodeType: node.type,
            config: { ...config },
        });
    }
    return presets;
}

function presetName(templateName: string, nodeId: string | undefined, nodeType: string, nodes: Array<{ type?: string }>): string {
    const pretty = templateName.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    const sameTypeCount = nodes.filter((n) => n.type === nodeType).length;
    // When the template only has one node of this type, the type alone
    // is unambiguous. Otherwise tag with the node id so the palette
    // shows distinct names.
    return sameTypeCount > 1 && nodeId
        ? `${pretty} (${nodeId})`
        : pretty;
}

function iconForNodeType(nodeType: string): string {
    if (nodeType === 'ai.agent') return '🛠️';
    if (nodeType === 'ai.review') return '🤖';
    if (nodeType === 'ai.address-review') return '🩹';
    return '⚙️';
}
