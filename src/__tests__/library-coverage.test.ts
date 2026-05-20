import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { getNodeRegistry, resetNodeRegistry } from '../core/nodes/registry.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';

// Coverage contract for the workflow library.
//
// The library is two layers:
//   1. dashboard/app.js#libraryItems — the catalog cards the user sees.
//      Each entry references a `template` name.
//   2. templates/**/*.yaml — the actual workflow definitions referenced
//      by name.
//
// And the underlying surface:
//   3. src/core/nodes/builtins.ts — the registry of node types the
//      runtime executes.
//
// We assert two contracts:
//   A. Every `libraryItems` entry references a template that exists.
//   B. Every node type in the registry appears in at least one library
//      template (whether legacy `steps:` or graph `graph:` form).
//
// Both contracts protect against silent rot: a future PR that adds a node
// without giving it a workflow, or a catalog card that points at a
// missing template, fails CI here.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TEMPLATE_DIRS = [
    join(REPO_ROOT, 'templates'),
    join(REPO_ROOT, 'templates', 'library'),
];
const APP_JS_PATH = join(REPO_ROOT, 'dashboard', 'app.js');

function loadAllTemplateNames(): Set<string> {
    const names = new Set<string>();
    for (const dir of TEMPLATE_DIRS) {
        let files: string[];
        try { files = readdirSync(dir); }
        catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
            const name = f.replace(/\.ya?ml$/, '');
            names.add(name);
        }
    }
    return names;
}

interface ParsedTemplate {
    name: string;
    steps?: Array<{ action?: string }>;
    graph?: { nodes?: Array<{ type?: string }> };
}

function loadAllTemplates(): ParsedTemplate[] {
    const out: ParsedTemplate[] = [];
    const seen = new Set<string>();
    for (const dir of TEMPLATE_DIRS) {
        let files: string[];
        try { files = readdirSync(dir); }
        catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
            const name = f.replace(/\.ya?ml$/, '');
            if (seen.has(name)) continue; // library/ wins over root
            seen.add(name);
            const content = readFileSync(join(dir, f), 'utf-8');
            const parsed = (yaml.load(content) ?? {}) as Record<string, unknown>;
            out.push({
                name,
                steps: parsed.steps as ParsedTemplate['steps'],
                graph: parsed.graph as ParsedTemplate['graph'],
            });
        }
    }
    return out;
}

function extractCatalogTemplateNames(): string[] {
    const src = readFileSync(APP_JS_PATH, 'utf-8');
    // libraryItems entries look like:
    //   { id: '...', ..., template: 'name', ... }
    // We can't import app.js (it's a browser script), so scrape templates
    // by regex. The format is stable enough for a contract test.
    const out: string[] = [];
    const re = /template:\s*['"]([a-zA-Z0-9_-]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        out.push(m[1]);
    }
    return out;
}

// Map legacy step `action` → node type so coverage from steps-form
// templates counts toward node coverage. Mirror of
// dashboard/graph-editor.js#ACTION_TO_NODE_TYPE.
const ACTION_TO_NODE_TYPE: Record<string, string> = {
    log: 'utility.log',
    webhook: 'utility.webhook',
    'ai-review': 'ai.review',
    'ai-agent': 'ai.agent',
    'address-review': 'ai.address-review',
    'github-fetch-diff': 'github.fetch-diff',
    'github-comment': 'github.comment',
    'github-clone-repo': 'github.clone-repo',
    'github-create-pr': 'github.create-pr',
    'github-create-review': 'github.create-review',
    'github-fetch-reviews': 'github.fetch-reviews',
    'github-fetch-pr': 'github.fetch-pr',
    'github-fetch-issue': 'github.fetch-issue',
    'github-merge-pr': 'github.merge-pr',
    'github-update-pr': 'github.update-pr',
    'github-wait-for-checks': 'github.wait-for-checks',
    'github-add-label': 'github.add-label',
    'github-remove-label': 'github.remove-label',
    'git-commit-and-push': 'git.commit-and-push',
    'slack-send-message': 'slack.send-message',
    'slack-react': 'slack.react',
};

describe('library coverage contract', () => {
    it('every library catalog entry references a template that exists on disk', () => {
        const catalogTemplates = extractCatalogTemplateNames();
        expect(catalogTemplates.length).toBeGreaterThan(0);
        const onDisk = loadAllTemplateNames();
        const missing = [...new Set(catalogTemplates)].filter((t) => !onDisk.has(t));
        expect(missing, `Catalog references missing templates: ${missing.join(', ')}`).toEqual([]);
    });

    it('every node type in the registry appears in at least one library template', () => {
        resetNodeRegistry();
        registerBuiltinNodes(getNodeRegistry());
        const registry = getNodeRegistry();
        const allNodeTypes = registry.list().map((d) => d.type);

        const templates = loadAllTemplates();

        // Walk every template and collect node types it touches.
        const exercised = new Set<string>();
        for (const t of templates) {
            for (const n of t.graph?.nodes ?? []) {
                if (n?.type) exercised.add(n.type);
            }
            for (const s of t.steps ?? []) {
                if (s?.action && ACTION_TO_NODE_TYPE[s.action]) {
                    exercised.add(ACTION_TO_NODE_TYPE[s.action]);
                }
            }
        }

        const uncovered = allNodeTypes.filter((t) => !exercised.has(t));
        expect(
            uncovered,
            `Uncovered node types (no library template references them): ${uncovered.join(', ')}`,
        ).toEqual([]);
    });
});
