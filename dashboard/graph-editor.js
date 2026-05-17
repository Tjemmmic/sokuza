// ─── Sokuza Visual Workflow Editor ──────────────────────────────────────────
//
// A node-graph editor for sokuza workflows: drag node types from the
// palette, drop them on the canvas, drag-wire output ports → input ports,
// configure each node in the inspector, hit Save. Backed by /api/nodes for
// the registry and /api/workflows for persistence. No bundler — vanilla
// JS, SVG for the wires, absolutely-positioned divs for node cards.
//
// Globals expected from app.js: $, $$, api, esc, jsEsc, toast, navigate,
// openModal, closeModal, eventCatalog, eventLabelMap.

const ge = (window._gEditor = {
    // populated by openGraphEditor()
    isNew: false,
    originalName: null,         // null when creating new
    workflow: null,             // { name, description, enabled, graph: {nodes, edges}, ... }
    nodeDefsByType: {},         // type → SerializedNodeDefinition
    nodeDefsList: [],
    selectedNodeId: null,
    selectedEdgeId: null,
    // canvas viewport
    viewport: { x: 0, y: 0, scale: 1 },
    // ephemeral interaction state
    drag: null,                 // { kind:'node'|'pan'|'wire', ... }
    wiringFrom: null,           // { nodeId, port }
    palette: { search: '', collapsedGroups: {} },
});

// Public entrypoint — exposed via window for app.js to call.
//
// Modes:
//   - openGraphEditor()                            → recipe picker (new wf)
//   - openGraphEditor("my-workflow")               → load from /api/workflows
//   - openGraphEditor(null, { staged: { ... } })   → drop straight into the
//        editor with a pre-staged workflow shape (used by library "Edit
//        in Visual Editor" clicks). Save creates a new workflow + (when
//        opts.libraryItemId is set) flips the library badge to Installed.
window.openGraphEditor = async function (workflowName, opts = {}) {
    const staged = opts.staged || null;
    const isNew = !workflowName && !staged;
    ge.isNew = isNew || !!staged;
    ge.originalName = workflowName || null;
    ge.libraryItemId = opts.libraryItemId || null;
    ge.selectedNodeId = null;
    ge.selectedEdgeId = null;
    ge.viewport = { x: 0, y: 0, scale: 1 };
    ge.drag = null;
    ge.wiringFrom = null;

    try {
        // Load node defs first so the recipe modal (and downstream editor)
        // both have the registry available.
        const defsRes = await api.get('/api/nodes');
        ge.nodeDefsList = defsRes.nodes || [];
        ge.nodeDefsByType = Object.fromEntries(ge.nodeDefsList.map((d) => [d.type, d]));

        if (staged) {
            // Library click-to-open: skip the recipe picker, drop the user
            // straight into the editor with the template's graph already
            // loaded. They can rename, edit, and save = install.
            ge.workflow = ensureGraphShape(staged);
            renderEditor();
            return;
        }

        if (isNew) {
            // Show the recipe picker first — far less intimidating than
            // dropping the user on an empty canvas. They can still click
            // "Blank canvas" to skip.
            return openRecipePicker();
        }

        const wfRes = await api.get(`/api/workflows/${encodeURIComponent(workflowName)}/details`);
        ge.workflow = ensureGraphShape(wfRes.workflow);
        renderEditor();
    } catch (err) {
        toast(`Failed to open editor: ${err.message}`, 'error');
    }
};

// ─── Recipes ──────────────────────────────────────────────────────────────
//
// Pre-wired starter graphs the user can spawn instead of staring at an
// empty canvas. Each recipe is a workflow shape (the same JSON we save).
//
// Sources (in order):
//   1. YAML graph-form templates from /api/templates/library — the
//      canonical store. These are authored as full graph: blocks in
//      templates/library/*.yaml.
//   2. The hardcoded BUILTIN_RECIPES below — kept as a safety net so the
//      picker always has *some* options, including in dev environments
//      where the library directory is empty. YAML-loaded recipes with the
//      same id win.

const BUILTIN_RECIPES = [
    {
        id: 'manual-pr-review',
        title: 'Manual PR Review',
        icon: '🎮',
        tagline: 'Pick a PR from the dashboard and run an AI review on it',
        bullets: ['1 manual input (the PR)', 'Fetch its diff', 'AI Code Review', 'Post the review as a PR comment'],
        build: () => ({
            name: 'manual-pr-review',
            description: 'Run an AI review on demand against any PR',
            enabled: true,
            graph: {
                nodes: [
                    { id: 'trigger', type: 'trigger.manual', position: { x: 60, y: 160 },
                      config: { inputs: [{ name: 'pr', label: 'Pull Request', type: 'github-pr', required: true }] } },
                    { id: 'fetch_diff', type: 'github.fetch-diff', position: { x: 380, y: 160 },
                      config: {} },
                    { id: 'review', type: 'ai.review', position: { x: 720, y: 160 }, config: {} },
                    { id: 'post', type: 'github.comment', position: { x: 1060, y: 160 },
                      config: { body: '{{nodes.review.markdown}}' } },
                ],
                edges: [
                    { id: 'e1', from: { node: 'trigger', port: 'pr' }, to: { node: 'fetch_diff', port: 'pr_number' } },
                    { id: 'e2', from: { node: 'fetch_diff', port: 'diff' }, to: { node: 'review', port: 'diff' } },
                    { id: 'e3', from: { node: 'trigger', port: 'pr' }, to: { node: 'review', port: 'pr_number' } },
                    { id: 'e4', from: { node: 'trigger', port: 'pr' }, to: { node: 'post', port: 'pr_number' } },
                ],
            },
        }),
    },
    {
        id: 'auto-pr-review',
        title: 'Auto PR Review',
        icon: '⚡',
        tagline: 'Review every new PR automatically when it opens',
        bullets: ['GitHub trigger on pull_request.opened', 'Fetch diff', 'AI Code Review', 'Post comment'],
        build: () => ({
            name: 'auto-pr-review',
            description: 'AI review on every new PR',
            enabled: true,
            graph: {
                nodes: [
                    { id: 'trigger', type: 'trigger.github', position: { x: 60, y: 160 },
                      config: { events: ['pull_request.opened'] } },
                    { id: 'fetch_diff', type: 'github.fetch-diff', position: { x: 380, y: 160 }, config: {} },
                    { id: 'review', type: 'ai.review', position: { x: 720, y: 160 }, config: {} },
                    { id: 'post', type: 'github.comment', position: { x: 1060, y: 160 },
                      config: { body: '{{nodes.review.markdown}}' } },
                ],
                edges: [
                    { id: 'e1', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'fetch_diff', port: 'pr_number' } },
                    { id: 'e2', from: { node: 'trigger', port: 'repo' }, to: { node: 'fetch_diff', port: 'repo' } },
                    { id: 'e3', from: { node: 'fetch_diff', port: 'diff' }, to: { node: 'review', port: 'diff' } },
                    { id: 'e4', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'review', port: 'pr_number' } },
                    { id: 'e5', from: { node: 'trigger', port: 'repo' }, to: { node: 'review', port: 'repo' } },
                    { id: 'e6', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'post', port: 'pr_number' } },
                    { id: 'e7', from: { node: 'trigger', port: 'repo' }, to: { node: 'post', port: 'repo' } },
                ],
            },
        }),
    },
    {
        id: 'auto-fix-loop',
        title: 'Auto-Fix Loop',
        icon: '🩹',
        tagline: 'AI review → posted Review → address-review picks it up',
        bullets: ['Review every new PR as a real GitHub Review', 'Auto-fix workflow consumes the review', 'Suggest or push fixes'],
        build: () => ({
            name: 'auto-fix-pr-review',
            description: 'Auto review + auto fix loop',
            enabled: true,
            graph: {
                nodes: [
                    { id: 'trigger', type: 'trigger.github', position: { x: 60, y: 160 },
                      config: { events: ['pull_request.opened', 'pull_request.synchronize'] } },
                    { id: 'fetch_diff', type: 'github.fetch-diff', position: { x: 380, y: 160 }, config: {} },
                    { id: 'review', type: 'ai.review', position: { x: 720, y: 160 }, config: {} },
                    { id: 'post', type: 'github.create-review', position: { x: 1060, y: 160 },
                      config: { body: '{{nodes.review.markdown}}\n\n<!-- sokuza:run-id={{nodes.review.runId}} -->', event: 'COMMENT' } },
                ],
                edges: [
                    { id: 'e1', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'fetch_diff', port: 'pr_number' } },
                    { id: 'e2', from: { node: 'trigger', port: 'repo' }, to: { node: 'fetch_diff', port: 'repo' } },
                    { id: 'e3', from: { node: 'fetch_diff', port: 'diff' }, to: { node: 'review', port: 'diff' } },
                    { id: 'e4', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'review', port: 'pr_number' } },
                    { id: 'e5', from: { node: 'trigger', port: 'repo' }, to: { node: 'review', port: 'repo' } },
                    { id: 'e6', from: { node: 'trigger', port: 'prNumber' }, to: { node: 'post', port: 'pr_number' } },
                    { id: 'e7', from: { node: 'trigger', port: 'repo' }, to: { node: 'post', port: 'repo' } },
                ],
            },
        }),
    },
    {
        id: 'log-events',
        title: 'Log Events',
        icon: '📝',
        tagline: 'A no-op workflow that just logs every event — handy for debugging triggers',
        bullets: ['GitHub trigger on any event', 'Log message with source/event'],
        build: () => ({
            name: 'log-events',
            description: 'Trigger debug logger',
            enabled: true,
            graph: {
                nodes: [
                    { id: 'trigger', type: 'trigger.github', position: { x: 60, y: 160 }, config: {} },
                    { id: 'log', type: 'utility.log', position: { x: 420, y: 160 },
                      config: { message: 'event {{event.source}}.{{event.event}}', level: 'info' } },
                ],
                edges: [
                    { id: 'e1', from: { node: 'trigger', port: 'event' }, to: { node: 'log', port: 'message' } },
                ],
            },
        }),
    },
];

// Cache of recipes built from /api/templates/library — populated on first
// open of the picker, refreshed on subsequent opens so newly-authored YAML
// templates appear without a page reload.
let _yamlRecipes = null;

async function loadAllRecipes() {
    // Pull from BOTH locations: templates/library/ (the new graph-form
    // recipes) AND templates/ (the converted root-level ones like
    // ai-pr-review). Merge by name so a library/ entry wins on collision.
    const seen = new Set();
    let yamlRecipes = [];
    const sources = ['/api/templates/library', '/api/templates'];
    for (const url of sources) {
        try {
            const res = await api.get(url);
            const tpls = Array.isArray(res.templates) ? res.templates : [];
            for (const t of tpls) {
                if (!t.graph || !Array.isArray(t.graph.nodes) || t.graph.nodes.length === 0) continue;
                if (seen.has(t.name)) continue;
                seen.add(t.name);
                yamlRecipes.push(yamlTemplateToRecipe(t));
            }
        } catch (e) {
            // Network failure / endpoint missing — try next source.
        }
    }
    _yamlRecipes = yamlRecipes;

    // YAML wins on id collision so YAML edits override the builtin shape.
    const yamlIds = new Set(yamlRecipes.map((r) => r.id));
    const merged = [
        ...yamlRecipes,
        ...BUILTIN_RECIPES.filter((r) => !yamlIds.has(r.id)),
    ];
    return merged;
}

/** YAML template → recipe shape the picker renders. */
function yamlTemplateToRecipe(t) {
    const title = t.description ? prettyName(t.name) : prettyName(t.name);
    const tagline = t.description || `Starter recipe: ${prettyName(t.name)}`;
    // Derive bullets from the graph's node titles — keeps the card
    // self-explanatory even when the YAML omits an explicit bullets list.
    const bullets = (t.graph?.nodes || [])
        .filter((n) => !n.type?.startsWith('trigger.'))
        .slice(0, 5)
        .map((n) => prettyName(n.type.split('.').slice(1).join('.') || n.type));
    return {
        id: t.name,
        title,
        icon: t.icon || iconForGraph(t.graph),
        tagline,
        bullets: bullets.length ? bullets : ['Pre-wired starter graph'],
        source: 'yaml',
        build: () => ({
            name: t.name,
            description: t.description,
            enabled: true,
            graph: cloneGraph(t.graph),
        }),
    };
}

function prettyName(s) {
    if (!s) return '';
    return String(s).split(/[-._]/).filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function iconForGraph(g) {
    // Heuristic fallback when the YAML doesn't supply an icon.
    const types = (g?.nodes || []).map((n) => n.type || '');
    if (types.some((t) => t.startsWith('trigger.cron'))) return '⏰';
    if (types.some((t) => t.startsWith('trigger.slack'))) return '💬';
    if (types.some((t) => t.startsWith('trigger.webhook'))) return '🪝';
    if (types.some((t) => t.startsWith('trigger.gh-cli'))) return '⚡';
    if (types.some((t) => t.startsWith('trigger.github-poll'))) return '🔄';
    if (types.some((t) => t.startsWith('ai.review'))) return '🔍';
    if (types.some((t) => t.startsWith('ai.agent'))) return '🤖';
    if (types.some((t) => t.startsWith('flow.'))) return '🔀';
    if (types.some((t) => t.startsWith('data.'))) return '🧬';
    return '📄';
}

function cloneGraph(g) {
    return JSON.parse(JSON.stringify(g));
}

async function openRecipePicker() {
    const el = $('#content');
    // Render a loading shell first so the page doesn't flash blank.
    el.innerHTML = `
        <div class="ge-recipe-page">
            <div class="ge-recipe-header">
                <button class="btn btn-ghost btn-sm" onclick="closeGraphEditor()">← Workflows</button>
                <h1>How do you want to start?</h1>
                <p>Pick a starter graph — every wire is pre-built. You can rename, edit, and add nodes from there.</p>
            </div>
            <div class="ge-recipe-grid"><div style="padding:24px;color:var(--text-muted)">Loading recipes…</div></div>
        </div>
    `;

    const recipes = await loadAllRecipes();
    el.innerHTML = `
        <div class="ge-recipe-page">
            <div class="ge-recipe-header">
                <button class="btn btn-ghost btn-sm" onclick="closeGraphEditor()">← Workflows</button>
                <h1>How do you want to start?</h1>
                <p>Pick a starter graph — every wire is pre-built. You can rename, edit, and add nodes from there.</p>
            </div>
            <div class="ge-recipe-grid">
                ${recipes.map((r) => `
                    <div class="ge-recipe-card" data-recipe-id="${esc(r.id)}">
                        <div class="ge-recipe-icon">${esc(r.icon)}</div>
                        <h3>${esc(r.title)}</h3>
                        <p>${esc(r.tagline)}</p>
                        <ul>${r.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
                    </div>
                `).join('')}
                <div class="ge-recipe-card ge-recipe-blank" data-recipe-id="__blank">
                    <div class="ge-recipe-icon">📄</div>
                    <h3>Blank canvas</h3>
                    <p>Start from an empty graph with just a manual trigger.</p>
                </div>
            </div>
        </div>
    `;

    // Recipe ids round-trip through dataset attributes verbatim — no
    // HTML-entity-decode-then-eval surprise — so an id containing quotes,
    // angle brackets, or other JS-meaningful characters can never break
    // out of a quoted string literal in an inline onclick. Future ids
    // sourced from user input are safe by construction.
    el.querySelectorAll('.ge-recipe-card[data-recipe-id]').forEach((card) => {
        card.addEventListener('click', () => {
            window.pickRecipe(card.dataset.recipeId);
        });
    });
}

window.pickRecipe = async function (id) {
    if (id === '__blank') {
        ge.workflow = blankWorkflow();
    } else {
        // Recipes may have been loaded into _yamlRecipes; if the user
        // clicked between loadAllRecipes runs, refetch defensively.
        const recipes = await loadAllRecipes();
        const r = recipes.find((x) => x.id === id);
        if (!r) return;
        ge.workflow = r.build();
    }
    renderEditor();
};

function blankWorkflow() {
    return {
        name: '',
        description: '',
        enabled: true,
        graph: {
            // Seed with a manual trigger so the user has somewhere to start.
            nodes: [
                {
                    id: 'trigger',
                    type: 'trigger.manual',
                    position: { x: 80, y: 200 },
                    config: { inputs: [] },
                },
            ],
            edges: [],
        },
    };
}

/**
 * Take an existing workflow that may be either graph-form or legacy
 * steps-form and return a graph-form shape the editor can edit. For
 * legacy workflows we synthesize a linear graph: trigger → step1 → step2 …
 * The user can then re-arrange / re-wire visually.
 */
function ensureGraphShape(wf) {
    if (wf.graph && Array.isArray(wf.graph.nodes) && wf.graph.nodes.length > 0) {
        // Make sure every edge has an id so the editor can address it.
        wf.graph.edges = (wf.graph.edges || []).map((e, i) => ({ id: e.id || `e${i}`, ...e }));
        return wf;
    }

    // Synthesize a graph from the legacy form.
    const sources = ensureArr(wf.trigger?.source);
    const triggerType = legacyTriggerType(sources[0] || 'github');
    const triggerNode = {
        id: 'trigger',
        type: triggerType,
        position: { x: 80, y: 200 },
        config: legacyTriggerConfig(wf),
    };
    const nodes = [triggerNode];
    const edges = [];
    let lastId = 'trigger';
    let x = 380;
    (wf.steps || []).forEach((step, i) => {
        const id = step.id || `step${i + 1}`;
        const nodeType = guessNodeTypeForAction(step.action);
        nodes.push({
            id,
            type: nodeType,
            position: { x, y: 200 + (i % 2 === 0 ? 0 : 80) },
            config: step.params || {},
            condition: step.condition,
            on_error: step.on_error,
            timeout: step.timeout,
        });
        edges.push({ id: `e${edges.length}`, from: { node: lastId, port: 'event' }, to: { node: id, port: '__seq' } });
        lastId = id;
        x += 280;
    });
    wf.graph = { nodes, edges };
    return wf;
}

function ensureArr(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function legacyTriggerType(source) {
    return {
        github: 'trigger.github',
        'github-poll': 'trigger.github-poll',
        'gh-cli': 'trigger.gh-cli',
        slack: 'trigger.slack',
        webhook: 'trigger.webhook',
        cron: 'trigger.cron',
        manual: 'trigger.manual',
    }[source] || 'trigger.github';
}

function legacyTriggerConfig(wf) {
    return {
        events: ensureArr(wf.trigger?.event),
        repos: ensureArr(wf.trigger?.repo).join(', '),
        branches: ensureArr(wf.trigger?.branch).join(', '),
        authors: ensureArr(wf.trigger?.author).join(', '),
        labels: (wf.trigger?.labels || []).join(', '),
        inputs: wf.inputs || [],
    };
}

const ACTION_TO_NODE_TYPE = {
    log: 'utility.log',
    webhook: 'utility.webhook',
    'ai-review': 'ai.review',
    'ai-agent': 'ai.agent',
    'address-review': 'ai.address-review',
    'github-fetch-diff': 'github.fetch-diff',
    'github-fetch-pr': 'github.fetch-pr',
    'github-fetch-issue': 'github.fetch-issue',
    'github-fetch-reviews': 'github.fetch-reviews',
    'github-comment': 'github.comment',
    'github-clone-repo': 'github.clone-repo',
    'github-create-pr': 'github.create-pr',
    'github-create-review': 'github.create-review',
    'github-merge-pr': 'github.merge-pr',
    'github-update-pr': 'github.update-pr',
    'github-wait-for-checks': 'github.wait-for-checks',
    'github-add-label': 'github.add-label',
    'github-remove-label': 'github.remove-label',
    'git-commit-and-push': 'git.commit-and-push',
    'slack-send-message': 'slack.send-message',
    'slack-react': 'slack.react',
};

function guessNodeTypeForAction(action) {
    return ACTION_TO_NODE_TYPE[action] || 'utility.log';
}

// ─── Layout ────────────────────────────────────────────────────────────────

function renderEditor() {
    const el = $('#content');
    el.innerHTML = `
        <div class="ge-root" id="ge-root">
            <div class="ge-topbar">
                <button class="btn btn-ghost btn-sm" onclick="closeGraphEditor()">← Workflows</button>
                <input id="ge-name" class="ge-name-input" placeholder="workflow-name"
                    value="${esc(ge.workflow.name || '')}"
                    ${ge.isNew ? '' : 'readonly title="Workflow name is the unique key — duplicate to rename"'}
                    oninput="ge.workflow.name = this.value">
                <input id="ge-desc" class="ge-desc-input" placeholder="What does this workflow do?"
                    value="${esc(ge.workflow.description || '')}"
                    oninput="ge.workflow.description = this.value">
                <label class="ge-toggle" title="Enable / pause">
                    <input type="checkbox" ${ge.workflow.enabled !== false ? 'checked' : ''}
                        onchange="ge.workflow.enabled = this.checked">
                    <span>${ge.workflow.enabled !== false ? 'Enabled' : 'Paused'}</span>
                </label>
                <div style="flex:1"></div>
                <button class="btn btn-ghost btn-sm" onclick="autoLayoutGraph()" title="Re-layout the graph left-to-right">⊞ Auto-layout</button>
                <button class="btn btn-ghost btn-sm" onclick="zoomTo(1)">100%</button>
                <button class="btn btn-ghost btn-sm" onclick="zoomFit()" title="Fit graph to view">⊡ Fit</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleYamlPanel()">{ } YAML</button>
                <button class="btn btn-primary btn-sm" onclick="saveGraphWorkflow()">💾 Save</button>
            </div>

            <div class="ge-body">
                <aside class="ge-palette" id="ge-palette"></aside>
                <main class="ge-canvas-wrap" id="ge-canvas-wrap">
                    <div class="ge-canvas" id="ge-canvas">
                        <div class="ge-nodes" id="ge-nodes"></div>
                    </div>
                    <!-- SVG is a sibling of the transformed canvas so wire
                         endpoints live in viewport-relative pixel space and
                         never get double-transformed by pan/zoom. -->
                    <svg class="ge-edges" id="ge-edges" xmlns="http://www.w3.org/2000/svg"></svg>
                    <div class="ge-canvas-hint" id="ge-canvas-hint"></div>
                </main>
                <aside class="ge-inspector" id="ge-inspector"></aside>
            </div>

            <div class="ge-yaml-panel" id="ge-yaml-panel" style="display:none">
                <div class="ge-yaml-header">
                    <span>YAML preview</span>
                    <button class="btn btn-ghost btn-sm" onclick="toggleYamlPanel()">close</button>
                </div>
                <pre class="ge-yaml-pre" id="ge-yaml-pre"></pre>
            </div>
        </div>
    `;

    renderPalette();
    renderCanvas();
    renderInspector();
    bindCanvasInteractions();
    updateCanvasHint();
}

window.closeGraphEditor = function () {
    unbindCanvasInteractions();
    navigate('workflows');
};

// ─── Palette ───────────────────────────────────────────────────────────────

function renderPalette() {
    const el = $('#ge-palette');
    if (!el) return;

    const q = (ge.palette.search || '').toLowerCase();
    const filtered = ge.nodeDefsList.filter((d) => {
        if (!q) return true;
        return d.title.toLowerCase().includes(q)
            || d.type.toLowerCase().includes(q)
            || (d.description || '').toLowerCase().includes(q);
    });

    const groups = {};
    for (const d of filtered) {
        if (!groups[d.group]) groups[d.group] = [];
        groups[d.group].push(d);
    }
    const ordered = ['Triggers', 'AI', 'GitHub', 'Notify', 'Utility', 'Flow'];
    const groupNames = [...new Set([...ordered.filter((g) => groups[g]), ...Object.keys(groups)])];

    el.innerHTML = `
        <div class="ge-palette-header">
            <input class="ge-palette-search" placeholder="Search nodes…" value="${esc(ge.palette.search)}"
                oninput="ge.palette.search = this.value; renderPalette()">
        </div>
        <div class="ge-palette-body">
            ${groupNames.map((g) => {
                const collapsed = ge.palette.collapsedGroups[g];
                return `
                <div class="ge-palette-group">
                    <div class="ge-palette-group-h" onclick="togglePaletteGroup('${jsEsc(g)}')">
                        <span>${esc(g)}</span>
                        <span class="ge-palette-group-count">${groups[g].length}</span>
                        <span class="ge-palette-group-caret">${collapsed ? '▶' : '▼'}</span>
                    </div>
                    ${collapsed ? '' : `<div class="ge-palette-group-body">
                        ${groups[g].map((d) => `
                            <div class="ge-palette-item" draggable="true"
                                title="${esc(d.description)}"
                                ondragstart="onPaletteDragStart(event, '${jsEsc(d.type)}')"
                                onclick="addNodeOfType('${jsEsc(d.type)}')"
                                style="--node-color:${esc(d.color || 'var(--accent)')}">
                                <span class="ge-palette-icon">${esc(d.icon)}</span>
                                <div class="ge-palette-meta">
                                    <div class="ge-palette-title">${esc(d.title)}</div>
                                    <div class="ge-palette-desc">${esc(d.description)}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>`}
                </div>`;
            }).join('')}
        </div>
        <div class="ge-palette-footer">
            <div>${ge.nodeDefsList.length} node types</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Drag onto canvas, or click to add at center</div>
        </div>
    `;
}

window.togglePaletteGroup = function (g) {
    ge.palette.collapsedGroups[g] = !ge.palette.collapsedGroups[g];
    renderPalette();
};

window.onPaletteDragStart = function (e, type) {
    e.dataTransfer.setData('application/x-sokuza-node', type);
    e.dataTransfer.effectAllowed = 'copy';
};

// ─── Canvas (nodes + edges) ────────────────────────────────────────────────

function renderCanvas() {
    const nodesEl = $('#ge-nodes');
    const edgesEl = $('#ge-edges');
    if (!nodesEl || !edgesEl) return;

    // Render nodes.
    nodesEl.innerHTML = ge.workflow.graph.nodes.map((n) => renderNodeCard(n)).join('');

    // Render edges as SVG paths. Use the rendered port DOM rects so the
    // wires line up with the actual port-handle positions.
    requestAnimationFrame(() => drawEdges());
    applyViewportTransform();
}

function renderNodeCard(node) {
    const def = ge.nodeDefsByType[node.type];
    if (!def) {
        return `<div class="ge-node ge-node-broken" data-id="${esc(node.id)}"
            style="left:${node.position?.x ?? 0}px;top:${node.position?.y ?? 0}px"
            onmousedown="onNodeMouseDown(event, '${jsEsc(node.id)}')"
            onclick="selectNode('${jsEsc(node.id)}')">
            <div class="ge-node-header">⚠️ Unknown: ${esc(node.type)}</div>
            <div class="ge-node-body">Node type not registered. Delete or replace.</div>
        </div>`;
    }

    // Wire-able ports the user can hook things into. Inputs are static;
    // outputs may include config-driven additions (manual trigger inputs,
    // github-event-derived fields).
    const inputs = wireInputPorts(def);
    const outputs = wireOutputPorts(def, node);

    const selected = ge.selectedNodeId === node.id ? ' selected' : '';
    const wiring = ge.wiringFrom ? ' wiring' : '';
    const color = def.color || 'var(--accent)';
    const x = node.position?.x ?? 0;
    const y = node.position?.y ?? 0;
    const titleAttr = `${def.title} — ${def.description}`;

    return `<div class="ge-node ge-node-${esc(def.category)}${selected}${wiring}" data-id="${esc(node.id)}"
            style="left:${x}px;top:${y}px;--node-color:${esc(color)}"
            onmousedown="onNodeMouseDown(event, '${jsEsc(node.id)}')"
            onclick="selectNode('${jsEsc(node.id)}')">
        <div class="ge-node-header" title="${esc(titleAttr)}">
            <span class="ge-node-icon">${esc(def.icon)}</span>
            <div class="ge-node-title-wrap">
                <div class="ge-node-title">${esc(def.title)}</div>
                <div class="ge-node-id">${esc(node.id)}</div>
            </div>
        </div>
        <div class="ge-node-body">
            <div class="ge-ports ge-ports-in">
                ${inputs.map((p) => portHandle(node, p, 'input')).join('')}
            </div>
            <div class="ge-ports ge-ports-out">
                ${outputs.map((p) => portHandle(node, p, 'output')).join('')}
            </div>
        </div>
    </div>`;
}

/** Wire-able input ports: declared inputs that the user wires data into. */
function wireInputPorts(def) {
    return def.ports.filter((p) => p.role === 'input' && p.wire);
}

/**
 * Wire-able output ports, including config-driven dynamic ones. The actual
 * logic lives in graph-logic.js (loaded as a separate <script>) so it can be
 * parity-tested against the runtime's resolveOutputPorts. See that file's
 * "KEEP IN SYNC WITH src/core/nodes/types.ts" header before changing port
 * resolution or event-glob behaviour here.
 */
function wireOutputPorts(def, node) {
    return graphLogic.resolveWireableOutputPorts(def, node);
}

/** Render one port handle. Includes:
 *   - required-indicator dot for inputs that have no wire and no config value
 *   - "compatible" highlight when a wire-in-progress could plug in here
 *   - type label so the user can see what shape of value flows through
 */
function portHandle(node, port, side) {
    const cls = side === 'input' ? 'ge-port ge-port-in' : 'ge-port ge-port-out';
    const portType = port.type || 'any';

    const status = inputStatus(node, port, side);
    const statusCls = ` ge-port-${status}`;

    let compatibleCls = '';
    if (ge.wiringFrom && side === 'input') {
        const fromDef = ge.nodeDefsByType[
            ge.workflow.graph.nodes.find((n) => n.id === ge.wiringFrom.nodeId)?.type
        ];
        const fromPort = fromDef && wireOutputPorts(fromDef, ge.workflow.graph.nodes.find((n) => n.id === ge.wiringFrom.nodeId))
            .find((p) => p.name === ge.wiringFrom.port);
        const compat = fromPort && portsCompatible(fromPort.type, port.type) && ge.wiringFrom.nodeId !== node.id;
        compatibleCls = compat ? ' ge-port-compat' : ' ge-port-incompat';
    }

    const tip = `${port.label} · ${portType}${port.required ? ' · required' : ''}${port.helpText ? ' — ' + port.helpText : ''}`;
    return `<div class="${cls}${statusCls}${compatibleCls}" data-node="${esc(node.id)}" data-port="${esc(port.name)}" data-type="${esc(portType)}"
        title="${esc(tip)}"
        onmousedown="event.stopPropagation()"
        onclick="onPortClick(event, '${jsEsc(node.id)}', '${jsEsc(port.name)}', '${side}')">
        <span class="ge-port-dot"></span>
        <span class="ge-port-label">${esc(port.label)}${port.required && side === 'input' ? '<span class="ge-port-required">*</span>' : ''}</span>
        <span class="ge-port-type">${esc(portType)}</span>
    </div>`;
}

/** "ok" if this port is wired or has a config value; "missing" if required
 *  and absent; "neutral" otherwise. Used for the dot color. */
function inputStatus(node, port, side) {
    if (side !== 'input') return 'ok';
    const wired = ge.workflow.graph.edges.some((e) => e.to.node === node.id && e.to.port === port.name);
    const hasConfig = node.config && node.config[port.name] !== undefined && node.config[port.name] !== '';
    if (wired || hasConfig) return 'ok';
    return port.required ? 'missing' : 'neutral';
}

/** Two ports are compatible if either is `any`, both are equal, or one is
 *  `string` (we accept stringification to/from anything textual). */
function portsCompatible(a, b) {
    if (!a || !b || a === 'any' || b === 'any') return true;
    if (a === b) return true;
    const stringy = new Set(['string', 'number', 'boolean']);
    if (stringy.has(a) && stringy.has(b)) return true;
    return false;
}

function drawEdges() {
    const svg = $('#ge-edges');
    const wrap = $('#ge-canvas-wrap');
    const canvas = $('#ge-canvas');
    if (!svg || !wrap || !canvas) return;

    // Resize the SVG canvas to cover the visible viewport.
    const rect = wrap.getBoundingClientRect();
    svg.setAttribute('width', String(rect.width));
    svg.setAttribute('height', String(rect.height));

    const paths = [];
    for (const edge of ge.workflow.graph.edges) {
        const a = portCenter(edge.from.node, edge.from.port, 'output');
        const b = portCenter(edge.to.node, edge.to.port, 'input');
        if (!a || !b) continue;
        paths.push(edgePath(a, b, edge.id, ge.selectedEdgeId === edge.id));
    }

    // Live wire-in-progress preview.
    if (ge.wiringFrom && ge.wiringFrom.cursor) {
        const a = portCenter(ge.wiringFrom.nodeId, ge.wiringFrom.port, 'output');
        if (a) {
            paths.push(edgePath(a, ge.wiringFrom.cursor, '__live', false, true));
        }
    }

    svg.innerHTML = paths.join('');
}

/** Get the canvas-space center of a port handle. */
function portCenter(nodeId, port, side) {
    const sel = `.ge-port-${side === 'input' ? 'in' : 'out'}[data-node="${cssEsc(nodeId)}"][data-port="${cssEsc(port)}"] .ge-port-dot`;
    const el = document.querySelector(sel);
    const wrap = $('#ge-canvas-wrap');
    if (!el || !wrap) return null;
    const r = el.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    return { x: r.left + r.width / 2 - wr.left, y: r.top + r.height / 2 - wr.top };
}

function edgePath(a, b, id, selected, dashed) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.4);
    const path = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    const stroke = selected ? '#f43f5e' : 'rgba(99, 102, 241, 0.6)';
    const dash = dashed ? 'stroke-dasharray="6 4"' : '';
    return `
        <g class="ge-edge${selected ? ' selected' : ''}" data-id="${esc(id || '')}">
            <path class="ge-edge-hit" d="${path}" stroke="transparent" stroke-width="14" fill="none"
                onclick="selectEdge('${jsEsc(id || '')}')"></path>
            <path d="${path}" stroke="${stroke}" stroke-width="2" fill="none" ${dash}></path>
        </g>
    `;
}

function applyViewportTransform() {
    const c = $('#ge-canvas');
    if (!c) return;
    const v = ge.viewport;
    c.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
}

// ─── Inspector ─────────────────────────────────────────────────────────────

function renderInspector() {
    const el = $('#ge-inspector');
    if (!el) return;
    if (!ge.selectedNodeId) {
        el.innerHTML = `
            <div class="ge-inspector-empty">
                <div class="ge-inspector-empty-icon">🎯</div>
                <h3>Nothing selected</h3>
                <p>Click a node to configure it. Drag from the palette to add new nodes.
                   Click an output port, then an input port to wire them.</p>
                <hr>
                <h4>Workflow</h4>
                <div class="ge-stat"><b>${ge.workflow.graph.nodes.length}</b> nodes</div>
                <div class="ge-stat"><b>${ge.workflow.graph.edges.length}</b> connections</div>
            </div>`;
        return;
    }

    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) {
        ge.selectedNodeId = null;
        return renderInspector();
    }
    const def = ge.nodeDefsByType[node.type];
    if (!def) {
        el.innerHTML = `<div class="ge-inspector-empty"><h3>Broken node</h3>
            <p>Type "<code>${esc(node.type)}</code>" is not registered.</p>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteNode('${jsEsc(node.id)}')">Delete node</button></div>`;
        return;
    }

    const configPorts = def.ports.filter((p) => p.role === 'input' && p.config);
    const wireInputs = wireInputPorts(def);
    const inputsNeedingHelp = wireInputs.filter((p) => inputStatus(node, p, 'input') === 'missing');
    const wiredInputs = wireInputs.filter((p) =>
        ge.workflow.graph.edges.some((e) => e.to.node === node.id && e.to.port === p.name),
    );

    el.innerHTML = `
        <div class="ge-inspector-header" style="--node-color:${esc(def.color || 'var(--accent)')}">
            <span class="ge-inspector-icon">${esc(def.icon)}</span>
            <div class="ge-inspector-title">
                <div>${esc(def.title)}</div>
                <small>${esc(def.type)}</small>
            </div>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteNode('${jsEsc(node.id)}')">Delete</button>
        </div>
        <div class="ge-inspector-body">
            <div class="form-group">
                <label class="form-label">Node Id</label>
                <input class="form-input" value="${esc(node.id)}"
                    onchange="renameNode('${jsEsc(node.id)}', this.value)">
                <div class="form-hint">Used in templates: <code>{{nodes.${esc(node.id)}.&lt;port&gt;}}</code></div>
            </div>
            ${def.description ? `<p class="ge-inspector-desc">${esc(def.description)}</p>` : ''}

            ${renderInputStatusSection(node, def, wireInputs, wiredInputs, inputsNeedingHelp)}

            ${configPorts.length === 0
                ? ''
                : `<div class="ge-inspector-section-h">Configuration</div>
                   <div class="ge-inspector-fields">
                        ${configPorts.map((p) => renderField(node, p)).join('')}
                   </div>`}

            <div class="ge-inspector-section-h">Advanced</div>
            <div class="form-group">
                <label class="form-label">Condition (skip if falsy)</label>
                <input class="form-input" value="${esc(node.condition || '')}"
                    placeholder="e.g. {{nodes.review.mergeReady}}"
                    onchange="ge.workflow.graph.nodes.find(n=>n.id==='${jsEsc(node.id)}').condition = this.value || undefined; updateYamlPanel()">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">On error</label>
                    <select class="form-select"
                        onchange="ge.workflow.graph.nodes.find(n=>n.id==='${jsEsc(node.id)}').on_error = this.value === 'stop' ? undefined : this.value; updateYamlPanel()">
                        <option value="stop" ${(node.on_error || 'stop') === 'stop' ? 'selected' : ''}>Stop workflow</option>
                        <option value="continue" ${node.on_error === 'continue' ? 'selected' : ''}>Continue</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Timeout (s)</label>
                    <input class="form-input" type="number" min="0" value="${esc(node.timeout || '')}"
                        onchange="ge.workflow.graph.nodes.find(n=>n.id==='${jsEsc(node.id)}').timeout = this.value ? Number(this.value) : undefined; updateYamlPanel()">
                </div>
            </div>

            <div class="ge-inspector-section-h">Outputs (wire from these)</div>
            <ul class="ge-port-list">
                ${wireOutputPorts(def, node).map((p) => `
                    <li><code>{{nodes.${esc(node.id)}.${esc(p.name)}}}</code>
                        <span>${esc(p.label)} <small>(${esc(p.type || 'any')})</small></span></li>
                `).join('') || '<li>No outputs</li>'}
            </ul>
        </div>
    `;
}

/**
 * The inspector's "Inputs" panel: explicitly enumerates every wire-able
 * input, shows whether it's connected, and — for missing required ones —
 * suggests where the value typically comes from with a one-click "add it"
 * button. This is the answer to "if I want a PR review, how do I know
 * where to get the diff/PR number from?"
 */
function renderInputStatusSection(node, def, wireInputs, wiredInputs, missing) {
    if (wireInputs.length === 0) return '';
    const total = wireInputs.length;
    const ok = total - missing.length;
    return `<div class="ge-inspector-section-h">
        Inputs (${ok}/${total} connected)${missing.length ? ` <span style="color:var(--danger)">· ${missing.length} required missing</span>` : ''}
    </div>
    <div class="ge-input-status-list">
        ${wireInputs.map((p) => renderInputStatusRow(node, def, p)).join('')}
    </div>`;
}

function renderInputStatusRow(node, def, port) {
    const wireEdge = ge.workflow.graph.edges.find((e) => e.to.node === node.id && e.to.port === port.name);
    const hasConfig = node.config && node.config[port.name] !== undefined && node.config[port.name] !== '';
    const status = inputStatus(node, port, 'input');
    if (wireEdge) {
        const fromLabel = `${wireEdge.from.node}.${wireEdge.from.port}`;
        return `<div class="ge-input-row ge-input-ok">
            <div class="ge-input-meta">
                <strong>${esc(port.label)}</strong>
                <span class="ge-input-type">${esc(port.type || 'any')}</span>
                ${port.required ? '<span class="ge-input-req">required</span>' : ''}
            </div>
            <div class="ge-input-source">
                🔌 wired from <code>${esc(fromLabel)}</code>
                <button class="btn btn-ghost btn-sm" onclick="disconnectInput('${jsEsc(node.id)}','${jsEsc(port.name)}')">disconnect</button>
            </div>
        </div>`;
    }
    if (hasConfig) {
        return `<div class="ge-input-row ge-input-ok">
            <div class="ge-input-meta">
                <strong>${esc(port.label)}</strong>
                <span class="ge-input-type">${esc(port.type || 'any')}</span>
                ${port.required ? '<span class="ge-input-req">required</span>' : ''}
            </div>
            <div class="ge-input-source">📝 set in config below</div>
        </div>`;
    }

    const suggestions = suggestProvidersFor(port);
    return `<div class="ge-input-row ge-input-${status}">
        <div class="ge-input-meta">
            <strong>${esc(port.label)}</strong>
            <span class="ge-input-type">${esc(port.type || 'any')}</span>
            ${port.required ? '<span class="ge-input-req">required</span>' : ''}
        </div>
        ${port.helpText ? `<div class="ge-input-help">${esc(port.helpText)}</div>` : ''}
        <div class="ge-input-source ${status === 'missing' ? 'ge-input-source-warn' : ''}">
            ${status === 'missing' ? '❌ Not connected' : '○ Optional — leave empty or wire it'}
        </div>
        ${suggestions.existing.length > 0 ? `<div class="ge-input-suggest">
            <div class="ge-input-suggest-h">Wire from existing node</div>
            ${suggestions.existing.map((s) => `
                <button class="ge-suggest-btn" onclick="wireFromExisting('${jsEsc(node.id)}','${jsEsc(port.name)}','${jsEsc(s.fromNode)}','${jsEsc(s.fromPort)}')">
                    🔗 <code>${esc(s.fromNode)}.${esc(s.fromPort)}</code>
                    <small>${esc(s.label)}</small>
                </button>
            `).join('')}
        </div>` : ''}
        ${suggestions.add.length > 0 ? `<div class="ge-input-suggest">
            <div class="ge-input-suggest-h">Or add a node that provides this</div>
            ${suggestions.add.map((s) => `
                <button class="ge-suggest-btn" onclick="addAndWire('${jsEsc(node.id)}','${jsEsc(port.name)}','${jsEsc(s.type)}','${jsEsc(s.outputPort)}')">
                    ➕ ${esc(s.icon)} ${esc(s.title)}
                    <small>${esc(s.reason)}</small>
                </button>
            `).join('')}
        </div>` : ''}
        ${(port.config !== false) ? `<div class="ge-input-suggest">
            <div class="ge-input-suggest-h">Or fill in below in Configuration</div>
        </div>` : ''}
    </div>`;
}

/**
 * Suggest where this input can come from — both nodes already in the
 * graph (existing wires) and nodes that can be added (whose outputs match
 * this port's type). Type compatibility uses the same rule as wiring.
 */
function suggestProvidersFor(targetPort) {
    const targetType = targetPort.type || 'any';
    const targetNode = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    const existing = [];
    for (const candidate of ge.workflow.graph.nodes) {
        // Don't suggest the node wire itself as a source for its own input.
        if (candidate.id === ge.selectedNodeId) continue;
        const cdef = ge.nodeDefsByType[candidate.type];
        if (!cdef) continue;
        for (const p of wireOutputPorts(cdef, candidate)) {
            if (!portsCompatible(p.type, targetType)) continue;
            // Prefer matches where the port name aligns with the target port.
            const score = scoreMatch(p, targetPort);
            existing.push({ score, fromNode: candidate.id, fromPort: p.name, label: p.label });
        }
    }
    existing.sort((a, b) => b.score - a.score);

    const add = [];
    for (const cdef of ge.nodeDefsList) {
        if (cdef.category === 'trigger') continue;
        // Don't suggest adding another instance of the same node type as
        // the one we're currently editing — that's almost never useful and
        // produces noise like "AI Code Review needs a Diff → add AI Code Review".
        if (targetNode && cdef.type === targetNode.type) continue;
        // Only consider nodes that produce a directly-compatible output.
        const matches = (cdef.ports || [])
            .filter((p) => p.role === 'output' && p.wire !== false && portsCompatible(p.type, targetType))
            .map((p) => ({ port: p, score: scoreMatch(p, targetPort) }))
            .sort((a, b) => b.score - a.score);
        if (matches.length === 0) continue;
        const top = matches[0];
        if (top.score < 1) continue; // too weak
        add.push({
            type: cdef.type,
            outputPort: top.port.name,
            title: cdef.title,
            icon: cdef.icon,
            reason: `produces ${top.port.label} (${top.port.type || 'any'})`,
            score: top.score,
        });
    }
    add.sort((a, b) => b.score - a.score);

    return { existing: existing.slice(0, 5), add: add.slice(0, 4) };
}

function scoreMatch(srcPort, dstPort) {
    let score = 0;
    if (srcPort.type && dstPort.type && srcPort.type === dstPort.type) score += 3;
    else if (srcPort.type === 'any' || dstPort.type === 'any') score += 1;
    else if (portsCompatible(srcPort.type, dstPort.type)) score += 1;
    if (srcPort.name === dstPort.name) score += 4;
    else if (srcPort.name.toLowerCase().includes(dstPort.name.toLowerCase())
          || dstPort.name.toLowerCase().includes(srcPort.name.toLowerCase())) score += 1;
    return score;
}

window.wireFromExisting = function (toNode, toPort, fromNode, fromPort) {
    ge.workflow.graph.edges = ge.workflow.graph.edges.filter((e) =>
        !(e.to.node === toNode && e.to.port === toPort),
    );
    ge.workflow.graph.edges.push({
        id: `e${Date.now().toString(36)}`,
        from: { node: fromNode, port: fromPort },
        to: { node: toNode, port: toPort },
    });
    renderCanvas();
    renderInspector();
    updateYamlPanel();
    toast(`Wired ${fromNode}.${fromPort} → ${toNode}.${toPort}`);
};

window.addAndWire = function (toNode, toPort, newNodeType, newNodeOutputPort) {
    const def = ge.nodeDefsByType[newNodeType];
    if (!def) return;
    const target = ge.workflow.graph.nodes.find((n) => n.id === toNode);
    if (!target) return;
    const newId = uniqueNodeId(suggestId(def));
    const pos = target.position
        ? { x: Math.max(20, target.position.x - 320), y: target.position.y }
        : { x: 80, y: 80 };
    ge.workflow.graph.nodes.push({
        id: newId, type: newNodeType, position: pos, config: defaultConfigFor(def),
    });
    ge.workflow.graph.edges.push({
        id: `e${Date.now().toString(36)}`,
        from: { node: newId, port: newNodeOutputPort },
        to: { node: toNode, port: toPort },
    });
    renderCanvas();
    renderInspector();
    updateYamlPanel();
    toast(`Added ${def.title}, wired ${newId}.${newNodeOutputPort} → ${toNode}.${toPort}`);
};

window.disconnectInput = function (nodeId, portName) {
    ge.workflow.graph.edges = ge.workflow.graph.edges.filter((e) =>
        !(e.to.node === nodeId && e.to.port === portName),
    );
    renderCanvas();
    renderInspector();
    updateYamlPanel();
};

function renderField(node, port) {
    const value = node.config?.[port.name];
    const setExpr = `setNodeField('${jsEsc(node.id)}', '${jsEsc(port.name)}', __VAL__)`;
    const onInput = (jsExpr) => setExpr.replace('__VAL__', jsExpr);
    const help = port.helpText ? `<div class="form-hint">${esc(port.helpText)}</div>` : '';
    const required = port.required ? ' <span style="color:var(--danger)">*</span>' : '';
    const labelHtml = `<label class="form-label">${esc(port.label)}${required}</label>`;

    switch (port.control) {
        case 'textarea':
        case 'code-md':
        case 'code-yaml':
            return `<div class="form-group">${labelHtml}
                <textarea class="form-textarea ge-${port.control}" rows="4"
                    placeholder="${esc(port.placeholder || '')}"
                    oninput="${onInput('this.value')}">${esc(value ?? '')}</textarea>
                ${help}
            </div>`;
        case 'select':
            return `<div class="form-group">${labelHtml}
                <select class="form-select" onchange="${onInput('this.value')}">
                    ${(port.options || []).map((o) =>
                        `<option value="${esc(o.value)}" ${value === o.value ? 'selected' : ''}>${esc(o.label)}</option>`,
                    ).join('')}
                </select>${help}
            </div>`;
        case 'switch':
            return `<div class="form-group">
                <label class="ge-switch">
                    <input type="checkbox" ${value ? 'checked' : ''}
                        onchange="${onInput('this.checked')}">
                    <span>${esc(port.label)}${required}</span>
                </label>${help}
            </div>`;
        case 'number':
            return `<div class="form-group">${labelHtml}
                <input class="form-input" type="number" value="${esc(value ?? '')}"
                    placeholder="${esc(port.placeholder || '')}"
                    oninput="${onInput('this.value === \"\" ? undefined : Number(this.value)')}">${help}
            </div>`;
        case 'multiselect':
            return renderMultiselectField(node, port);
        case 'kv':
            return renderKvField(node, port);
        case 'github-pr':
        case 'github-issue':
        case 'github-repo':
            // For now, treat the github-* pickers as text inputs in the
            // inspector. The full pickers live on the run-form modal.
            return `<div class="form-group">${labelHtml}
                <input class="form-input" value="${esc(value ?? '')}"
                    placeholder="${esc(port.placeholder || (port.control === 'github-repo' ? 'org/repo' : 'leave blank to take from event'))}"
                    oninput="${onInput('this.value')}">${help}
            </div>`;
        default:
            return `<div class="form-group">${labelHtml}
                <input class="form-input" value="${esc(value ?? '')}"
                    placeholder="${esc(port.placeholder || '')}"
                    oninput="${onInput('this.value')}">${help}
            </div>`;
    }
}

function renderMultiselectField(node, port) {
    const value = ensureArr(node.config?.[port.name]);
    // For events-style multi-select, source the catalog from the trigger node's
    // `events` port: pull from app.js's eventCatalog by source.
    let options = [];
    if (port.name === 'events' && node.type.startsWith('trigger.')) {
        const source = node.type.replace('trigger.', '');
        options = (eventCatalog[source] || []).map((e) => ({ value: e.value, label: e.label }));
    } else if (port.options) {
        options = port.options;
    }
    const id = `ms-${node.id}-${port.name}`;
    return `<div class="form-group">
        <label class="form-label">${esc(port.label)}${port.required ? ' <span style="color:var(--danger)">*</span>' : ''}</label>
        <div class="ge-multiselect" id="${esc(id)}">
            ${options.map((o) => {
                const checked = value.includes(o.value);
                return `<label class="ge-chip ${checked ? 'checked' : ''}">
                    <input type="checkbox" ${checked ? 'checked' : ''}
                        onchange="toggleMultiselect('${jsEsc(node.id)}', '${jsEsc(port.name)}', '${jsEsc(o.value)}', this.checked)">
                    <span>${esc(o.label)}</span>
                </label>`;
            }).join('') || '<div class="form-hint">No predefined options — type values manually below.</div>'}
            <input class="form-input ge-multiselect-extra" placeholder="Type a custom value and press Enter"
                onkeydown="if(event.key==='Enter'){event.preventDefault();addMultiselectCustom('${jsEsc(node.id)}','${jsEsc(port.name)}',this.value);this.value='';}">
            <div class="ge-multiselect-tags">
                ${value.filter((v) => !options.some((o) => o.value === v)).map((v) => `
                    <span class="tag-pill">${esc(v)} <button onclick="toggleMultiselect('${jsEsc(node.id)}','${jsEsc(port.name)}','${jsEsc(v)}', false)">×</button></span>
                `).join('')}
            </div>
        </div>
        ${port.helpText ? `<div class="form-hint">${esc(port.helpText)}</div>` : ''}
    </div>`;
}

window.toggleMultiselect = function (nodeId, port, value, checked) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const arr = ensureArr(node.config?.[port]);
    const next = checked ? [...new Set([...arr, value])] : arr.filter((v) => v !== value);
    node.config = { ...node.config, [port]: next };
    renderInspector();
    renderCanvas(); // Trigger node ports change with selected events.
    updateYamlPanel();
};

window.addMultiselectCustom = function (nodeId, port, value) {
    const v = String(value || '').trim();
    if (!v) return;
    window.toggleMultiselect(nodeId, port, v, true);
};

function renderKvField(node, port) {
    // Render either:
    //   - Headers / generic key-value (port.name === 'headers')
    //   - Manual-trigger inputs spec (port.name === 'inputs') — array of
    //     { name, label, type, required } for the run form.
    if (port.name === 'inputs' && node.type === 'trigger.manual') {
        return renderManualInputsField(node, port);
    }
    const map = (node.config?.[port.name] || {});
    const entries = Object.entries(map);
    return `<div class="form-group">
        <label class="form-label">${esc(port.label)}</label>
        <div class="ge-kv-rows">
            ${entries.map(([k, v], i) => `
                <div class="ge-kv-row">
                    <input class="form-input" value="${esc(k)}" placeholder="key"
                        onchange="updateKvKey('${jsEsc(node.id)}','${jsEsc(port.name)}',${i},this.value)">
                    <input class="form-input" value="${esc(v)}" placeholder="value"
                        oninput="updateKvVal('${jsEsc(node.id)}','${jsEsc(port.name)}','${jsEsc(k)}',this.value)">
                    <button class="btn btn-danger-outline btn-sm" onclick="removeKv('${jsEsc(node.id)}','${jsEsc(port.name)}','${jsEsc(k)}')">×</button>
                </div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="addKv('${jsEsc(node.id)}','${jsEsc(port.name)}')">+ Add row</button>
        ${port.helpText ? `<div class="form-hint">${esc(port.helpText)}</div>` : ''}
    </div>`;
}

window.addKv = function (nodeId, port) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    node.config = { ...node.config, [port]: { ...(node.config?.[port] || {}), '': '' } };
    renderInspector();
    updateYamlPanel();
};
window.updateKvKey = function (nodeId, port, idx, newKey) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    const obj = { ...(node.config?.[port] || {}) };
    const entries = Object.entries(obj);
    if (!entries[idx]) return;
    const [oldKey, val] = entries[idx];
    delete obj[oldKey];
    obj[newKey] = val;
    node.config = { ...node.config, [port]: obj };
    updateYamlPanel();
};
window.updateKvVal = function (nodeId, port, key, val) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    const obj = { ...(node.config?.[port] || {}) };
    obj[key] = val;
    node.config = { ...node.config, [port]: obj };
    updateYamlPanel();
};
window.removeKv = function (nodeId, port, key) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    const obj = { ...(node.config?.[port] || {}) };
    delete obj[key];
    node.config = { ...node.config, [port]: obj };
    renderInspector();
    updateYamlPanel();
};

function renderManualInputsField(node, port) {
    const inputs = (node.config?.inputs || []);
    return `<div class="form-group">
        <label class="form-label">${esc(port.label)}</label>
        <div class="form-hint">Each row becomes a field on the run form. Reference values in steps via <code>{{inputs.&lt;name&gt;}}</code>.</div>
        ${inputs.map((inp, i) => `
            <div class="ge-manual-input-row">
                <input class="form-input" value="${esc(inp.name || '')}" placeholder="field_name"
                    onchange="updateManualInput(${i}, 'name', this.value)">
                <input class="form-input" value="${esc(inp.label || '')}" placeholder="Field label"
                    onchange="updateManualInput(${i}, 'label', this.value)">
                <select class="form-select" onchange="updateManualInput(${i}, 'type', this.value)">
                    ${['text','textarea','select','number','boolean','github-pr','github-issue','github-branch','github-repo']
                        .map((t) => `<option value="${t}" ${inp.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px">
                    <input type="checkbox" ${inp.required ? 'checked' : ''}
                        onchange="updateManualInput(${i}, 'required', this.checked)">required
                </label>
                <button class="btn btn-danger-outline btn-sm" onclick="removeManualInput(${i})">×</button>
            </div>
        `).join('')}
        <button class="btn btn-ghost btn-sm" onclick="addManualInput()">+ Add input</button>
    </div>`;
}

window.addManualInput = function () {
    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) return;
    const inputs = [...(node.config?.inputs || []), { name: '', label: '', type: 'text', required: false }];
    node.config = { ...node.config, inputs };
    renderInspector();
    renderCanvas(); // Each input becomes an output port on the trigger node.
    updateYamlPanel();
};
window.updateManualInput = function (i, field, val) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) return;
    const inputs = [...(node.config?.inputs || [])];
    if (!inputs[i]) return;
    inputs[i] = { ...inputs[i], [field]: val };
    node.config = { ...node.config, inputs };
    renderCanvas(); // Renaming/retyping an input changes its derived output port.
    updateYamlPanel();
};
window.removeManualInput = function (i) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) return;
    const removed = (node.config?.inputs || [])[i];
    const inputs = (node.config?.inputs || []).filter((_, j) => j !== i);
    node.config = { ...node.config, inputs };
    // Drop any wires that referenced the removed input's derived output port.
    if (removed?.name) {
        ge.workflow.graph.edges = ge.workflow.graph.edges.filter((e) =>
            !(e.from.node === node.id && e.from.port === removed.name),
        );
    }
    renderInspector();
    renderCanvas();
    updateYamlPanel();
};

window.setNodeField = function (nodeId, port, value) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const newConfig = { ...(node.config || {}) };
    if (value === '' || value === undefined || value === null) {
        delete newConfig[port];
    } else {
        newConfig[port] = value;
    }
    node.config = newConfig;
    // Trigger nodes' output ports depend on config (events / inputs) —
    // re-render the canvas so the node card reflects the new port set.
    renderCanvas();
    updateYamlPanel();
};

// ─── Selection / mutation ───────────────────────────────────────────────────

window.selectNode = function (id) {
    ge.selectedNodeId = id;
    ge.selectedEdgeId = null;
    ge.wiringFrom = null;
    renderCanvas();
    renderInspector();
    updateCanvasHint();
};

window.selectEdge = function (id) {
    ge.selectedEdgeId = id;
    ge.selectedNodeId = null;
    drawEdges();
    renderInspector();
    updateCanvasHint();
};

window.deleteNode = function (id) {
    ge.workflow.graph.nodes = ge.workflow.graph.nodes.filter((n) => n.id !== id);
    ge.workflow.graph.edges = ge.workflow.graph.edges.filter((e) => e.from.node !== id && e.to.node !== id);
    if (ge.selectedNodeId === id) ge.selectedNodeId = null;
    renderCanvas();
    renderInspector();
    updateYamlPanel();
};

window.renameNode = function (oldId, newIdRaw) {
    const newId = String(newIdRaw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!newId || newId === oldId) return;
    if (ge.workflow.graph.nodes.some((n) => n.id === newId)) {
        toast(`Id "${newId}" is already in use`, 'error');
        renderInspector();
        return;
    }
    const node = ge.workflow.graph.nodes.find((n) => n.id === oldId);
    if (!node) return;
    node.id = newId;
    for (const e of ge.workflow.graph.edges) {
        if (e.from.node === oldId) e.from.node = newId;
        if (e.to.node === oldId) e.to.node = newId;
    }
    ge.selectedNodeId = newId;
    renderCanvas();
    renderInspector();
    updateYamlPanel();
};

window.addNodeOfType = function (type, position) {
    const def = ge.nodeDefsByType[type];
    if (!def) return;
    const id = uniqueNodeId(suggestId(def));
    const wrap = $('#ge-canvas-wrap');
    const wr = wrap?.getBoundingClientRect();
    const center = position || (wr ? screenToCanvas(wr.left + wr.width / 2 - 80, wr.top + wr.height / 2 - 40) : { x: 200, y: 200 });
    ge.workflow.graph.nodes.push({
        id, type, position: center, config: defaultConfigFor(def),
    });
    ge.selectedNodeId = id;
    renderCanvas();
    renderInspector();
    updateYamlPanel();
};

function defaultConfigFor(def) {
    const cfg = {};
    for (const p of def.ports) {
        if (p.role === 'input' && p.config && p.default !== undefined) {
            cfg[p.name] = p.default;
        }
    }
    if (def.type === 'trigger.manual') cfg.inputs = cfg.inputs || [];
    return cfg;
}

function suggestId(def) {
    return def.type.split('.').pop().replace(/[^a-z0-9]+/gi, '_');
}

function uniqueNodeId(base) {
    let id = base;
    let i = 2;
    while (ge.workflow.graph.nodes.some((n) => n.id === id)) {
        id = `${base}_${i++}`;
    }
    return id;
}

// ─── Pointer interactions ─────────────────────────────────────────────────

// Module-level registry of the document-scoped listeners we install when
// the editor opens. The DOM spec dedupes addEventListener calls with the
// same (type, callback, capture) triple, so re-binding the editor's
// stable named handlers is already idempotent — but explicit teardown on
// close means the listeners aren't sitting attached to the document
// while the user is on a different page, and a future refactor that
// switches to closure-based handlers won't silently start leaking.
let _canvasListenersBound = false;

function bindCanvasInteractions() {
    const wrap = $('#ge-canvas-wrap');
    if (!wrap) return;

    wrap.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = -Math.sign(e.deltaY) * 0.1;
            zoomTo(Math.max(0.3, Math.min(2.5, ge.viewport.scale + delta)));
        } else {
            ge.viewport.x -= e.deltaX;
            ge.viewport.y -= e.deltaY;
            applyViewportTransform();
            drawEdges();
        }
    }, { passive: false });

    wrap.addEventListener('mousedown', (e) => {
        if (e.target === wrap || e.target.classList.contains('ge-canvas')) {
            ge.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, baseX: ge.viewport.x, baseY: ge.viewport.y };
            // clear selection if user clicks empty space
            ge.selectedNodeId = null;
            ge.selectedEdgeId = null;
            ge.wiringFrom = null;
            renderInspector();
            drawEdges();
            updateCanvasHint();
        }
    });

    wrap.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-sokuza-node')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    wrap.addEventListener('drop', (e) => {
        const type = e.dataTransfer.getData('application/x-sokuza-node');
        if (!type) return;
        e.preventDefault();
        const wr = wrap.getBoundingClientRect();
        const pos = screenToCanvas(e.clientX - 80, e.clientY - 40);
        addNodeOfType(type, pos);
    });

    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
    _canvasListenersBound = true;
}

function unbindCanvasInteractions() {
    if (!_canvasListenersBound) return;
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onDocKeyDown);
    _canvasListenersBound = false;
}

function screenToCanvas(sx, sy) {
    const wrap = $('#ge-canvas-wrap');
    if (!wrap) return { x: 0, y: 0 };
    const wr = wrap.getBoundingClientRect();
    const v = ge.viewport;
    return { x: (sx - wr.left - v.x) / v.scale, y: (sy - wr.top - v.y) / v.scale };
}

window.onNodeMouseDown = function (e, nodeId) {
    if (e.target.closest('.ge-port') || e.target.closest('button') || e.target.closest('input')) return;
    e.stopPropagation();
    selectNode(nodeId);
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    ge.drag = {
        kind: 'node',
        nodeId,
        startX: e.clientX, startY: e.clientY,
        baseX: node.position?.x ?? 0,
        baseY: node.position?.y ?? 0,
    };
};

window.onPortClick = function (e, nodeId, port, side) {
    e.stopPropagation();
    const node = ge.workflow.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const def = ge.nodeDefsByType[node.type];

    if (side === 'output') {
        // Begin wiring from this output. Re-render so input ports can show
        // their compat highlight against the source type.
        const portMeta = def && wireOutputPorts(def, node).find((p) => p.name === port);
        ge.wiringFrom = { nodeId, port, type: portMeta?.type || 'any', cursor: null };
        renderCanvas();
        updateCanvasHint();
        return;
    }

    // side === 'input' — complete the wire if one is in progress.
    if (!ge.wiringFrom) {
        toast('Click an output port (right side of a node) first to start a wire', 'error');
        return;
    }
    if (ge.wiringFrom.nodeId === nodeId) {
        toast('Cannot wire a node to itself', 'error');
        cancelWiring();
        return;
    }

    const targetPort = def && wireInputPorts(def).find((p) => p.name === port);
    if (!portsCompatible(ge.wiringFrom.type, targetPort?.type)) {
        toast(`Type mismatch: ${ge.wiringFrom.type || 'any'} → ${targetPort?.type || 'any'}`, 'error');
        return;
    }

    // Replace any existing wire into this input — most actions only want
    // one source per port, and an accidental fan-in is more confusing than
    // an automatic replacement.
    ge.workflow.graph.edges = ge.workflow.graph.edges.filter((edge) =>
        !(edge.to.node === nodeId && edge.to.port === port),
    );
    ge.workflow.graph.edges.push({
        id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        from: { node: ge.wiringFrom.nodeId, port: ge.wiringFrom.port },
        to: { node: nodeId, port },
    });
    cancelWiring();
    renderCanvas();
    renderInspector();
    updateYamlPanel();
};

function cancelWiring() {
    ge.wiringFrom = null;
    updateCanvasHint();
    renderCanvas();
}

function onDocMouseMove(e) {
    const drag = ge.drag;
    if (drag) {
        if (drag.kind === 'pan') {
            ge.viewport.x = drag.baseX + (e.clientX - drag.startX);
            ge.viewport.y = drag.baseY + (e.clientY - drag.startY);
            applyViewportTransform();
            drawEdges();
        } else if (drag.kind === 'node') {
            const node = ge.workflow.graph.nodes.find((n) => n.id === drag.nodeId);
            if (!node) return;
            const dx = (e.clientX - drag.startX) / ge.viewport.scale;
            const dy = (e.clientY - drag.startY) / ge.viewport.scale;
            node.position = { x: drag.baseX + dx, y: drag.baseY + dy };
            const card = document.querySelector(`.ge-node[data-id="${cssEsc(drag.nodeId)}"]`);
            if (card) {
                card.style.left = node.position.x + 'px';
                card.style.top = node.position.y + 'px';
            }
            drawEdges();
        }
    }
    if (ge.wiringFrom) {
        const wrap = $('#ge-canvas-wrap');
        if (!wrap) return;
        const wr = wrap.getBoundingClientRect();
        ge.wiringFrom.cursor = { x: e.clientX - wr.left, y: e.clientY - wr.top };
        drawEdges();
    }
}

function onDocMouseUp() {
    if (ge.drag?.kind === 'node') {
        updateYamlPanel();
    }
    ge.drag = null;
}

function onDocKeyDown(e) {
    if (currentPage !== 'workflow-editor') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === 'Escape') {
        ge.wiringFrom = null;
        ge.selectedNodeId = null;
        ge.selectedEdgeId = null;
        renderCanvas();
        renderInspector();
        updateCanvasHint();
        return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (ge.selectedNodeId) {
            e.preventDefault();
            deleteNode(ge.selectedNodeId);
        } else if (ge.selectedEdgeId) {
            e.preventDefault();
            ge.workflow.graph.edges = ge.workflow.graph.edges.filter((edge) => edge.id !== ge.selectedEdgeId);
            ge.selectedEdgeId = null;
            drawEdges();
            updateYamlPanel();
        }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveGraphWorkflow();
    }
}

function updateCanvasHint() {
    const el = $('#ge-canvas-hint');
    if (!el) return;
    if (ge.wiringFrom) {
        el.innerHTML = `🔌 Wiring from <code>${esc(ge.wiringFrom.nodeId)}.${esc(ge.wiringFrom.port)}</code> — click an input port to connect, or Esc to cancel`;
        el.style.display = 'block';
    } else if (ge.workflow.graph.nodes.length === 1 && ge.workflow.graph.edges.length === 0) {
        el.innerHTML = `🎯 Drag nodes from the palette on the left, then wire them together`;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}

// ─── Zoom / fit / auto-layout ──────────────────────────────────────────────

window.zoomTo = function (scale) {
    ge.viewport.scale = scale;
    applyViewportTransform();
    drawEdges();
};

window.zoomFit = function () {
    const nodes = ge.workflow.graph.nodes;
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.position?.x ?? 0);
    const ys = nodes.map((n) => n.position?.y ?? 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + 240;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + 200;
    const wrap = $('#ge-canvas-wrap');
    const wr = wrap.getBoundingClientRect();
    const sx = (wr.width - 80) / Math.max(1, maxX - minX);
    const sy = (wr.height - 80) / Math.max(1, maxY - minY);
    const scale = Math.max(0.4, Math.min(1.5, Math.min(sx, sy)));
    ge.viewport.scale = scale;
    ge.viewport.x = 40 - minX * scale;
    ge.viewport.y = 40 - minY * scale;
    applyViewportTransform();
    drawEdges();
};

window.autoLayoutGraph = function () {
    // Simple longest-path layered layout.
    const nodes = ge.workflow.graph.nodes;
    const edges = ge.workflow.graph.edges;
    const depth = new Map(nodes.map((n) => [n.id, 0]));

    let changed = true;
    let safety = nodes.length + 1;
    while (changed && safety-- > 0) {
        changed = false;
        for (const e of edges) {
            const next = (depth.get(e.from.node) ?? 0) + 1;
            if (next > (depth.get(e.to.node) ?? 0)) {
                depth.set(e.to.node, next);
                changed = true;
            }
        }
    }
    const cols = {};
    for (const n of nodes) {
        const d = depth.get(n.id) ?? 0;
        if (!cols[d]) cols[d] = [];
        cols[d].push(n);
    }
    const COL_W = 320;
    const ROW_H = 180;
    const ORIGIN_X = 60, ORIGIN_Y = 80;
    for (const [d, list] of Object.entries(cols)) {
        list.forEach((n, i) => {
            n.position = { x: ORIGIN_X + Number(d) * COL_W, y: ORIGIN_Y + i * ROW_H };
        });
    }
    renderCanvas();
    updateYamlPanel();
};

// ─── Save / YAML preview ───────────────────────────────────────────────────

window.saveGraphWorkflow = async function () {
    const wf = ge.workflow;
    if (!wf.name || !/^[a-zA-Z0-9_-]+$/.test(wf.name)) {
        toast('Name is required (letters, digits, _ and - only)', 'error');
        return;
    }
    if (wf.graph.nodes.length === 0) {
        toast('Workflow needs at least one node', 'error');
        return;
    }
    const trigger = wf.graph.nodes.find((n) => n.type.startsWith('trigger.'));
    if (!trigger) {
        toast('Workflow needs a trigger node', 'error');
        return;
    }

    const payload = serializeWorkflow(wf);

    try {
        if (ge.isNew) {
            // If we were staged from a library card, mark the saved workflow
            // with the library item id so the catalog badge flips to
            // "Installed" and Uninstall can find it later.
            if (ge.libraryItemId) payload._libraryItem = ge.libraryItemId;
            await api.post('/api/workflows', payload);
            toast(`Created "${wf.name}"`);
            ge.isNew = false;
            ge.originalName = wf.name;
            // Push the recipe id into the dashboard's deck so the library
            // page's "✓ Installed" badge flips on first save. app.js
            // exposes notifyLibraryItemInstalled on window for this.
            if (ge.libraryItemId && typeof window.notifyLibraryItemInstalled === 'function') {
                try { await window.notifyLibraryItemInstalled(ge.libraryItemId); }
                catch { /* best-effort */ }
            }
            ge.libraryItemId = null;
        } else {
            await api.put(`/api/workflows/${encodeURIComponent(ge.originalName)}`, payload);
            toast(`Saved "${wf.name}"`);
        }
    } catch (err) {
        toast(`Save failed: ${err.message}`, 'error');
    }
};

function serializeWorkflow(wf) {
    // Persist both: the graph (primary), plus a derived legacy `trigger:`
    // block so older code paths and external tooling can still read it.
    const trigger = wf.graph.nodes.find((n) => n.type.startsWith('trigger.'));
    const triggerYaml = triggerNodeToLegacy(trigger);
    const inputs = trigger?.type === 'trigger.manual' ? (trigger.config?.inputs || []) : undefined;

    const cleaned = {
        name: wf.name,
        ...(wf.description ? { description: wf.description } : {}),
        ...(wf.enabled === false ? { enabled: false } : {}),
        trigger: triggerYaml,
        ...(inputs && inputs.length ? { inputs } : {}),
        graph: {
            nodes: wf.graph.nodes.map((n) => ({
                id: n.id,
                type: n.type,
                position: n.position,
                ...(n.config && Object.keys(n.config).length ? { config: n.config } : {}),
                ...(n.condition ? { condition: n.condition } : {}),
                ...(n.on_error ? { on_error: n.on_error } : {}),
                ...(n.timeout ? { timeout: n.timeout } : {}),
            })),
            edges: wf.graph.edges.map((e) => ({
                ...(e.id ? { id: e.id } : {}),
                from: e.from,
                to: e.to,
            })),
        },
    };
    return cleaned;
}

function triggerNodeToLegacy(node) {
    if (!node) return { source: 'manual', event: [] };
    const source = node.type.replace('trigger.', '');
    const cfg = node.config || {};
    const trigger = { source, event: ensureArr(cfg.events) };
    const repos = String(cfg.repos || '').split(',').map((s) => s.trim()).filter(Boolean);
    const branches = String(cfg.branches || '').split(',').map((s) => s.trim()).filter(Boolean);
    const authors = String(cfg.authors || '').split(',').map((s) => s.trim()).filter(Boolean);
    const labels = String(cfg.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (repos.length) trigger.repo = repos.length === 1 ? repos[0] : repos;
    if (branches.length) trigger.branch = branches.length === 1 ? branches[0] : branches;
    if (authors.length) trigger.author = authors.length === 1 ? authors[0] : authors;
    if (labels.length) trigger.labels = labels;
    if (source === 'cron' && cfg.schedule) trigger.event = [cfg.schedule];
    return trigger;
}

window.toggleYamlPanel = function () {
    const p = $('#ge-yaml-panel');
    if (!p) return;
    const open = p.style.display !== 'none';
    p.style.display = open ? 'none' : 'flex';
    if (!open) updateYamlPanel();
};

function updateYamlPanel() {
    const p = $('#ge-yaml-panel');
    if (!p || p.style.display === 'none') return;
    const pre = $('#ge-yaml-pre');
    if (!pre) return;
    const payload = serializeWorkflow(ge.workflow);
    pre.textContent = pseudoYaml(payload);
}

// Tiny YAML-ish stringifier — good enough for the read-only preview pane.
function pseudoYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'string') {
        if (obj.includes('\n') || obj.length > 60) return `|\n${obj.split('\n').map((l) => pad + '  ' + l).join('\n')}`;
        // Backslashes must be doubled BEFORE quote-escaping — otherwise
        // an input like `hello\"` would emit `"hello\\""`, which YAML
        // parses as the (truncated) scalar "hello\" followed by garbage.
        // Order matters: double the slashes first, then escape quotes.
        const escaped = obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return /^[a-zA-Z0-9_./@:#-]*$/.test(obj) ? obj : `"${escaped}"`;
    }
    if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
    if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        return '\n' + obj.map((v) => pad + '- ' + pseudoYaml(v, indent + 1).replace(/^\n?/, '')).join('\n');
    }
    if (typeof obj === 'object') {
        const entries = Object.entries(obj);
        if (entries.length === 0) return '{}';
        return entries.map(([k, v]) => {
            const rendered = pseudoYaml(v, indent + 1);
            const inline = !rendered.startsWith('\n');
            return pad + k + ': ' + (inline ? rendered : rendered.replace(/^\n/, '\n'));
        }).join('\n');
    }
    return String(obj);
}

// ─── CSS-escape util (selectors for arbitrary node ids) ───────────────────
function cssEsc(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Expose a few helpers used inline by the inspector.
window.ensureArr = ensureArr;
window.renderInspector = renderInspector;
window.renderCanvas = renderCanvas;
window.renderPalette = renderPalette;
window.drawEdges = drawEdges;
window.updateYamlPanel = updateYamlPanel;
