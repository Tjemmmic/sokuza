// ─── Sokuza Visual Workflow Editor ──────────────────────────────────────────
//
// A node-graph editor for sokuza workflows: drag node types from the
// palette, drop them on the canvas, drag-wire output ports → input ports,
// configure each node in the inspector, hit Save. Backed by /api/nodes for
// the registry and /api/workflows for persistence. No bundler — vanilla
// JS, SVG for the wires, absolutely-positioned divs for node cards.
//
// Globals expected from app.js: $, $$, api, esc, toast, navigate, openModal,
// closeModal, eventCatalog, eventLabelMap.

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
window.openGraphEditor = async function (workflowName) {
    const isNew = !workflowName;
    ge.isNew = isNew;
    ge.originalName = isNew ? null : workflowName;
    ge.selectedNodeId = null;
    ge.selectedEdgeId = null;
    ge.viewport = { x: 0, y: 0, scale: 1 };
    ge.drag = null;
    ge.wiringFrom = null;

    try {
        const [defsRes, wfRes] = await Promise.all([
            api.get('/api/nodes'),
            isNew ? Promise.resolve(null) : api.get(`/api/workflows/${encodeURIComponent(workflowName)}/details`),
        ]);
        ge.nodeDefsList = defsRes.nodes || [];
        ge.nodeDefsByType = Object.fromEntries(ge.nodeDefsList.map((d) => [d.type, d]));

        if (isNew) {
            ge.workflow = blankWorkflow();
        } else {
            const wf = wfRes.workflow;
            ge.workflow = ensureGraphShape(wf);
        }

        renderEditor();
    } catch (err) {
        toast(`Failed to open editor: ${err.message}`, 'error');
    }
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
    'github-comment': 'github.comment',
    'github-clone-repo': 'github.clone-repo',
    'github-create-pr': 'github.create-pr',
    'github-create-review': 'github.create-review',
    'github-fetch-reviews': 'github.fetch-reviews',
    'github-add-label': 'github.add-label',
    'github-remove-label': 'github.remove-label',
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
                    <div class="ge-palette-group-h" onclick="togglePaletteGroup('${esc(g)}')">
                        <span>${esc(g)}</span>
                        <span class="ge-palette-group-count">${groups[g].length}</span>
                        <span class="ge-palette-group-caret">${collapsed ? '▶' : '▼'}</span>
                    </div>
                    ${collapsed ? '' : `<div class="ge-palette-group-body">
                        ${groups[g].map((d) => `
                            <div class="ge-palette-item" draggable="true"
                                title="${esc(d.description)}"
                                ondragstart="onPaletteDragStart(event, '${esc(d.type)}')"
                                onclick="addNodeOfType('${esc(d.type)}')"
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
            onmousedown="onNodeMouseDown(event, '${esc(node.id)}')"
            onclick="selectNode('${esc(node.id)}')">
            <div class="ge-node-header">⚠️ Unknown: ${esc(node.type)}</div>
            <div class="ge-node-body">Node type not registered. Delete or replace.</div>
        </div>`;
    }
    const inputs = def.ports.filter((p) => p.role === 'input' && p.wire);
    const outputs = def.ports.filter((p) => p.role === 'output' && p.wire);
    const selected = ge.selectedNodeId === node.id ? ' selected' : '';
    const color = def.color || 'var(--accent)';
    const x = node.position?.x ?? 0;
    const y = node.position?.y ?? 0;

    return `<div class="ge-node ge-node-${esc(def.category)}${selected}" data-id="${esc(node.id)}"
            style="left:${x}px;top:${y}px;--node-color:${esc(color)}"
            onmousedown="onNodeMouseDown(event, '${esc(node.id)}')"
            onclick="selectNode('${esc(node.id)}')">
        <div class="ge-node-header" title="${esc(def.description)}">
            <span class="ge-node-icon">${esc(def.icon)}</span>
            <span class="ge-node-title">${esc(def.title)}</span>
            <span class="ge-node-id">${esc(node.id)}</span>
        </div>
        <div class="ge-node-body">
            <div class="ge-ports ge-ports-in">
                ${inputs.map((p) => portHandle(node.id, p, 'input')).join('')}
            </div>
            <div class="ge-ports ge-ports-out">
                ${outputs.map((p) => portHandle(node.id, p, 'output')).join('')}
            </div>
        </div>
    </div>`;
}

function portHandle(nodeId, port, side) {
    const cls = side === 'input' ? 'ge-port ge-port-in' : 'ge-port ge-port-out';
    return `<div class="${cls}" data-node="${esc(nodeId)}" data-port="${esc(port.name)}"
        title="${esc(port.label)} (${esc(port.type || 'any')})${port.helpText ? ' — ' + esc(port.helpText) : ''}"
        onmousedown="event.stopPropagation()"
        onclick="onPortClick(event, '${esc(nodeId)}', '${esc(port.name)}', '${side}')">
        <span class="ge-port-dot"></span>
        <span class="ge-port-label">${esc(port.label)}</span>
    </div>`;
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
                onclick="selectEdge('${esc(id || '')}')"></path>
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
            <button class="btn btn-danger-outline btn-sm" onclick="deleteNode('${esc(node.id)}')">Delete node</button></div>`;
        return;
    }

    const configPorts = def.ports.filter((p) => p.role === 'input' && p.config);

    el.innerHTML = `
        <div class="ge-inspector-header" style="--node-color:${esc(def.color || 'var(--accent)')}">
            <span class="ge-inspector-icon">${esc(def.icon)}</span>
            <div class="ge-inspector-title">
                <div>${esc(def.title)}</div>
                <small>${esc(def.type)}</small>
            </div>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteNode('${esc(node.id)}')">Delete</button>
        </div>
        <div class="ge-inspector-body">
            <div class="form-group">
                <label class="form-label">Node Id</label>
                <input class="form-input" value="${esc(node.id)}"
                    onchange="renameNode('${esc(node.id)}', this.value)">
                <div class="form-hint">Used in templates: <code>{{nodes.${esc(node.id)}.&lt;port&gt;}}</code></div>
            </div>
            ${def.description ? `<p class="ge-inspector-desc">${esc(def.description)}</p>` : ''}

            ${configPorts.length === 0
                ? '<div class="ge-inspector-section-h">No config — wire its inputs from upstream nodes.</div>'
                : `<div class="ge-inspector-section-h">Configuration</div>
                   <div class="ge-inspector-fields">
                        ${configPorts.map((p) => renderField(node, p)).join('')}
                   </div>`}

            <div class="ge-inspector-section-h">Advanced</div>
            <div class="form-group">
                <label class="form-label">Condition (skip if falsy)</label>
                <input class="form-input" value="${esc(node.condition || '')}"
                    placeholder="e.g. {{nodes.review.mergeReady}}"
                    onchange="ge.workflow.graph.nodes.find(n=>n.id==='${esc(node.id)}').condition = this.value || undefined; updateYamlPanel()">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">On error</label>
                    <select class="form-select"
                        onchange="ge.workflow.graph.nodes.find(n=>n.id==='${esc(node.id)}').on_error = this.value === 'stop' ? undefined : this.value; updateYamlPanel()">
                        <option value="stop" ${(node.on_error || 'stop') === 'stop' ? 'selected' : ''}>Stop workflow</option>
                        <option value="continue" ${node.on_error === 'continue' ? 'selected' : ''}>Continue</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Timeout (s)</label>
                    <input class="form-input" type="number" min="0" value="${esc(node.timeout || '')}"
                        onchange="ge.workflow.graph.nodes.find(n=>n.id==='${esc(node.id)}').timeout = this.value ? Number(this.value) : undefined; updateYamlPanel()">
                </div>
            </div>

            <div class="ge-inspector-section-h">Outputs (wire-able)</div>
            <ul class="ge-port-list">
                ${def.ports.filter((p) => p.role === 'output' && p.wire).map((p) => `
                    <li><code>{{nodes.${esc(node.id)}.${esc(p.name)}}}</code>
                        <span>${esc(p.label)} <small>(${esc(p.type || 'any')})</small></span></li>
                `).join('') || '<li>No outputs</li>'}
            </ul>
        </div>
    `;
}

function renderField(node, port) {
    const value = node.config?.[port.name];
    const setExpr = `setNodeField('${esc(node.id)}', '${esc(port.name)}', __VAL__)`;
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
                        onchange="toggleMultiselect('${esc(node.id)}', '${esc(port.name)}', '${esc(o.value)}', this.checked)">
                    <span>${esc(o.label)}</span>
                </label>`;
            }).join('') || '<div class="form-hint">No predefined options — type values manually below.</div>'}
            <input class="form-input ge-multiselect-extra" placeholder="Type a custom value and press Enter"
                onkeydown="if(event.key==='Enter'){event.preventDefault();addMultiselectCustom('${esc(node.id)}','${esc(port.name)}',this.value);this.value='';}">
            <div class="ge-multiselect-tags">
                ${value.filter((v) => !options.some((o) => o.value === v)).map((v) => `
                    <span class="tag-pill">${esc(v)} <button onclick="toggleMultiselect('${esc(node.id)}','${esc(port.name)}','${esc(v)}', false)">×</button></span>
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
                        onchange="updateKvKey('${esc(node.id)}','${esc(port.name)}',${i},this.value)">
                    <input class="form-input" value="${esc(v)}" placeholder="value"
                        oninput="updateKvVal('${esc(node.id)}','${esc(port.name)}','${esc(k)}',this.value)">
                    <button class="btn btn-danger-outline btn-sm" onclick="removeKv('${esc(node.id)}','${esc(port.name)}','${esc(k)}')">×</button>
                </div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="addKv('${esc(node.id)}','${esc(port.name)}')">+ Add row</button>
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
    updateYamlPanel();
};
window.updateManualInput = function (i, field, val) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) return;
    const inputs = [...(node.config?.inputs || [])];
    if (!inputs[i]) return;
    inputs[i] = { ...inputs[i], [field]: val };
    node.config = { ...node.config, inputs };
    updateYamlPanel();
};
window.removeManualInput = function (i) {
    const node = ge.workflow.graph.nodes.find((n) => n.id === ge.selectedNodeId);
    if (!node) return;
    const inputs = (node.config?.inputs || []).filter((_, j) => j !== i);
    node.config = { ...node.config, inputs };
    renderInspector();
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
    if (side === 'output') {
        ge.wiringFrom = { nodeId, port, cursor: null };
        updateCanvasHint();
        drawEdges();
        return;
    }
    // side === 'input' — complete the wire if one is in progress.
    if (!ge.wiringFrom) {
        toast('Click an output port (right side of a node) first', 'error');
        return;
    }
    if (ge.wiringFrom.nodeId === nodeId) {
        toast('Cannot wire a node to itself', 'error');
        ge.wiringFrom = null;
        updateCanvasHint();
        drawEdges();
        return;
    }
    const exists = ge.workflow.graph.edges.some((edge) =>
        edge.from.node === ge.wiringFrom.nodeId && edge.from.port === ge.wiringFrom.port
        && edge.to.node === nodeId && edge.to.port === port);
    if (!exists) {
        ge.workflow.graph.edges.push({
            id: `e${Date.now().toString(36)}`,
            from: { node: ge.wiringFrom.nodeId, port: ge.wiringFrom.port },
            to: { node: nodeId, port },
        });
    }
    ge.wiringFrom = null;
    updateCanvasHint();
    drawEdges();
    updateYamlPanel();
};

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
            await api.post('/api/workflows', payload);
            toast(`Created "${wf.name}"`);
            ge.isNew = false;
            ge.originalName = wf.name;
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
        return /^[a-zA-Z0-9_./@:#-]*$/.test(obj) ? obj : `"${obj.replace(/"/g, '\\"')}"`;
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
