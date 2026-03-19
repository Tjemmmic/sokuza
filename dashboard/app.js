// ─── Sokuza Dashboard v3 ────────────────────────────────────────────────────
// Comprehensive management UI — structured editors, live events + history, stats

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ─── State ──────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let workflows = [];
let templates = [];
let integrations = {};
let availableActions = [];
let events = [];
let eventStats = {};
let eventSource = null;

// ─── Event Catalog (source → events with friendly names) ───────────────────
const eventCatalog = {
    github: [
        { value: 'pull_request.opened', label: 'Pull Request Opened', desc: 'A new pull request is created' },
        { value: 'pull_request.closed', label: 'Pull Request Closed / Merged', desc: 'A pull request is closed or merged' },
        { value: 'pull_request.synchronize', label: 'Pull Request Updated', desc: 'New commits pushed to a pull request' },
        { value: 'pull_request.review_requested', label: 'Review Requested', desc: 'A review is requested on a pull request' },
        { value: 'pull_request_review.submitted', label: 'Review Submitted', desc: 'A pull request review is submitted' },
        { value: 'issues.opened', label: 'Issue Opened', desc: 'A new issue is created' },
        { value: 'issues.closed', label: 'Issue Closed', desc: 'An issue is closed' },
        { value: 'issues.labeled', label: 'Issue Labeled', desc: 'A label is added to an issue' },
        { value: 'issues.assigned', label: 'Issue Assigned', desc: 'An issue is assigned to someone' },
        { value: 'issue_comment.created', label: 'Comment Created', desc: 'A new comment on an issue or pull request' },
        { value: 'push', label: 'Push', desc: 'Commits are pushed to a branch' },
    ],
    'github-poll': [
        { value: 'pull_request.opened', label: 'Pull Request Opened', desc: 'Detected via polling' },
        { value: 'pull_request.closed', label: 'Pull Request Closed', desc: 'Detected via polling' },
        { value: 'pull_request.synchronize', label: 'Pull Request Updated', desc: 'Detected via polling' },
        { value: 'push', label: 'Push', desc: 'Detected via polling' },
        { value: 'issues.opened', label: 'Issue Opened', desc: 'Detected via polling' },
        { value: 'issues.closed', label: 'Issue Closed', desc: 'Detected via polling' },
        { value: 'issue_comment.created', label: 'Comment Created', desc: 'Detected via polling' },
    ],
    slack: [
        { value: 'message', label: 'Message Received', desc: 'A message is posted in a channel' },
        { value: 'app_mention', label: 'App Mentioned', desc: 'Your app is @mentioned' },
        { value: 'reaction_added', label: 'Reaction Added', desc: 'An emoji reaction is added to a message' },
        { value: 'reaction_removed', label: 'Reaction Removed', desc: 'An emoji reaction is removed' },
        { value: 'channel_created', label: 'Channel Created', desc: 'A new channel is created' },
        { value: 'member_joined_channel', label: 'Member Joined Channel', desc: 'Someone joins a channel' },
        { value: 'slash_command', label: 'Slash Command', desc: 'A slash command is invoked' },
    ],
    cron: [
        { value: 'every-1m', label: 'Every Minute', desc: 'Fires once per minute' },
        { value: 'every-5m', label: 'Every 5 Minutes', desc: 'Fires every 5 minutes' },
        { value: 'every-15m', label: 'Every 15 Minutes', desc: 'Fires every 15 minutes' },
        { value: 'every-30m', label: 'Every 30 Minutes', desc: 'Fires every 30 minutes' },
        { value: 'hourly', label: 'Hourly', desc: 'Fires once per hour' },
        { value: 'daily', label: 'Daily', desc: 'Fires once per day' },
    ],
    webhook: [
        { value: 'incoming', label: 'Incoming Webhook', desc: 'Any webhook payload received' },
    ],
    manual: [
        { value: 'manual', label: 'Manual Trigger', desc: 'Triggered manually from the dashboard' },
    ],
};

// Build reverse lookup: event value → friendly label
const eventLabelMap = {};
for (const [source, events] of Object.entries(eventCatalog)) {
    for (const evt of events) {
        if (!eventLabelMap[evt.value]) eventLabelMap[evt.value] = evt.label;
    }
}

// ─── Action Param Reference ─────────────────────────────────────────────────
const actionDocs = {
    'log': {
        desc: 'Log a message with event context',
        params: [
            { name: 'message', type: 'string', desc: 'Message to log (supports {{template}} expressions)', required: true },
            { name: 'level', type: 'string', desc: 'Log level: info, warn, error, debug', default: 'info' },
        ]
    },
    'webhook': {
        desc: 'POST a JSON payload to an external URL',
        params: [
            { name: 'url', type: 'string', desc: 'Target URL to send the request to', required: true },
            { name: 'method', type: 'string', desc: 'HTTP method', default: 'POST' },
            { name: 'body', type: 'object', desc: 'Custom body (default: event payload)' },
            { name: 'headers', type: 'object', desc: 'Additional HTTP headers' },
        ]
    },
    'ai-review': {
        desc: 'Send a code diff to Claude for AI review',
        params: [
            { name: 'prompt', type: 'string', desc: 'Review instructions for the AI' },
            { name: 'model', type: 'string', desc: 'Claude model to use', default: 'sonnet' },
            { name: 'provider', type: 'string', desc: '"api" (Anthropic SDK) or "claude-code" (CLI)', default: 'auto' },
            { name: 'system_prompt', type: 'string', desc: 'Override the system prompt' },
            { name: 'max_diff_chars', type: 'number', desc: 'Max diff size before truncation', default: '100000' },
            { name: 'api_key', type: 'string', desc: 'Anthropic API key (API provider only)' },
        ]
    },
    'ai-agent': {
        desc: 'Run Claude Code CLI with tool access inside a repo',
        params: [
            { name: 'workdir', type: 'string', desc: 'Working directory (usually from github-clone-repo)', required: true },
            { name: 'prompt', type: 'string', desc: 'What to ask Claude to do', required: true },
            { name: 'model', type: 'string', desc: 'Claude model', default: 'sonnet' },
            { name: 'allowed_tools', type: 'array', desc: 'CLI tools to allow', default: 'Read, Grep, Glob, LS' },
            { name: 'max_turns', type: 'number', desc: 'Max conversation turns', default: '10' },
            { name: 'output_format', type: 'string', desc: '"text" or "json"', default: 'text' },
        ]
    },
    'github-fetch-diff': {
        desc: 'Fetch the PR diff from GitHub',
        params: [
            { name: '(none)', type: '', desc: 'Uses event context automatically — no params needed' },
        ]
    },
    'github-comment': {
        desc: 'Post a comment on the PR/issue',
        params: [
            { name: 'body', type: 'string', desc: 'Comment body (Markdown, supports {{template}} expressions)', required: true },
        ]
    },
    'github-clone-repo': {
        desc: 'Clone the repository to a temp directory',
        params: [
            { name: '(none)', type: '', desc: 'Uses event context — returns { path } for use in later steps' },
        ]
    },
    'github-create-pr': {
        desc: 'Create a pull request from changes made in a cloned repo',
        params: [
            { name: 'workdir', type: 'string', desc: 'Cloned repo path (from github-clone-repo)', required: true },
            { name: 'title', type: 'string', desc: 'PR title', required: true },
            { name: 'body', type: 'string', desc: 'PR description (Markdown)' },
        ]
    },
    'slack-send-message': {
        desc: 'Send a message to a Slack channel',
        params: [
            { name: 'channel', type: 'string', desc: 'Slack channel (e.g. #code-reviews)', required: true },
            { name: 'text', type: 'string', desc: 'Message text (supports {{template}} expressions)', required: true },
        ]
    },
    'slack-react': {
        desc: 'Add a reaction emoji to a Slack message',
        params: [
            { name: 'emoji', type: 'string', desc: 'Emoji name (without colons)', required: true },
        ]
    },
};

// ─── Array helpers ──────────────────────────────────────────────────────────
function ensureArray(val) {
    if (val === undefined || val === null) return [];
    if (Array.isArray(val)) return val.filter(v => v !== '' && v !== undefined);
    return val === '' ? [] : [val];
}

// ─── API Layer ──────────────────────────────────────────────────────────────
const api = {
    async get(p) {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
    },
    async post(p, b) {
        const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        return r.json();
    },
    async put(p, b) {
        const r = await fetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        return r.json();
    },
    async del(p) {
        const r = await fetch(p, { method: 'DELETE' });
        return r.json();
    },
};

// ─── Toast Notifications ────────────────────────────────────────────────────
function toast(message, type = 'success') {
    const container = document.getElementById('toast-container') || (() => {
        const c = document.createElement('div');
        c.id = 'toast-container';
        c.className = 'toast-container';
        document.body.appendChild(c);
        return c;
    })();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────────
function confirm(msg) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `<div class="confirm-box"><p>${msg}</p><div class="btn-group"><button class="btn btn-ghost" data-action="no">Cancel</button><button class="btn btn-danger-outline" data-action="yes">Confirm</button></div></div>`;
        document.body.appendChild(overlay);
        const cleanup = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('[data-action="yes"]').onclick = () => cleanup(true);
        overlay.querySelector('[data-action="no"]').onclick = () => cleanup(false);
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
    });
}

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(page) {
    currentPage = page;
    window.location.hash = page;
    $$('.nav-link').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
    // Close sidebar on mobile
    $('#sidebar')?.classList.remove('open');
    $('#sidebar-backdrop')?.classList.remove('open');
    renderPage();
}

// ─── Sidebar Toggle ─────────────────────────────────────────────────────────
window.toggleSidebar = function () {
    $('#sidebar').classList.toggle('open');
    $('#sidebar-backdrop').classList.toggle('open');
};

async function renderPage() {
    const el = $('#content');
    // Skeleton loading state
    el.innerHTML = `<div style="padding:8px 0">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="card-grid" style="margin-top:20px">
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
        </div>
    </div>`;
    try {
        switch (currentPage) {
            case 'dashboard': await renderDashboard(el); break;
            case 'workflows': await renderWorkflows(el); break;
            case 'templates': await renderTemplates(el); break;
            case 'integrations': await renderIntegrations(el); break;
            case 'events': await renderEvents(el); break;
            case 'settings': await renderSettings(el); break;
        }
        el.classList.remove('page-enter');
        void el.offsetWidth;
        el.classList.add('page-enter');
    } catch (err) {
        el.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">Error loading page: ${err.message}</p><button class="btn btn-ghost" onclick="renderPage()">Retry</button></div>`;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
async function renderDashboard(el) {
    await loadAll();
    const activeInt = Object.values(integrations).filter((v) => v.enabled).length;
    const recent = events.slice(0, 8);

    el.innerHTML = `
        <div class="page-header"><div class="page-header-left">
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Overview of your Sokuza instance</p>
        </div></div>

        <div class="card-grid">
            <div class="card card-stat card-clickable" onclick="navigate('workflows')">
                <div class="stat-value">${workflows.length}</div>
                <div class="stat-label">Workflows</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('integrations')">
                <div class="stat-value">${activeInt}</div>
                <div class="stat-label">Integrations</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('templates')">
                <div class="stat-value">${templates.length}</div>
                <div class="stat-label">Templates</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('events')">
                <div class="stat-value">${eventStats.total ?? events.length}</div>
                <div class="stat-label">Total Events</div>
            </div>
        </div>

        ${eventStats.hourlyBuckets ? `
        <div class="card" style="margin-bottom:24px;padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">EVENT ACTIVITY (24h)</span>
                <span style="font-size:12px;color:var(--text-muted)">${eventStats.lastHour ?? 0} in last hour</span>
            </div>
            ${renderBarChart(eventStats.hourlyBuckets)}
        </div>` : ''}

        <div class="table-wrap">
            <div class="table-top">
                <span class="table-top-title">Recent Events</span>
                <button class="btn btn-ghost btn-sm" onclick="navigate('events')">View All →</button>
            </div>
            ${recent.length > 0 ? `<table><thead><tr><th>Time</th><th>Source</th><th>Event</th><th>Workflows</th></tr></thead><tbody>
                ${recent.map((e) => `<tr>
                    <td style="font-family:var(--mono);font-size:12px;color:var(--text-muted)">${fmtDateTime(e.timestamp)}</td>
                    <td>${sourceBadge(e.event?.source)}</td>
                    <td><code style="font-size:12px;color:var(--accent-hover)">${esc(e.event?.event ?? '?')}</code></td>
                    <td>${(e.matchedWorkflows?.length ? e.matchedWorkflows.map(w => `<span class="badge badge-action">${esc(w)}</span>`).join(' ') : '<span style="color:var(--text-muted);font-size:12px">—</span>')}</td>
                </tr>`).join('')}
            </tbody></table>` : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events yet — send a webhook to get started</p></div>'}
        </div>

        <div class="card" style="padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">ACTIVE WORKFLOWS</span>
            </div>
            ${workflows.length > 0 ? workflows.map(wf => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(99,102,241,0.06)">
                    <span style="font-weight:600;font-size:13px;flex:1">${esc(wf.name)}</span>
                    ${sourceBadge(wf.trigger?.source || 'github')}
                    <code style="font-size:11px;color:var(--text-muted)">${esc(wf.trigger?.event ?? '')}</code>
                    ${wf.template ? `<span class="badge badge-action" style="font-size:10px">${esc(wf.template)}</span>` : ''}
                </div>
            `).join('') : '<div style="font-size:12px;color:var(--text-muted)">No workflows</div>'}
        </div>
    `;
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKFLOWS
// ═════════════════════════════════════════════════════════════════════════════
async function renderWorkflows(el) {
    const [wfData, tmplData, actData] = await Promise.all([api.get('/api/workflows'), api.get('/api/templates'), api.get('/api/actions')]);
    workflows = wfData.workflows || [];
    templates = tmplData.templates || [];
    availableActions = actData.actions || [];

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Workflows</h1>
                <p class="page-subtitle">${workflows.length} workflow${workflows.length !== 1 ? 's' : ''} configured</p>
            </div>
            <button class="btn btn-primary" onclick="openWorkflowEditor()">+ New Workflow</button>
        </div>
        ${workflows.length > 0 ? `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Source</th><th>Trigger</th><th>Type</th><th>Steps</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>${workflows.map((wf) => {
                const hasInputs = wf.inputs?.length > 0;
                const sources = Array.isArray(wf.trigger?.source) ? wf.trigger.source : [wf.trigger?.source || 'github'];
                return `<tr>
                <td><strong style="cursor:pointer;color:var(--accent-hover)" onclick="openWorkflowEditor('${esc(wf.name)}')">${esc(wf.name)}</strong>${hasInputs ? '<br><span style="font-size:10px;color:var(--text-muted)">\u{1F3AE} has inputs \u2014 run from dashboard</span>' : ''}</td>
                <td>${sourceBadge(sources[0])}${sources.length > 1 ? `<span style="font-size:10px;color:var(--text-muted)"> +${sources.length - 1}</span>` : ''}</td>
                <td><code style="font-size:12px;color:var(--text-secondary)">${esc((() => { const evts = Array.isArray(wf.trigger?.event) ? wf.trigger.event : [wf.trigger?.event].filter(Boolean); return evts.map(e => eventLabelMap[e] || e).join(', '); })())}</code>${wf.trigger?.repo ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(Array.isArray(wf.trigger.repo) ? wf.trigger.repo.join(', ') : wf.trigger.repo)}</span>` : ''}</td>
                <td>${wf.template ? `<span class="badge badge-action">${esc(wf.template)}</span>` : '<span style="font-size:12px;color:var(--text-muted)">custom</span>'}${wf.enabled === false ? ' <span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);font-size:10px">disabled</span>' : ''}</td>
                <td>${wf.steps?.length ?? '\u2014'}</td>
                <td style="text-align:right">
                    <div class="btn-group" style="justify-content:flex-end">
                        <button class="btn ${hasInputs ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="openRunModal('${esc(wf.name)}')" title="Run workflow manually">${hasInputs ? '\u25b6 Run' : '\u25b6'}</button>
                        <button class="btn btn-ghost btn-sm" onclick="openWorkflowEditor('${esc(wf.name)}')">Edit</button>
                        <button class="btn btn-ghost btn-sm" onclick="duplicateWorkflow('${esc(wf.name)}')">Duplicate</button>
                        <button class="btn btn-danger-outline btn-sm" onclick="deleteWorkflow('${esc(wf.name)}')">Delete</button>
                    </div>
                </td>
            </tr>`}).join('')}</tbody>
        </table></div>` : `<div class="empty-state"><div class="empty-icon">\u26a1</div><p class="empty-text">No workflows yet</p><button class="btn btn-primary" onclick="openWorkflowEditor()">Create Your First Workflow</button></div>`}
    `;
}

// ─── Workflow Editor (structured) ───────────────────────────────────────────
window.openWorkflowEditor = function (existingName) {
    const isEdit = !!existingName;
    const wf = isEdit ? workflows.find((w) => w.name === existingName) : null;

    // If creating new and no name given, show Quick Start chooser
    if (!isEdit && !wf) {
        return openQuickStart();
    }

    return openFullEditor(existingName, wf);
};

// ─── Quick Start Chooser ────────────────────────────────────────────────────
function openQuickStart() {
    openModal('Create Workflow', `
        <div style="margin-bottom:20px">
            <h3 style="font-size:18px;font-weight:600;margin-bottom:4px">How do you want to trigger this workflow?</h3>
            <p style="font-size:13px;color:var(--text-secondary)">Choose a starting point — you can always customize it later.</p>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('manual-pr')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">🔀</span>
                    <strong style="font-size:15px">Manual PR Review</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Pick a PR from a dropdown and run an AI review on demand. Perfect for reviewing specific PRs whenever you want.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('manual')}
                    <span class="badge badge-action" style="font-size:10px">ai-pr-review</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('auto-pr')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">⚡</span>
                    <strong style="font-size:15px">Auto PR Review</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Automatically review every new PR with AI when it's opened. Runs without any manual intervention.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('github')}
                    <span class="badge badge-action" style="font-size:10px">ai-pr-review</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('manual-issue')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">🐛</span>
                    <strong style="font-size:15px">Manual Issue Triage</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Select an issue and run custom analysis or triage steps on it. Great for prioritizing bugs.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('manual')}
                    <span style="font-size:10px;color:var(--text-muted)">custom steps</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('blank')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">📝</span>
                    <strong style="font-size:15px">Blank Workflow</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Start from scratch with full control over triggers, inputs, and steps.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    <span style="font-size:10px;color:var(--text-muted)">fully customizable</span>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    `);
}

window.quickStartPreset = function (preset) {
    const presets = {
        'manual-pr': {
            name: 'manual-pr-review',
            description: 'On-demand AI review for any pull request',
            template: 'ai-pr-review',
            trigger: { source: ['manual'], event: [] },
            inputs: [
                { name: 'pr', label: 'Pull Request', type: 'github-pr', required: true }
            ],
        },
        'auto-pr': {
            name: 'auto-pr-review',
            description: 'Automatically review every new PR',
            template: 'ai-pr-review',
            trigger: { source: ['github'], event: ['pull_request.opened'] },
            inputs: [],
        },
        'manual-issue': {
            name: 'manual-issue-triage',
            description: 'On-demand issue analysis and triage',
            trigger: { source: ['manual'], event: [] },
            inputs: [
                { name: 'issue', label: 'Issue', type: 'github-issue', required: true }
            ],
            steps: [
                { action: 'log', params: { message: 'Triaging issue #{{event.payload.inputs.issue.number}}: {{event.payload.inputs.issue.title}}' } }
            ],
        },
        'blank': {
            name: 'my-workflow',
            trigger: { source: ['github'], event: [] },
            inputs: [],
        },
    };

    const p = presets[preset];
    if (!p) return;

    // Build a fake workflow object for the editor
    const fakeWf = {
        name: p.name,
        description: p.description || '',
        template: p.template || '',
        trigger: {
            source: p.trigger.source,
            event: p.trigger.event,
            repo: [],
        },
        steps: p.steps || [],
        inputs: p.inputs || [],
    };

    openFullEditor(null, fakeWf);
};

function openFullEditor(existingName, wf) {
    const isEdit = !!existingName;

    const ensureArray = (val) => {
        if (!val || val === '') return [];
        if (Array.isArray(val)) return val.filter(Boolean);
        return [val].filter(Boolean);
    };

    const data = {
        name: wf?.name ?? '',
        description: wf?.description ?? '',
        enabled: wf?.enabled !== false,
        template: wf?.template ?? '',
        trigger: {
            source: ensureArray(wf?.trigger?.source ?? 'github'),
            event: ensureArray(wf?.trigger?.event ?? ''),
            repo: ensureArray(wf?.trigger?.repo ?? ''),
            branch: ensureArray(wf?.trigger?.branch ?? ''),
            author: ensureArray(wf?.trigger?.author ?? ''),
            labels: wf?.trigger?.labels ? [...wf.trigger.labels] : [],
            filters: wf?.trigger?.filters ? { ...wf.trigger.filters } : {},
        },
        steps: wf?.steps ? JSON.parse(JSON.stringify(wf.steps)) : [],
        inputs: wf?.inputs ? JSON.parse(JSON.stringify(wf.inputs)) : [],
    };

    const hasInputs = data.inputs.length > 0;

    openModal(isEdit ? `Edit: ${existingName}` : 'Create Workflow', `
        <div class="editor-layout">
            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Basics</span></div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Name</label>
                            <input type="text" class="form-input" id="ed-name" value="${esc(data.name)}" placeholder="my-workflow" ${isEdit ? 'disabled' : ''}>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Description</label>
                            <textarea class="form-textarea" id="ed-description" rows="2" placeholder="What does this workflow do?" style="font-size:13px;resize:vertical">${esc(data.description)}</textarea>
                        </div>
                        <div class="form-row">
                            <div class="form-group" style="margin-bottom:0">
                                <label class="form-label">Template (optional)</label>
                                <select class="form-select" id="ed-template" onchange="onTemplateChange()">
                                    <option value="">Custom steps</option>
                                    ${templates.map((t) => `<option value="${esc(t.name)}" ${data.template === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
                                </select>
                                <div class="form-hint">Select a template to use pre-configured steps</div>
                            </div>
                            <div class="form-group" style="margin-bottom:0">
                                <label class="form-label">Status</label>
                                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0">
                                    <input type="checkbox" id="ed-enabled" ${data.enabled ? 'checked' : ''} onchange="updateYamlPreview()">
                                    <span style="font-size:13px;color:var(--text-secondary)">${data.enabled ? 'Enabled \u2014 will process events' : 'Disabled \u2014 paused'}</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Trigger</span></div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Sources <span style="font-size:10px;color:var(--text-muted);font-weight:400">(select one or more)</span></label>
                            <div id="ed-source-checkboxes" style="display:flex;flex-wrap:wrap;gap:8px">
                                ${['github', 'github-poll', 'manual', 'slack', 'webhook', 'cron'].map(s => `
                                    <label class="source-checkbox ${data.trigger.source.includes(s) ? 'checked' : ''}" style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-subtle);cursor:pointer;font-size:12px;transition:all 0.15s">
                                        <input type="checkbox" class="ed-source-cb" value="${s}" ${data.trigger.source.includes(s) ? 'checked' : ''} onchange="onSourceCheckboxChange();updateYamlPreview()" style="display:none">
                                        ${s === 'manual' ? '\u{1F3AE} manual (run from dashboard)' : s}
                                    </label>
                                `).join('')}
                            </div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:6px">\u{1F4A1} Tip: Select <strong>manual</strong> to run this workflow on-demand from the dashboard. You can combine it with other sources.</div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Events <span style="font-size:10px;color:var(--text-muted);font-weight:400">(match any of these events)</span></label>
                            <div id="ed-event-combobox" class="combobox-container">
                                <div class="combobox-selected" id="ed-event-selected">
                                    ${data.trigger.event.filter(e => e).map(e => `<span class="tag-pill">${esc(eventLabelMap[e] || e)} <button onclick="removeEventFromCombobox('${esc(e)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="combobox-search" id="ed-event-search" placeholder="Search events\u2026" oninput="filterEventDropdown()" onfocus="showEventDropdown()" autocomplete="off">
                                </div>
                                <div class="combobox-dropdown" id="ed-event-dropdown"></div>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Repositories <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all repos)</span></label>
                                <div id="ed-repo-tags" class="tag-input-container">
                                    ${data.trigger.repo.filter(r => r).map(r => `<span class="tag-pill">${esc(r)} <button onclick="removeTagItem('repo','${esc(r)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="tag-input" id="ed-repo-input" placeholder="org/repo" onkeydown="handleTagKeydown(event,'repo')">
                                </div>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Branches <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all branches)</span></label>
                                <div id="ed-branch-tags" class="tag-input-container">
                                    ${data.trigger.branch.filter(b => b).map(b => `<span class="tag-pill">${esc(b)} <button onclick="removeTagItem('branch','${esc(b)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="tag-input" id="ed-branch-input" placeholder="main" onkeydown="handleTagKeydown(event,'branch')">
                                </div>
                            </div>
                        </div>
                        <div class="form-group" style="margin-bottom:0" id="ed-author-group">
                            <label class="form-label">Authors <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all authors)</span></label>
                            <div id="ed-author-tags" class="tag-input-container">
                                ${data.trigger.author.filter(a => a).map(a => `<span class="tag-pill">${esc(a)} <button onclick="removeTagItem('author','${esc(a)}')">&times;</button></span>`).join('')}
                                <input type="text" class="tag-input" id="ed-author-input" placeholder="username" onkeydown="handleTagKeydown(event,'author')">
                            </div>
                        </div>
                        <div class="form-group" style="margin-top:12px" id="ed-labels-group">
                            <label class="form-label">Labels <span style="font-size:10px;color:var(--text-muted);font-weight:400">(match PRs/issues with any of these labels)</span></label>
                            <div id="ed-labels-tags" class="tag-input-container">
                                ${data.trigger.labels.map(l => `<span class="tag-pill">${esc(l)} <button onclick="removeLabel('${esc(l)}')">&times;</button></span>`).join('')}
                                <input type="text" class="tag-input" id="ed-label-input" placeholder="Type label and press Enter" onkeydown="handleLabelKeydown(event)">
                            </div>
                        </div>
                        <div class="form-group" style="margin-top:12px">
                            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="toggleFiltersPanel()">
                                Advanced Filters <span style="font-size:10px;color:var(--text-muted);font-weight:400">(dot-path matching)</span>
                                <span id="filters-toggle" style="font-size:10px;transition:transform 0.2s">${Object.keys(data.trigger.filters).length > 0 ? '\u25bc' : '\u25b6'}</span>
                            </label>
                            <div id="ed-filters-panel" style="display:${Object.keys(data.trigger.filters).length > 0 ? 'block' : 'none'}">
                                <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Match against the full event payload using dot-path keys, e.g. <code>payload.pull_request.base.ref</code> = <code>main</code></div>
                                <div id="ed-filters-list"></div>
                                <button class="btn btn-ghost btn-sm" onclick="addFilter()">+ Add Filter</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="panel" style="margin-bottom:16px" id="inputs-panel">
                    <div class="panel-header">
                        <span class="panel-title">\u{1F3AE} Run Inputs</span>
                        <button class="btn btn-ghost btn-sm" onclick="addInput()">+ Add Input</button>
                    </div>
                    <div class="panel-body" id="inputs-container">
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
                            \u{1F4A1} <strong>Inputs define the form</strong> shown when you click <strong>\u25b6 Run</strong> on this workflow.
                            Use <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">github-pr</code> type to show a live PR picker,
                            or <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">github-issue</code> for issues.
                            Access values in steps via <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">{{event.payload.inputs.&lt;name&gt;}}</code>
                        </div>
                        <div id="inputs-list"></div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header"><span class="panel-title">YAML Preview</span></div>
                    <div class="panel-body" style="padding:0">
                        <pre class="yaml-preview" id="yaml-preview"></pre>
                    </div>
                </div>
            </div>

            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header">
                        <span class="panel-title">Steps</span>
                        <button class="btn btn-ghost btn-sm" onclick="addStep()" id="add-step-btn">+ Add Step</button>
                    </div>
                    <div class="panel-body" id="steps-container" style="min-height:200px">
                        <div id="steps-list"></div>
                        <div id="template-steps-msg" style="display:none"></div>
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveWorkflowFromEditor('${esc(existingName ?? '')}')">${isEdit ? 'Update' : 'Create'} Workflow</button>
    `);

    window._editorSteps = data.steps;
    window._editorInputs = data.inputs;
    window._editorLabels = data.trigger.labels;
    window._editorFilters = data.trigger.filters;
    window._editorEvents = data.trigger.event;
    window._editorRepos = data.trigger.repo;
    window._editorBranches = data.trigger.branch;
    window._editorAuthors = data.trigger.author;
    renderSteps();
    renderInputsList();
    renderFiltersList();
    onTemplateChange();
    onSourceChange();
    updateYamlPreview();
};

// ─── Source change handler ──────────────────────────────────────────────────
// ─── Source checkbox handler ────────────────────────────────────────────────
window.onSourceCheckboxChange = function () {
    $$('.source-checkbox').forEach(label => {
        const cb = label.querySelector('input');
        label.classList.toggle('checked', cb.checked);
    });
    onSourceChange();
};

window.onSourceChange = function () {
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);
    const labelsGroup = $('#ed-labels-group');

    // Show/hide GitHub-specific fields
    const isGithub = sources.some(s => s === 'github' || s === 'github-poll');
    if (labelsGroup) labelsGroup.style.display = isGithub ? '' : 'none';
};

// ─── Generic tag field handlers (event, repo, branch, author) ───────────────
// State stored on window as _editorEvents, _editorRepos, _editorBranches, _editorAuthors
const tagFields = {
    event: { stateKey: '_editorEvents', containerId: 'ed-event-tags', inputId: 'ed-event-input' },
    repo: { stateKey: '_editorRepos', containerId: 'ed-repo-tags', inputId: 'ed-repo-input' },
    branch: { stateKey: '_editorBranches', containerId: 'ed-branch-tags', inputId: 'ed-branch-input' },
    author: { stateKey: '_editorAuthors', containerId: 'ed-author-tags', inputId: 'ed-author-input' },
};

window.handleTagKeydown = function (e, field) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const input = e.target;
        const value = input.value.trim().replace(/,/g, '');
        const cfg = tagFields[field];
        if (!cfg) return;
        if (value && !window[cfg.stateKey].includes(value)) {
            window[cfg.stateKey].push(value);
            renderTagField(field);
            updateYamlPreview();
        }
        input.value = '';
    }
};

window.removeTagItem = function (field, value) {
    const cfg = tagFields[field];
    if (!cfg) return;
    window[cfg.stateKey] = window[cfg.stateKey].filter(v => v !== value);
    renderTagField(field);
    updateYamlPreview();
};

function renderTagField(field) {
    const cfg = tagFields[field];
    if (!cfg) return;
    const container = $(`#${cfg.containerId}`);
    if (!container) return;
    const items = window[cfg.stateKey] || [];
    container.innerHTML = items.map(v =>
        `<span class="tag-pill">${esc(v)} <button onclick="removeTagItem('${field}','${esc(v)}')">&times;</button></span>`
    ).join('') + `<input type="text" class="tag-input" id="${cfg.inputId}" placeholder="${field === 'event' ? 'pull_request.opened' : field === 'repo' ? 'org/repo' : field === 'branch' ? 'main' : 'username'}" onkeydown="handleTagKeydown(event,'${field}')">`;
}

// ─── Event Combobox ─────────────────────────────────────────────────────────
window.showEventDropdown = function () {
    const dropdown = $('#ed-event-dropdown');
    if (!dropdown) return;
    filterEventDropdown();
    dropdown.classList.add('open');
};

window.filterEventDropdown = function () {
    const dropdown = $('#ed-event-dropdown');
    const search = $('#ed-event-search');
    if (!dropdown || !search) return;

    const query = search.value.toLowerCase().trim();
    const selected = window._editorEvents || [];
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);

    // Collect available events from selected sources (deduped)
    const seen = new Set();
    let html = '';

    for (const source of sources) {
        const events = eventCatalog[source] || [];
        const filtered = events.filter(evt => {
            if (seen.has(evt.value)) return false;
            if (selected.includes(evt.value)) return false;
            if (query && !evt.label.toLowerCase().includes(query) && !evt.value.toLowerCase().includes(query) && !evt.desc.toLowerCase().includes(query)) return false;
            seen.add(evt.value);
            return true;
        });

        if (filtered.length === 0) continue;

        html += `<div class="combobox-group-label">${esc(source)}</div>`;
        for (const evt of filtered) {
            html += `<div class="combobox-option" onclick="selectEventFromCombobox('${esc(evt.value)}')">
                <span class="combobox-option-label">${esc(evt.label)}</span>
                <span class="combobox-option-desc">${esc(evt.desc)}</span>
                <code class="combobox-option-code">${esc(evt.value)}</code>
            </div>`;
        }
    }

    if (!html) {
        html = `<div class="combobox-empty">${selected.length > 0 && !query ? 'All events selected' : 'No events match your search'}</div>`;
    }

    dropdown.innerHTML = html;
    dropdown.classList.add('open');
};

window.selectEventFromCombobox = function (value) {
    if (!window._editorEvents.includes(value)) {
        window._editorEvents.push(value);
        renderEventPills();
        updateYamlPreview();
    }
    const search = $('#ed-event-search');
    if (search) search.value = '';
    filterEventDropdown(); // Re-render dropdown to hide selected
};

window.removeEventFromCombobox = function (value) {
    window._editorEvents = window._editorEvents.filter(v => v !== value);
    renderEventPills();
    filterEventDropdown();
    updateYamlPreview();
};

function renderEventPills() {
    const container = $('#ed-event-selected');
    if (!container) return;
    const events = window._editorEvents || [];
    container.innerHTML = events.map(e =>
        `<span class="tag-pill">${esc(eventLabelMap[e] || e)} <button onclick="removeEventFromCombobox('${esc(e)}')">&times;</button></span>`
    ).join('') + `<input type="text" class="combobox-search" id="ed-event-search" placeholder="Search events\u2026" oninput="filterEventDropdown()" onfocus="showEventDropdown()" autocomplete="off">`;
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const combo = document.getElementById('ed-event-combobox');
    if (combo && !combo.contains(e.target)) {
        const dropdown = document.getElementById('ed-event-dropdown');
        if (dropdown) dropdown.classList.remove('open');
    }
});

// ─── Labels management ──────────────────────────────────────────────────────
window.handleLabelKeydown = function (e) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const input = e.target;
        const label = input.value.trim().replace(/,/g, '');
        if (label && !window._editorLabels.includes(label)) {
            window._editorLabels.push(label);
            renderLabels();
            updateYamlPreview();
        }
        input.value = '';
    }
};

window.removeLabel = function (label) {
    window._editorLabels = window._editorLabels.filter(l => l !== label);
    renderLabels();
    updateYamlPreview();
};

function renderLabels() {
    const container = $('#ed-labels-tags');
    if (!container) return;
    const labels = window._editorLabels || [];
    const input = '<input type="text" class="tag-input" id="ed-label-input" placeholder="Type label and press Enter" onkeydown="handleLabelKeydown(event)">';
    container.innerHTML = labels.map(l => `<span class="tag-pill">${esc(l)} <button onclick="removeLabel('${esc(l)}')">&times;</button></span>`).join('') + input;
}

// ─── Filters management ─────────────────────────────────────────────────────
window.toggleFiltersPanel = function () {
    const panel = $('#ed-filters-panel');
    const toggle = $('#filters-toggle');
    if (panel) {
        const show = panel.style.display === 'none';
        panel.style.display = show ? 'block' : 'none';
        if (toggle) toggle.textContent = show ? '\u25bc' : '\u25b6';
    }
};

window.addFilter = function () {
    if (!window._editorFilters) window._editorFilters = {};
    const key = `filter_${Object.keys(window._editorFilters).length}`;
    window._editorFilters[key] = '';
    renderFiltersList();
    updateYamlPreview();
};

window.removeFilter = function (key) {
    delete window._editorFilters[key];
    renderFiltersList();
    updateYamlPreview();
};

window.updateFilterKey = function (oldKey, newKey) {
    if (oldKey === newKey) return;
    const val = window._editorFilters[oldKey];
    delete window._editorFilters[oldKey];
    window._editorFilters[newKey] = val;
    updateYamlPreview();
};

window.updateFilterVal = function (key, val) {
    window._editorFilters[key] = val;
    updateYamlPreview();
};

function renderFiltersList() {
    const container = $('#ed-filters-list');
    if (!container) return;
    const filters = window._editorFilters || {};
    const entries = Object.entries(filters);
    if (entries.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic">No filters. Click + Add Filter for dot-path matching.</div>';
        return;
    }
    container.innerHTML = entries.map(([k, v]) => `
        <div class="form-kv" style="margin-bottom:6px">
            <input type="text" class="form-input" value="${esc(k)}" placeholder="payload.path.to.field" style="flex:1" onchange="updateFilterKey('${esc(k)}',this.value)">
            <input type="text" class="form-input" value="${esc(v)}" placeholder="expected value" style="flex:1" oninput="updateFilterVal('${esc(k)}',this.value);updateYamlPreview()">
            <button class="btn btn-danger-outline btn-sm btn-icon" onclick="removeFilter('${esc(k)}')" title="Remove" style="align-self:center">&times;</button>
        </div>
    `).join('');
}

// ─── Input field management for manual workflows ────────────────────────────
window.addInput = function () {
    if (!window._editorInputs) window._editorInputs = [];
    window._editorInputs.push({ name: '', label: '', type: 'text', required: false });
    renderInputsList();
    updateYamlPreview();
};

window.removeInput = function (idx) {
    window._editorInputs.splice(idx, 1);
    renderInputsList();
    updateYamlPreview();
};

function renderInputsList() {
    const container = $('#inputs-list');
    if (!container) return;
    const inputs = window._editorInputs || [];
    if (inputs.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic">No inputs defined. Click "+ Add Input" to add fields to the run form.</div>';
        return;
    }
    container.innerHTML = inputs.map((inp, i) => `
        <div class="step-card" style="margin-bottom:8px">
            <div class="step-card-header" style="padding:8px 10px">
                <div class="step-num" style="width:20px;height:20px;font-size:10px">${i + 1}</div>
                <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <input type="text" class="form-input" style="flex:1;min-width:100px;padding:4px 8px;font-size:12px" 
                        value="${esc(inp.name)}" placeholder="field_name" 
                        oninput="window._editorInputs[${i}].name=this.value;updateYamlPreview()">
                    <input type="text" class="form-input" style="flex:1;min-width:100px;padding:4px 8px;font-size:12px" 
                        value="${esc(inp.label)}" placeholder="Field Label" 
                        oninput="window._editorInputs[${i}].label=this.value;updateYamlPreview()">
                    <select class="form-select" style="width:130px;padding:4px 6px;font-size:12px" 
                        onchange="window._editorInputs[${i}].type=this.value;updateYamlPreview()">
                        ${['text', 'textarea', 'select', 'number', 'boolean', 'github-pr', 'github-issue', 'github-branch', 'github-repo'].map(t => `<option value="${t}" ${inp.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);cursor:pointer">
                        <input type="checkbox" ${inp.required ? 'checked' : ''} 
                            onchange="window._editorInputs[${i}].required=this.checked;updateYamlPreview()">
                        Required
                    </label>
                </div>
                <button class="btn btn-danger-outline btn-sm" style="padding:2px 8px;font-size:11px" onclick="removeInput(${i})">×</button>
            </div>
        </div>
    `).join('');
}

// ─── YAML Preview ───────────────────────────────────────────────────────────
window.updateYamlPreview = function () {
    const pre = $('#yaml-preview');
    if (!pre) return;
    const wf = buildWorkflowFromEditor();
    if (!wf) return;

    // Helper: render a OneOrMany value in YAML
    function yamlOneOrMany(key, val, indent = '  ') {
        if (!val) return '';
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) return '';
        if (arr.length === 1) return `${indent}${key}: ${arr[0]}\n`;
        return `${indent}${key}:\n${arr.map(v => `${indent}  - ${v}\n`).join('')}`;
    }

    let yaml = `name: ${wf.name || '(unnamed)'}\n`;
    if (wf.description) yaml += `description: "${wf.description}"\n`;
    if (wf.enabled === false) yaml += `enabled: false\n`;
    if (wf.template) yaml += `template: ${wf.template}\n`;
    yaml += `trigger:\n`;
    yaml += yamlOneOrMany('source', wf.trigger?.source);
    yaml += yamlOneOrMany('event', wf.trigger?.event);
    yaml += yamlOneOrMany('repo', wf.trigger?.repo);
    yaml += yamlOneOrMany('branch', wf.trigger?.branch);
    yaml += yamlOneOrMany('author', wf.trigger?.author);
    if (wf.trigger?.labels?.length) {
        yaml += `  labels:\n`;
        for (const l of wf.trigger.labels) yaml += `    - ${l}\n`;
    }
    if (wf.trigger?.filters && Object.keys(wf.trigger.filters).length > 0) {
        yaml += `  filters:\n`;
        for (const [k, v] of Object.entries(wf.trigger.filters)) {
            yaml += `    ${k}: "${v}"\n`;
        }
    }
    if (wf.inputs?.length) {
        yaml += `inputs:\n`;
        for (const inp of wf.inputs) {
            yaml += `  - name: ${inp.name || '(unnamed)'}\n`;
            if (inp.label) yaml += `    label: "${inp.label}"\n`;
            yaml += `    type: ${inp.type || 'text'}\n`;
            if (inp.required) yaml += `    required: true\n`;
        }
    }
    if (wf.steps?.length) {
        yaml += `steps:\n`;
        for (const s of wf.steps) {
            yaml += `  - action: ${s.action}\n`;
            if (s.id) yaml += `    id: ${s.id}\n`;
            if (s.condition) yaml += `    condition: "${s.condition}"\n`;
            if (s.on_error === 'continue') yaml += `    on_error: continue\n`;
            if (s.params && Object.keys(s.params).length > 0) {
                yaml += `    params:\n`;
                for (const [k, v] of Object.entries(s.params)) {
                    const val = String(v);
                    if (val.includes('\n')) {
                        yaml += `      ${k}: |\n${val.split('\n').map(l => `        ${l}`).join('\n')}\n`;
                    } else {
                        yaml += `      ${k}: ${val}\n`;
                    }
                }
            }
        }
    }
    pre.textContent = yaml;
};

function buildWorkflowFromEditor() {
    const nameEl = $('#ed-name');
    if (!nameEl) return null;
    const name = nameEl.value.trim();
    const description = $('#ed-description')?.value?.trim() || '';
    const enabled = $('#ed-enabled')?.checked !== false;
    const template = $('#ed-template')?.value || '';

    // Sources from checkboxes
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);

    // Events, repos, branches, authors from tag state
    const events = window._editorEvents || [];
    const repos = window._editorRepos || [];
    const branches = window._editorBranches || [];
    const authors = window._editorAuthors || [];

    const workflow = { name };
    if (description) workflow.description = description;
    if (!enabled) workflow.enabled = false;
    if (template) workflow.template = template;

    const trigger = {};
    // Emit single string when only one value, array when multiple
    trigger.source = sources.length === 1 ? sources[0] : sources;
    if (events.length > 0) trigger.event = events.length === 1 ? events[0] : events;
    if (repos.length > 0) trigger.repo = repos.length === 1 ? repos[0] : repos;
    if (branches.length > 0) trigger.branch = branches.length === 1 ? branches[0] : branches;
    if (authors.length > 0) trigger.author = authors.length === 1 ? authors[0] : authors;

    if (window._editorLabels?.length > 0) trigger.labels = [...window._editorLabels];
    const filters = window._editorFilters || {};
    const cleanFilters = {};
    for (const [k, v] of Object.entries(filters)) {
        if (k && !k.startsWith('filter_')) cleanFilters[k] = v;
        else if (v) cleanFilters[k] = v;
    }
    if (Object.keys(cleanFilters).length > 0) trigger.filters = cleanFilters;
    workflow.trigger = trigger;

    if (!template && window._editorSteps?.length > 0) {
        workflow.steps = window._editorSteps.filter((s) => s.action).map((s) => {
            const step = { action: s.action };
            if (s.id) step.id = s.id;
            if (s.condition) step.condition = s.condition;
            if (s.on_error === 'continue') step.on_error = 'continue';
            if (s.params && Object.keys(s.params).length > 0) step.params = { ...s.params };
            return step;
        });
    }

    // Include inputs for manual workflows
    if (window._editorInputs?.length > 0) {
        workflow.inputs = window._editorInputs.filter(inp => inp.name).map(inp => {
            const input = { name: inp.name, label: inp.label || inp.name, type: inp.type || 'text' };
            if (inp.required) input.required = true;
            if (inp.default) input.default = inp.default;
            if (inp.options) input.options = inp.options;
            if (inp.placeholder) input.placeholder = inp.placeholder;
            return input;
        });
    }

    return workflow;
}

window.onTemplateChange = function () {
    const tmpl = $('#ed-template').value;
    const stepsContainer = $('#steps-list');
    const tmplMsg = $('#template-steps-msg');
    const addBtn = $('#add-step-btn');
    if (tmpl) {
        stepsContainer.style.display = 'none';
        tmplMsg.style.display = 'block';
        if (addBtn) addBtn.style.display = 'none';
        const t = templates.find(t => t.name === tmpl);
        if (t?.steps) {
            tmplMsg.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Template provides ${t.steps.length} step${t.steps.length !== 1 ? 's' : ''}:</p>` +
                t.steps.map((s, i) => `<div class="step-card" style="margin-bottom:6px"><div class="step-card-header"><div class="step-num">${i + 1}</div><span class="step-action-name">${esc(s.action)}</span>${s.condition ? '<span class="badge badge-warning" style="font-size:10px">conditional</span>' : ''}</div></div>`).join('');
        }
    } else {
        stepsContainer.style.display = 'block';
        tmplMsg.style.display = 'none';
        if (addBtn) addBtn.style.display = '';
    }
    updateYamlPreview();
};

function renderSteps() {
    const list = $('#steps-list');
    if (!list) return;
    const steps = window._editorSteps;
    if (steps.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-icon">📦</div><p class="empty-text">No steps yet — add one above</p></div>';
        return;
    }
    list.innerHTML = steps.map((s, i) => `
        <div class="step-card" id="step-${i}">
            <div class="step-card-header" onclick="toggleStep(${i})">
                <div class="step-num">${i + 1}</div>
                <span class="step-action-name">${esc(s.action || '(choose action)')}</span>
                ${s.id ? `<span class="badge badge-action" style="font-size:10px">#${esc(s.id)}</span>` : ''}
                ${s.condition ? '<span class="badge badge-warning" style="font-size:10px">conditional</span>' : ''}
                <span class="step-toggle ${i === 0 ? 'open' : ''}" id="toggle-${i}">▶</span>
            </div>
            <div class="step-card-body ${i === 0 ? 'open' : ''}" id="body-${i}">
                <div class="form-row" style="margin-bottom:12px">
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">Action</label>
                        <select class="form-select" onchange="updateStep(${i},'action',this.value)">
                            <option value="">Select action...</option>
                            ${availableActions.map((a) => `<option value="${esc(a)}" ${s.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">Step ID (optional)</label>
                        <input type="text" class="form-input" value="${esc(s.id || '')}" placeholder="e.g. fetch_diff" onchange="updateStep(${i},'id',this.value)">
                    </div>
                </div>
                ${s.action && actionDocs[s.action] ? `
                <div class="action-docs" style="margin-bottom:12px;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border-subtle)">
                    <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">\u{1F4D6} ${esc(actionDocs[s.action].desc)}</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:11px">
                        ${actionDocs[s.action].params.map(p => `
                            <div style="color:var(--text-secondary);font-family:var(--font-mono)">${esc(p.name)}${p.required ? '<span style="color:var(--danger)">*</span>' : ''}</div>
                            <div style="color:var(--text-muted)">${esc(p.desc)}${p.default ? ` <span style="color:var(--text-secondary)">(default: ${esc(p.default)})</span>` : ''}</div>
                        `).join('')}
                    </div>
                </div>` : ''}
                <div class="form-group" style="margin-bottom:12px">
                    <label class="form-label">Condition (optional)</label>
                    <input type="text" class="form-input" value="${esc(s.condition || '')}" placeholder="{{steps.analysis.needs_fix}}" onchange="updateStep(${i},'condition',this.value)">
                </div>
                <div class="form-row" style="margin-bottom:12px">
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">On Error</label>
                        <select class="form-select" onchange="updateStep(${i},'on_error',this.value)">
                            <option value="stop" ${(s.on_error || 'stop') === 'stop' ? 'selected' : ''}>Stop workflow</option>
                            <option value="continue" ${s.on_error === 'continue' ? 'selected' : ''}>Continue to next step</option>
                        </select>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">Parameters</label>
                    <div id="params-${i}">${renderParams(i, s.params || {})}</div>
                    <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addParam(${i})">+ Add Param</button>
                </div>
                <div class="step-card-footer">
                    ${i > 0 ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="moveStep(${i},-1)" title="Move up">↑</button>` : ''}
                    ${i < steps.length - 1 ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="moveStep(${i},1)" title="Move down">↓</button>` : ''}
                    <button class="btn btn-danger-outline btn-sm" onclick="removeStep(${i})">Remove</button>
                </div>
            </div>
        </div>
    `).join('');
    updateYamlPreview();
}

function renderParams(stepIdx, params) {
    const entries = Object.entries(params);
    if (entries.length === 0) return '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No parameters</div>';
    return entries.map(([k, v], pi) => {
        const val = String(v);
        const isMultiline = val.includes('\n') || val.length > 80;
        return `<div class="form-kv">
            <input type="text" class="form-input" value="${esc(k)}" placeholder="key" style="max-width:140px" onchange="updateParamKey(${stepIdx},${pi},this.value)">
            ${isMultiline
                ? `<textarea class="form-textarea" placeholder="value" onchange="updateParamVal(${stepIdx},'${esc(k)}',this.value)" oninput="updateYamlPreview()">${esc(val)}</textarea>`
                : `<input type="text" class="form-input" value="${esc(val)}" placeholder="value" onchange="updateParamVal(${stepIdx},'${esc(k)}',this.value)" oninput="updateYamlPreview()">`}
            <button class="btn btn-danger-outline btn-sm btn-icon" onclick="removeParam(${stepIdx},'${esc(k)}')" title="Remove" style="align-self:center">×</button>
        </div>`;
    }).join('');
}

window.toggleStep = function (i) {
    const body = $(`#body-${i}`);
    const toggle = $(`#toggle-${i}`);
    if (body) body.classList.toggle('open');
    if (toggle) toggle.classList.toggle('open');
};

window.addStep = function () {
    window._editorSteps.push({ action: '', params: {} });
    renderSteps();
};

window.removeStep = function (i) {
    window._editorSteps.splice(i, 1);
    renderSteps();
};

window.moveStep = function (i, dir) {
    const steps = window._editorSteps;
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    renderSteps();
};

window.updateStep = function (i, key, val) {
    if (val) window._editorSteps[i][key] = val;
    else delete window._editorSteps[i][key];
    const nameEl = $(`#step-${i} .step-action-name`);
    if (nameEl && key === 'action') nameEl.textContent = val || '(choose action)';
    updateYamlPreview();
};

window.addParam = function (i) {
    if (!window._editorSteps[i].params) window._editorSteps[i].params = {};
    const key = `param${Object.keys(window._editorSteps[i].params).length + 1}`;
    window._editorSteps[i].params[key] = '';
    $(`#params-${i}`).innerHTML = renderParams(i, window._editorSteps[i].params);
    updateYamlPreview();
};

window.updateParamKey = function (stepIdx, paramIdx, newKey) {
    const params = window._editorSteps[stepIdx].params;
    const entries = Object.entries(params);
    if (paramIdx < entries.length) {
        const [oldKey, val] = entries[paramIdx];
        delete params[oldKey];
        params[newKey] = val;
    }
    updateYamlPreview();
};

window.updateParamVal = function (stepIdx, key, val) {
    window._editorSteps[stepIdx].params[key] = val;
    updateYamlPreview();
};

window.removeParam = function (stepIdx, key) {
    delete window._editorSteps[stepIdx].params[key];
    $(`#params-${stepIdx}`).innerHTML = renderParams(stepIdx, window._editorSteps[stepIdx].params);
    updateYamlPreview();
};

window.saveWorkflowFromEditor = async function (existingName) {
    const workflow = buildWorkflowFromEditor();
    if (!workflow) return;
    if (!workflow.name) return toast('Name is required', 'error');
    if (!workflow.trigger?.event && !workflow.template) return toast('Event is required', 'error');

    try {
        let result;
        if (existingName) {
            result = await api.put(`/api/workflows/${encodeURIComponent(existingName)}`, workflow);
        } else {
            result = await api.post('/api/workflows', workflow);
        }
        if (result.error) return toast(result.error, 'error');
        toast(existingName ? 'Workflow updated' : 'Workflow created');
        closeModal();
        navigate('workflows');
    } catch (err) {
        toast('Failed to save workflow', 'error');
    }
};

window.deleteWorkflow = async function (name) {
    if (!(await confirm(`Delete workflow <strong>"${esc(name)}"</strong>?<br><span style="font-size:12px;color:var(--text-muted)">This removes it from sokuza.config.yaml</span>`))) return;
    try {
        const result = await api.del(`/api/workflows/${encodeURIComponent(name)}`);
        if (result.error) return toast(result.error, 'error');
        toast('Workflow deleted');
        navigate('workflows');
    } catch { toast('Failed to delete', 'error'); }
};

window.duplicateWorkflow = async function (name) {
    const original = workflows.find(w => w.name === name);
    if (!original) return;
    const copy = JSON.parse(JSON.stringify(original));
    copy.name = `${name}-copy`;
    // Keep incrementing if name already taken
    let suffix = 1;
    while (workflows.some(w => w.name === copy.name)) {
        suffix++;
        copy.name = `${name}-copy-${suffix}`;
    }
    try {
        const result = await api.post('/api/workflows', copy);
        if (result.error) return toast(result.error, 'error');
        toast(`Duplicated as "${copy.name}"`);
        navigate('workflows');
    } catch { toast('Failed to duplicate', 'error'); }
};

// ─── Run Workflow Modal ─────────────────────────────────────────────────────

/** Resolve the repo scope for a github-* picker input */
function resolvePickerRepo(inp, wfDetails) {
    if (inp.scope) return inp.scope;
    const repo = wfDetails?.trigger?.repo;
    if (Array.isArray(repo)) return repo[0] || '';
    return repo || '';
}

/** Render a github-* picker field */
function renderPickerField(inp, i, wfDetails) {
    const reqd = inp.required ? '<span style="color:#ef4444">*</span>' : '';
    const repo = resolvePickerRepo(inp, wfDetails);
    const typeLabels = { 'github-pr': '🔀 Pull Request', 'github-issue': '🐛 Issue', 'github-branch': '🌿 Branch', 'github-repo': '📦 Repository' };
    const label = esc(inp.label || inp.name);

    return `<div class="form-group">
        <label class="form-label">${label} ${reqd}
            <span style="font-size:11px;color:var(--text-muted);font-weight:400;margin-left:6px">${typeLabels[inp.type] || ''}</span>
        </label>
        <div id="picker-${i}" class="picker-container" style="position:relative">
            <div class="picker-loading" style="display:flex;align-items:center;gap:8px;padding:10px;color:var(--text-muted);font-size:13px">
                <div class="spinner" style="width:14px;height:14px"></div> Loading...
            </div>
        </div>
    </div>`;
}

/** Fetch data and populate a picker after the modal is open */
/** Show a repo selector first, then load the actual picker after repo choice */
async function initRepoChooserThenPicker(container, inp, i, wfDetails) {
    const typeLabels = { 'github-pr': 'pull requests', 'github-issue': 'issues', 'github-branch': 'branches' };
    const entityLabel = typeLabels[inp.type] || 'items';

    container.innerHTML = `
        <div style="padding:8px 0">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
                ⚠️ No repository configured. Select a repo to browse ${entityLabel}:
            </div>
            <div id="repo-chooser-${i}" style="display:flex;align-items:center;gap:8px">
                <div class="spinner" style="width:14px;height:14px"></div>
                <span style="font-size:12px;color:var(--text-muted)">Loading repos...</span>
            </div>
        </div>`;

    try {
        const data = await api.get('/api/github/repos');
        const repos = data.items || [];
        const chooser = $(`#repo-chooser-${i}`);
        if (!chooser) return;

        if (repos.length === 0) {
            chooser.innerHTML = '<span style="font-size:12px;color:#ef4444">No repos found. Add a <code>repo</code> to the workflow trigger or configure repos in your integrations.</span>';
            return;
        }

        chooser.innerHTML = `
            <select class="form-select" id="repo-select-${i}" style="flex:1;font-size:13px;font-family:var(--mono)">
                <option value="">-- Select a repository --</option>
                ${repos.map(r => `<option value="${esc(r.full_name)}">${esc(r.full_name)}${r.source === 'config' ? ' ★' : ''}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="onRepoChosen(${i})">Load</button>`;
    } catch (err) {
        const chooser = $(`#repo-chooser-${i}`);
        if (chooser) chooser.innerHTML = `<span style="font-size:12px;color:#ef4444">⚠ Could not load repos: ${esc(err.message)}</span>`;
    }

    // Store context for the callback
    if (!window._pickerPendingRepo) window._pickerPendingRepo = {};
    window._pickerPendingRepo[i] = { inp, wfDetails };
}

window.onRepoChosen = function (pickerIdx) {
    const select = $(`#repo-select-${pickerIdx}`);
    if (!select || !select.value) return toast('Select a repository first', 'error');

    const pending = window._pickerPendingRepo?.[pickerIdx];
    if (!pending) return;

    // Override the input's scope with the chosen repo and re-init the actual picker
    const overriddenInp = { ...pending.inp, scope: select.value };
    initPicker(overriddenInp, pickerIdx, pending.wfDetails);
};

async function initPicker(inp, i, wfDetails) {
    const container = $(`#picker-${i}`);
    if (!container) return;
    const repo = resolvePickerRepo(inp, wfDetails);
    const [owner, repoName] = repo ? repo.split('/') : ['', ''];

    // For repo-scoped pickers, if no repo is configured, show a repo chooser first
    const needsRepo = ['github-pr', 'github-issue', 'github-branch'].includes(inp.type);
    if (needsRepo && (!owner || !repoName)) {
        return initRepoChooserThenPicker(container, inp, i, wfDetails);
    }

    try {
        let items = [];
        let renderItem;

        switch (inp.type) {
            case 'github-pr': {
                const data = await api.get(`/api/github/${owner}/${repoName}/pulls`);
                items = data.items || [];
                renderItem = (item) => {
                    const labels = (item.labels || []).map(l => `<span class="badge badge-action" style="font-size:9px;padding:1px 5px">${esc(l)}</span>`).join('');
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-weight:600;color:var(--accent);min-width:42px">#${item.number}</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.title)}</span>
                            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(item.author || '')}</span>
                            ${item.draft ? '<span class="badge badge-warning" style="font-size:9px">draft</span>' : ''}
                            ${labels}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-issue': {
                const data = await api.get(`/api/github/${owner}/${repoName}/issues`);
                items = data.items || [];
                renderItem = (item) => {
                    const labels = (item.labels || []).map(l => `<span class="badge badge-action" style="font-size:9px;padding:1px 5px">${esc(l)}</span>`).join('');
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-weight:600;color:var(--success);min-width:42px">#${item.number}</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.title)}</span>
                            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(item.author || '')}</span>
                            ${labels}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-branch': {
                const data = await api.get(`/api/github/${owner}/${repoName}/branches`);
                items = data.items || [];
                renderItem = (item) => {
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-family:var(--font-mono);font-size:13px;color:var(--accent)">${esc(item.name)}</span>
                            <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${esc(item.sha || '')}</span>
                            ${item.protected ? '<span class="badge badge-warning" style="font-size:9px">protected</span>' : ''}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-repo': {
                const data = await api.get('/api/github/repos');
                items = data.items || [];
                renderItem = (item) => {
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-family:var(--font-mono);font-size:13px;font-weight:600">${esc(item.full_name)}</span>
                            ${item.source === 'config' ? '<span class="badge badge-success" style="font-size:9px">configured</span>' : ''}
                            ${item.description ? `<span style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.description)}</span>` : ''}
                        </div>
                    </div>`;
                };
                break;
            }
        }

        // Store items for selection
        if (!window._pickerData) window._pickerData = {};
        window._pickerData[i] = { items, repo };

        if (items.length === 0) {
            container.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:13px;font-style:italic">No items found${repo ? ` in ${esc(repo)}` : ''}</div>`;
            return;
        }

        // Search input + scrollable list
        container.innerHTML = `
            <input type="text" class="form-input" id="picker-search-${i}" placeholder="Search..." style="margin-bottom:6px;font-size:13px" oninput="filterPicker(${i}, this.value)">
            <div id="picker-selected-${i}" style="display:none;padding:8px 12px;background:rgba(99,102,241,0.08);border-radius:var(--radius-sm);margin-bottom:6px;cursor:pointer" onclick="clearPickerSelection(${i})"></div>
            <div id="picker-list-${i}" class="picker-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius-sm)">
                ${items.map(renderItem).join('')}
            </div>`;

        // Store renderItem for filtering
        window._pickerData[i].renderItem = renderItem;

    } catch (err) {
        container.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:13px">⚠ Failed to load: ${esc(err.message || 'Unknown error')}</div>`;
    }
}

window.selectPickerItem = function (pickerIdx, itemIdx) {
    const data = window._pickerData?.[pickerIdx];
    if (!data) return;
    const item = data.items[itemIdx];
    if (!item) return;

    // Store selection
    if (!window._pickerSelections) window._pickerSelections = {};
    // Attach repo context to the selection
    const selection = { ...item, repo: data.repo };
    window._pickerSelections[pickerIdx] = selection;

    // Show selected item, hide list
    const selectedEl = $(`#picker-selected-${pickerIdx}`);
    const listEl = $(`#picker-list-${pickerIdx}`);
    const searchEl = $(`#picker-search-${pickerIdx}`);

    if (selectedEl) {
        let display = '';
        if (item.number !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-weight:600;color:var(--accent)">#${item.number}</span>
                <span>${esc(item.title || '')}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        } else if (item.name !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-family:var(--font-mono);font-weight:600;color:var(--accent)">${esc(item.name)}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        } else if (item.full_name !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-family:var(--font-mono);font-weight:600">${esc(item.full_name)}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        }
        selectedEl.innerHTML = display;
        selectedEl.style.display = 'block';
    }
    if (listEl) listEl.style.display = 'none';
    if (searchEl) searchEl.style.display = 'none';
};

window.clearPickerSelection = function (pickerIdx) {
    if (window._pickerSelections) delete window._pickerSelections[pickerIdx];
    const selectedEl = $(`#picker-selected-${pickerIdx}`);
    const listEl = $(`#picker-list-${pickerIdx}`);
    const searchEl = $(`#picker-search-${pickerIdx}`);
    if (selectedEl) selectedEl.style.display = 'none';
    if (listEl) listEl.style.display = '';
    if (searchEl) { searchEl.style.display = ''; searchEl.value = ''; }
    filterPicker(pickerIdx, '');
};

window.filterPicker = function (pickerIdx, query) {
    const data = window._pickerData?.[pickerIdx];
    const listEl = $(`#picker-list-${pickerIdx}`);
    if (!data || !listEl) return;
    const q = query.toLowerCase();
    const filtered = q ? data.items.filter(item => {
        const text = JSON.stringify(item).toLowerCase();
        return text.includes(q);
    }) : data.items;
    listEl.innerHTML = filtered.length > 0
        ? filtered.map(data.renderItem).join('')
        : '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center">No matches</div>';
};

window.openRunModal = async function (name) {
    // Reset picker state
    window._pickerData = {};
    window._pickerSelections = {};

    // Fetch workflow details to get input definitions
    let wfDetails;
    try {
        const data = await api.get(`/api/workflows/${encodeURIComponent(name)}/details`);
        wfDetails = data.workflow;
    } catch {
        // Fallback to local data
        wfDetails = workflows.find(w => w.name === name);
    }

    if (!wfDetails) return toast('Workflow not found', 'error');

    const inputs = wfDetails.inputs || [];
    const hasInputs = inputs.length > 0;

    let formHtml = '';
    if (hasInputs) {
        formHtml = inputs.map((inp, i) => {
            // GitHub picker types
            if (inp.type?.startsWith('github-')) {
                return renderPickerField(inp, i, wfDetails);
            }
            const reqd = inp.required ? '<span style="color:#ef4444">*</span>' : '';
            switch (inp.type) {
                case 'textarea':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <textarea class="form-input" id="run-input-${i}" rows="3" placeholder="${esc(inp.placeholder || '')}">${esc(inp.default || '')}</textarea>
                    </div>`;
                case 'select':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <select class="form-select" id="run-input-${i}">
                            ${(inp.options || []).map(o => `<option value="${esc(o)}" ${o === inp.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}
                        </select>
                    </div>`;
                case 'number':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <input type="number" class="form-input" id="run-input-${i}" value="${esc(inp.default || '')}" placeholder="${esc(inp.placeholder || '')}">
                    </div>`;
                case 'boolean':
                    return `<div class="form-group" style="display:flex;align-items:center;gap:8px">
                        <input type="checkbox" id="run-input-${i}" ${inp.default ? 'checked' : ''} style="width:16px;height:16px">
                        <label for="run-input-${i}" class="form-label" style="margin:0">${esc(inp.label || inp.name)}</label>
                    </div>`;
                default: // text
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <input type="text" class="form-input" id="run-input-${i}" value="${esc(inp.default || '')}" placeholder="${esc(inp.placeholder || '')}">
                    </div>`;
            }
        }).join('');
    } else {
        formHtml = `<div style="padding:12px 0;color:var(--text-secondary);font-size:13px">
            <p>This workflow has no defined inputs. It will run with the trigger event: <code style="color:var(--accent)">${esc(wfDetails.trigger?.event || 'unknown')}</code></p>
            <p style="margin-top:8px;color:var(--text-muted);font-size:12px">💡 Add <code>inputs:</code> to the workflow definition to enable a form here.</p>
        </div>`;
    }

    // Store input metadata for executeRun
    window._runInputs = inputs;
    window._runWorkflowName = name;

    openModal(`▶ Run: ${esc(name)}`, `
        <div style="margin-bottom:12px">
            <div style="display:flex;gap:8px;margin-bottom:12px">
                ${sourceBadge(wfDetails.trigger?.source || 'github')}
                <code style="font-size:12px;color:var(--text-secondary)">${esc(wfDetails.trigger?.event || '')}</code>
                ${wfDetails.template ? `<span class="badge badge-action">${esc(wfDetails.template)}</span>` : ''}
            </div>
        </div>
        <div id="run-form">${formHtml}</div>
        <div id="run-status" style="display:none;padding:12px;margin-top:8px;border-radius:var(--radius-sm);background:rgba(99,102,241,0.06);font-size:13px;color:var(--text-secondary)"></div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="run-exec-btn" onclick="executeRun()">▶ Execute</button>
    `);

    // Initialize pickers after modal is open
    for (let i = 0; i < inputs.length; i++) {
        if (inputs[i].type?.startsWith('github-')) {
            initPicker(inputs[i], i, wfDetails);
        }
    }
};

window.executeRun = async function () {
    const name = window._runWorkflowName;
    const inputDefs = window._runInputs || [];
    const btn = $('#run-exec-btn');
    const statusEl = $('#run-status');

    // Collect values
    const inputs = {};
    for (let i = 0; i < inputDefs.length; i++) {
        const inp = inputDefs[i];

        // Handle github-* picker types
        if (inp.type?.startsWith('github-')) {
            const selection = window._pickerSelections?.[i];
            if (inp.required && !selection) {
                toast(`"${inp.label || inp.name}" is required — select an item`, 'error');
                return;
            }
            if (selection) inputs[inp.name] = selection;
            continue;
        }

        const el = $(`#run-input-${i}`);
        if (!el) continue;
        let val;
        if (inp.type === 'boolean') {
            val = el.checked;
        } else if (inp.type === 'number') {
            val = Number(el.value) || 0;
        } else {
            val = el.value;
        }
        // Validate required
        if (inp.required && (val === '' || val === null || val === undefined)) {
            toast(`"${inp.label || inp.name}" is required`, 'error');
            el.focus();
            return;
        }
        inputs[inp.name] = val;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Running...';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></div> Executing workflow...';

    try {
        const result = await api.post(`/api/workflows/${encodeURIComponent(name)}/run`, { inputs });
        if (result.error) {
            statusEl.innerHTML = `<span style="color:#ef4444">✗ ${esc(result.error)}</span>`;
            toast(result.error, 'error');
        } else {
            statusEl.innerHTML = '<span style="color:#22c55e">✓ Workflow executed successfully</span>';
            toast(`Workflow "${name}" executed`);
            setTimeout(closeModal, 1500);
        }
    } catch (err) {
        statusEl.innerHTML = `<span style="color:#ef4444">✗ ${esc(err.message || 'Execution failed')}</span>`;
        toast('Workflow execution failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '▶ Execute';
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ═════════════════════════════════════════════════════════════════════════════
async function renderTemplates(el) {
    const [tmplData, actData] = await Promise.all([api.get('/api/templates'), api.get('/api/actions')]);
    templates = tmplData.templates || [];
    availableActions = actData.actions || [];

    el.innerHTML = `
        <div class="page-header"><div class="page-header-left">
            <h1 class="page-title">Templates</h1>
            <p class="page-subtitle">${templates.length} template${templates.length !== 1 ? 's' : ''} available in templates/</p>
        </div><div class="page-header-right">
            <button class="btn btn-primary" onclick="openTemplateEditor()">+ New Template</button>
        </div></div>
        <div class="card-grid card-grid-3">
            ${templates.map((t) => `<div class="card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
                    <div>
                        <h3 style="font-size:16px;font-weight:600;margin-bottom:6px">${esc(t.name)}</h3>
                        ${sourceBadge(t.trigger?.source ?? 'github')}
                        <code style="font-size:11px;color:var(--text-muted);margin-left:6px">${esc(t.trigger?.event ?? '')}</code>
                    </div>
                    <div class="btn-group">
                        <button class="btn btn-ghost btn-sm" onclick="previewTemplate('${esc(t.name)}')">Preview</button>
                        <button class="btn btn-ghost btn-sm" onclick="openTemplateEditor('${esc(t.name)}')">Edit</button>
                        <button class="btn btn-danger-outline btn-sm" onclick="deleteTemplate('${esc(t.name)}')">Delete</button>
                        <button class="btn btn-primary btn-sm" onclick="useTemplate('${esc(t.name)}')">Use →</button>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">
                    ${(t.steps || []).map((s, i) => `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(99,102,241,0.06);border-radius:6px;font-size:13px">
                        <div class="step-num" style="width:20px;height:20px;font-size:10px">${i + 1}</div>
                        <span>${esc(s.action)}</span>
                        ${s.condition ? '<span class="badge badge-warning" style="font-size:9px;margin-left:auto">conditional</span>' : ''}
                    </div>`).join('')}
                </div>
            </div>`).join('')}
        </div>
    `;
}

window.previewTemplate = function (templateName) {
    const tmpl = templates.find(t => t.name === templateName);
    if (!tmpl) return;
    openModal(`Template: ${templateName}`, `
        <pre class="yaml-preview" style="white-space:pre-wrap;max-height:400px;overflow:auto">${esc(tmpl.raw || JSON.stringify(tmpl, null, 2))}</pre>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-ghost" onclick="closeModal();openTemplateEditor('${esc(templateName)}')">Edit</button>
        <button class="btn btn-primary" onclick="closeModal();useTemplate('${esc(templateName)}')">Use This Template</button>
    `);
};

window.openTemplateEditor = function (existingName) {
    const isEdit = !!existingName;
    const tmpl = isEdit ? templates.find(t => t.name === existingName) : null;
    const content = tmpl?.raw || `# ${isEdit ? existingName : 'New Template'}\n#\n# Describe your template\n\ntrigger:\n  source: github\n  event: pull_request.opened\n\nsteps:\n  - action: log\n    params:\n      message: "Event received"\n`;
    const name = existingName || '';

    openModal(isEdit ? `Edit Template: ${existingName}` : 'Create Template', `
        <div class="form-group" style="margin-bottom:16px">
            <label class="form-label">Template Name</label>
            <input type="text" class="form-input" id="tmpl-name" value="${esc(name)}" placeholder="my-template" ${isEdit ? 'disabled style="opacity:0.6"' : ''}>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Saved as templates/{name}.yaml</div>
        </div>
        <div class="form-group">
            <label class="form-label">Template YAML</label>
            <textarea class="form-textarea" id="tmpl-content" rows="18" style="font-family:var(--font-mono);font-size:12px;min-height:300px">${esc(content)}</textarea>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveTemplate('${esc(existingName || '')}')">${isEdit ? 'Update' : 'Create'} Template</button>
    `);
};

window.saveTemplate = async function (existingName) {
    const name = existingName || $('#tmpl-name')?.value?.trim();
    const content = $('#tmpl-content')?.value;
    if (!name) { toast('Template name is required', 'error'); return; }
    if (!content) { toast('Template content is required', 'error'); return; }

    try {
        if (existingName) {
            await api.put(`/api/templates/${encodeURIComponent(existingName)}`, { content });
            toast(`Template "${name}" updated`);
        } else {
            await api.post('/api/templates', { name, content });
            toast(`Template "${name}" created`);
        }
        closeModal();
        navigate('templates');
    } catch (err) {
        toast('Failed to save template: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.deleteTemplate = async function (name) {
    if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
    try {
        await api.del(`/api/templates/${encodeURIComponent(name)}`);
        toast(`Template "${name}" deleted`);
        navigate('templates');
    } catch (err) {
        toast('Failed to delete template: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.useTemplate = function (templateName) {
    const tmpl = templates.find((t) => t.name === templateName);
    if (!tmpl) return;
    // Open editor with template data pre-filled without modifying workflows array
    const fakeWf = {
        name: `my-${templateName}`,
        template: templateName,
        trigger: { source: tmpl.trigger?.source ?? 'github', event: tmpl.trigger?.event ?? '' },
        steps: [],
    };
    // Temporarily set, open, then clear
    const origWfs = workflows;
    workflows = [...origWfs, fakeWf];
    openWorkflowEditor();
    workflows = origWfs;
    // Set form values
    const nameEl = $('#ed-name');
    const tmplEl = $('#ed-template');
    const eventEl = $('#ed-event');
    if (nameEl) nameEl.value = `my-${templateName}`;
    if (tmplEl) { tmplEl.value = templateName; onTemplateChange(); }
    if (eventEl) eventEl.value = tmpl.trigger?.event ?? '';
    updateYamlPreview();
};

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATIONS
// ═════════════════════════════════════════════════════════════════════════════
async function renderIntegrations(el) {
    const data = await api.get('/api/integrations');
    integrations = data.integrations || {};

    const defs = [
        {
            key: 'github', icon: '🐙', name: 'GitHub (Webhooks)', desc: 'Real-time PRs, issues, pushes via webhooks', endpoint: '/webhooks/github',
            fields: [
                { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', env: 'GITHUB_WEBHOOK_SECRET', hint: 'Secret from GitHub webhook settings' },
                { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token or GitHub App token' },
            ]
        },
        {
            key: 'github-poll', icon: '🔄', name: 'GitHub (Polling)', desc: 'Poll repos for changes — no public URL needed', endpoint: '—',
            fields: [
                { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token' },
                { key: 'repos', label: 'Repositories', type: 'text', hint: 'Comma-separated: owner/repo, owner/repo2' },
                { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'Default: 60' },
            ]
        },
        {
            key: 'slack', icon: '💬', name: 'Slack', desc: 'Messages, @mentions, slash commands', endpoint: '/webhooks/slack/events',
            fields: [
                { key: 'signingSecret', label: 'Signing Secret', type: 'password', hint: 'From Slack app settings' },
                { key: 'botToken', label: 'Bot Token', type: 'password', hint: 'xoxb-... token' },
            ]
        },
        {
            key: 'webhook', icon: '🔗', name: 'Generic Webhook', desc: 'Accept JSON from any source', endpoint: '/webhooks/custom/:name',
            fields: [
                { key: 'secret', label: 'Secret (optional)', type: 'password', hint: 'HMAC validation secret' },
            ]
        },
        {
            key: 'cron', icon: '⏰', name: 'Cron', desc: 'Scheduled time-based triggers', endpoint: '—',
            fields: []
        },
    ];

    el.innerHTML = `
        <div class="page-header"><div class="page-header-left">
            <h1 class="page-title">Integrations</h1>
            <p class="page-subtitle">Connect event sources to Sokuza</p>
        </div></div>
        <div class="card-grid card-grid-3">
            ${defs.map((d) => {
        const s = integrations[d.key];
        const on = !!s?.enabled;
        return `<div class="card integration-card" style="flex-direction:column;align-items:stretch">
                    <div style="display:flex;align-items:center;gap:16px">
                        <div class="integration-icon ${d.key}">${d.icon}</div>
                        <div class="integration-info">
                            <div class="integration-name">${d.name}</div>
                            <div class="integration-desc">${d.desc}</div>
                            <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                ${on ? `<span class="badge badge-success">Active</span><span style="font-size:11px;color:var(--text-muted)">${s.events.length} events</span>` : '<span class="badge badge-warning">Not configured</span>'}
                            </div>
                        </div>
                    </div>
                    ${on ? `
                        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color)">
                            ${d.endpoint !== '—' ? `
                            <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Webhook Endpoint</div>
                            <code style="font-size:12px;color:var(--accent-hover);background:rgba(99,102,241,0.08);padding:4px 8px;border-radius:4px;display:inline-block">${d.endpoint}</code>
                            ` : ''}
                            <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;text-transform:uppercase;letter-spacing:0.4px">Supported Events</div>
                            <div class="event-tags">${s.events.map(e => `<span class="event-tag">${esc(e)}</span>`).join('')}</div>
                            <div style="margin-top:10px">
                                <button class="btn btn-ghost btn-sm" onclick="openIntegrationSetup('${d.key}')">⚙ Configure</button>
                            </div>
                        </div>
                    ` : `
                        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);display:flex;align-items:center;gap:12px">
                            <button class="btn btn-primary btn-sm" onclick="openIntegrationSetup('${d.key}')">Enable ${d.name.split(' ')[0]}</button>
                            <span style="font-size:12px;color:var(--text-muted)">Setup wizard</span>
                        </div>
                    `}
                </div>`;
    }).join('')}
        </div>
    `;
}

// ─── Integration Setup Modal ────────────────────────────────────────────────
const integrationDefs = {
    'github': {
        name: 'GitHub (Webhooks)', fields: [
            { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', env: 'GITHUB_WEBHOOK_SECRET', hint: 'Create a webhook in GitHub → Settings → Webhooks. Set this to the secret value.' },
            { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token with repo scope (Settings → Developer → PATs).' },
        ], guide: '1. Go to your repo → Settings → Webhooks → Add webhook\n2. Set Payload URL to your Sokuza URL + /webhooks/github\n3. Set Content type to application/json\n4. Set a Secret and paste it above\n5. Select events you want to receive'
    },
    'github-poll': {
        name: 'GitHub (Polling)', fields: [
            { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token with repo scope.' },
            { key: 'repos', label: 'Repositories to monitor', type: 'text', hint: 'Comma-separated owner/repo format. E.g: Tjemmic/my-app, org/other-repo' },
            { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'How often to check for changes. Default: 60. Min recommended: 30.' },
        ], guide: 'No webhook setup needed! Polling checks GitHub APIs on a timer.\n\n1. Create a Personal Access Token at github.com/settings/tokens\n2. Enter repos to monitor\n3. Set the check interval'
    },
    'slack': {
        name: 'Slack', fields: [
            { key: 'signingSecret', label: 'Signing Secret', type: 'password', hint: 'From api.slack.com → Your App → Basic Information → Signing Secret' },
            { key: 'botToken', label: 'Bot Token', type: 'password', hint: 'xoxb-... from OAuth & Permissions page' },
        ], guide: '1. Create a Slack App at api.slack.com/apps\n2. Enable Event Subscriptions and point to your Sokuza URL\n3. Install the app to your workspace'
    },
    'webhook': {
        name: 'Generic Webhook', fields: [
            { key: 'secret', label: 'HMAC Secret (optional)', type: 'password', hint: 'If set, incoming requests must include a valid HMAC signature.' },
        ], guide: 'POST JSON to /webhooks/custom/your-name to trigger workflows.\nThe request body becomes the event payload.'
    },
    'cron': { name: 'Cron', fields: [], guide: 'Cron triggers are configured per-workflow using cron expressions.\nNo integration-level config needed — just enable it.' },
};

window.openIntegrationSetup = function (key) {
    const def = integrationDefs[key];
    if (!def) return;

    const formFields = def.fields.map(f => `
        <div class="form-group">
            <label class="form-label">${esc(f.label)} ${f.env ? `<code style="font-size:10px;color:var(--text-muted);margin-left:6px">\${${f.env}}</code>` : ''}</label>
            <input type="${f.type || 'text'}" class="form-input" id="integ-${f.key}" placeholder="${esc(f.hint || '')}">
            ${f.hint ? `<div class="form-hint">${esc(f.hint)}</div>` : ''}
        </div>
    `).join('');

    const guideSteps = def.guide.split('\n').filter(l => l.trim()).map(l => `<p style="margin:2px 0">${esc(l)}</p>`).join('');

    openModal(`Setup: ${def.name}`, `
        <div class="editor-layout">
            <div>
                ${def.fields.length > 0 ? `
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Configuration</span></div>
                    <div class="panel-body">
                        ${formFields}
                        <div style="margin-top:12px;padding:10px;background:rgba(99,102,241,0.06);border-radius:var(--radius-sm);font-size:12px;color:var(--text-secondary)">
                            💡 <strong>Tip:</strong> Use environment variables (like <code>\${GITHUB_TOKEN}</code>) for secrets. Add them to your <code>.env</code> file.
                        </div>
                    </div>
                </div>
                ` : ''}
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Generated Config</span></div>
                    <div class="panel-body" style="padding:0">
                        <pre class="yaml-preview" id="integ-preview" style="min-height:60px"></pre>
                    </div>
                </div>
            </div>
            <div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Setup Guide</span></div>
                    <div class="panel-body" style="font-size:13px;color:var(--text-secondary);line-height:1.7">
                        ${guideSteps}
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-ghost" onclick="copyIntegrationConfig('${key}')">📋 Copy YAML</button>
        <button class="btn btn-primary" onclick="applyIntegrationConfig('${key}')">Apply to Config</button>
    `);

    // Generate initial preview
    updateIntegrationPreview(key);

    // Live preview on input
    def.fields.forEach(f => {
        const el = $(`#integ-${f.key}`);
        if (el) el.addEventListener('input', () => updateIntegrationPreview(key));
    });
};

function updateIntegrationPreview(key) {
    const pre = $('#integ-preview');
    if (!pre) return;
    const def = integrationDefs[key];
    let yaml = `${key}:\n`;
    for (const f of def.fields) {
        const el = $(`#integ-${f.key}`);
        const val = el?.value || (f.env ? `\${${f.env}}` : '');
        if (f.key === 'repos' && val) {
            yaml += `  repos:\n`;
            val.split(',').map(r => r.trim()).filter(Boolean).forEach(r => { yaml += `    - ${r}\n`; });
        } else if (val) {
            yaml += `  ${f.key}: ${val}\n`;
        }
    }
    pre.textContent = yaml;
}

window.copyIntegrationConfig = function (key) {
    const pre = $('#integ-preview');
    if (pre) {
        navigator.clipboard.writeText(pre.textContent);
        toast('Config YAML copied to clipboard');
    }
};

window.applyIntegrationConfig = async function (key) {
    try {
        // Get current config
        const configData = await api.get('/api/config');
        let configYaml = configData.raw || configData.yaml || '';

        // Generate the integration config text
        const pre = $('#integ-preview');
        const integConfig = pre?.textContent || '';

        // Check if integration already in config
        if (configYaml.includes(`${key}:`)) {
            toast(`"${key}" already exists in config. Edit it in Settings.`, 'error');
            return;
        }

        // Insert under integrations section
        const insertIdx = configYaml.indexOf('integrations:');
        if (insertIdx === -1) {
            configYaml += `\nintegrations:\n  ${integConfig.split('\n').join('\n  ')}`;
        } else {
            // Find the end of "integrations:" line and add after
            const lineEnd = configYaml.indexOf('\n', insertIdx);
            configYaml = configYaml.slice(0, lineEnd + 1) + `  ${integConfig.split('\n').join('\n  ')}` + configYaml.slice(lineEnd + 1);
        }

        await api.put('/api/config', { __raw_yaml: configYaml });
        toast(`${integrationDefs[key]?.name || key} added to config! Restart Sokuza to activate.`);
        closeModal();
        navigate('integrations');
    } catch (err) {
        toast('Failed to apply config: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// EVENT LOG
// ═════════════════════════════════════════════════════════════════════════════
let eventFilter = { source: '', search: '' };

async function renderEvents(el) {
    const [evtData, statsData] = await Promise.all([api.get('/api/events'), api.get('/api/events/stats')]);
    events = evtData.events || [];
    eventStats = statsData;

    const filtered = filterEvents(events);
    const sourceEntries = Object.entries(eventStats.bySource || {}).sort((a, b) => b[1] - a[1]);
    const workflowEntries = Object.entries(eventStats.byWorkflow || {}).sort((a, b) => b[1] - a[1]);
    const eventEntries = Object.entries(eventStats.byEvent || {}).sort((a, b) => b[1] - a[1]);

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Event Log</h1>
                <p class="page-subtitle">Real-time stream with history — ${events.length} events tracked</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <button class="btn btn-ghost btn-sm" onclick="exportEvents()">📥 Export JSON</button>
                <div class="status-dot online"></div>
                <span style="font-size:12px;color:var(--text-muted)">Live</span>
            </div>
        </div>

        <div class="card-grid" style="grid-template-columns:repeat(4,1fr)">
            <div class="card card-stat">
                <div class="stat-value">${eventStats.total ?? 0}</div>
                <div class="stat-label">Total Events</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${eventStats.lastHour ?? 0}</div>
                <div class="stat-label">Last Hour</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${sourceEntries.length}</div>
                <div class="stat-label">Sources</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${workflowEntries.length}</div>
                <div class="stat-label">Triggered Workflows</div>
            </div>
        </div>

        <div class="editor-layout" style="grid-template-columns:1fr 300px">
            <div>
                ${eventStats.hourlyBuckets ? `<div class="card" style="margin-bottom:16px;padding:16px 18px">
                    <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.4px">Activity (24h)</div>
                    ${renderBarChart(eventStats.hourlyBuckets)}
                </div>` : ''}

                <div class="filter-bar" style="margin-bottom:14px">
                    <select class="form-select" onchange="eventFilter.source=this.value;rerenderEventList()" style="width:140px">
                        <option value="">All sources</option>
                        ${sourceEntries.map(([s]) => `<option value="${esc(s)}" ${eventFilter.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                    </select>
                    <input type="text" class="form-input" placeholder="Search events..." value="${esc(eventFilter.search)}" oninput="eventFilter.search=this.value;rerenderEventList()" style="flex:1">
                    ${events.length > 0 ? `<button class="btn btn-ghost btn-sm" onclick="eventFilter={source:'',search:''};renderPage()">Clear</button>` : ''}
                </div>

                <div id="event-list" style="display:flex;flex-direction:column;gap:6px">
                    ${filtered.length > 0 ? filtered.slice(0, 50).map(renderEventCard).join('') : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events match your filter</p></div>'}
                </div>
            </div>

            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">By Source</span></div>
                    <div class="panel-body">
                        ${sourceEntries.length > 0 ? sourceEntries.map(([s, c]) => `<div class="stat-row" style="cursor:pointer" onclick="eventFilter.source='${esc(s)}';rerenderEventList()"><span class="stat-row-label">${sourceBadge(s)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Top Workflows</span></div>
                    <div class="panel-body">
                        ${workflowEntries.length > 0 ? workflowEntries.slice(0, 8).map(([w, c]) => `<div class="stat-row"><span class="stat-row-label" style="font-size:12px">${esc(w)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Top Events</span></div>
                    <div class="panel-body">
                        ${eventEntries.length > 0 ? eventEntries.slice(0, 8).map(([e, c]) => `<div class="stat-row"><span class="stat-row-label" style="font-size:12px;font-family:var(--mono)">${esc(e)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function filterEvents(evts) {
    return evts.filter((e) => {
        if (eventFilter.source && e.event?.source !== eventFilter.source) return false;
        if (eventFilter.search) {
            const s = eventFilter.search.toLowerCase();
            const haystack = `${e.event?.source} ${e.event?.event} ${(e.matchedWorkflows || []).join(' ')} ${JSON.stringify(e.event?.metadata || {})}`.toLowerCase();
            if (!haystack.includes(s)) return false;
        }
        return true;
    });
}

window.rerenderEventList = function () {
    const filtered = filterEvents(events);
    const list = $('#event-list');
    if (list) list.innerHTML = filtered.length > 0
        ? filtered.slice(0, 50).map(renderEventCard).join('')
        : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events match your filter</p></div>';
};

let expandedEvents = new Set();

function renderEventCard(e, idx) {
    const src = e.event?.source ?? 'unknown';
    const meta = e.event?.metadata || {};
    const metaKeys = Object.entries(meta).filter(([k]) => !['deliveryId', 'hookEvent', 'eventId'].includes(k));
    const metaStr = metaKeys.map(([k, v]) => `${k}: ${v}`).join(' · ');
    const eventId = `${e.timestamp}-${src}-${e.event?.event}`;
    const isExpanded = expandedEvents.has(eventId);
    const payload = JSON.stringify(e, null, 2);

    return `<div class="event-entry" onclick="toggleEventPayload('${esc(eventId)}')">
        <span class="event-time">${fmtDateTime(e.timestamp)}</span>
        ${sourceBadge(src)}
        <div class="event-body">
            <div class="event-name">${esc(e.event?.event ?? 'unknown')}</div>
            <div class="event-detail">${e.matchedWorkflows?.length ? `→ ${e.matchedWorkflows.map(w => esc(w)).join(', ')}` : '<span style="color:var(--text-muted)">No workflows matched</span>'}</div>
            ${metaStr ? `<div class="event-detail-meta">${esc(metaStr)}</div>` : ''}
        </div>
        ${e.matchedWorkflows?.length ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px;align-self:center" onclick="event.stopPropagation();replayEvent(${idx})" title="Replay this event">🔄</button>` : ''}
        <span style="font-size:10px;color:var(--text-muted);align-self:center">${isExpanded ? '▼' : '▶'}</span>
        <div class="event-payload ${isExpanded ? 'open' : ''}" id="payload-${esc(eventId)}" onclick="event.stopPropagation()">${esc(payload)}</div>
    </div>`;
}

window.exportEvents = function () {
    const data = JSON.stringify(events, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sokuza-events-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Events exported as JSON');
};

window.replayEvent = async function (idx) {
    const e = events[idx];
    if (!e?.matchedWorkflows?.length) { toast('No workflows to replay', 'error'); return; }
    const wfName = e.matchedWorkflows[0];
    if (!confirm(`Replay event to workflow "${wfName}"?`)) return;
    try {
        const result = await api.post(`/api/workflows/${encodeURIComponent(wfName)}/run`, { inputs: {} });
        if (result.ok) toast(`Replayed event → "${wfName}" workflow started`);
        else toast('Replay failed: ' + (result.error || 'Unknown'), 'error');
    } catch (err) {
        toast('Replay failed: ' + (err.message || 'Unknown'), 'error');
    }
};

window.toggleEventPayload = function (id) {
    if (expandedEvents.has(id)) expandedEvents.delete(id);
    else expandedEvents.add(id);
    const payloadEl = $(`#payload-${CSS.escape(id)}`);
    if (payloadEl) payloadEl.classList.toggle('open');
};

// ─── Bar Chart ──────────────────────────────────────────────────────────────
function renderBarChart(buckets) {
    const max = Math.max(...buckets.map((b) => b.count), 1);
    return `<div class="bar-chart">${buckets.map((b) => `<div class="bar-chart-bar" style="height:${Math.max((b.count / max) * 100, 2)}%" data-label="${b.hour}: ${b.count}"></div>`).join('')}</div>
    <div class="bar-chart-labels">${buckets.filter((_, i) => i % 4 === 0).map((b) => `<span>${b.hour}</span>`).join('')}</div>`;
}

// ─── Modal ──────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml, footerHtml) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-footer').innerHTML = footerHtml || '';
    $('#modal-overlay').classList.add('open');
}

function closeModal() {
    $('#modal-overlay').classList.remove('open');
}

// ─── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/events/stream');
    eventSource.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.type === 'connected') {
                const dot = $('#status-dot');
                const txt = $('#status-text');
                if (dot) dot.classList.add('online');
                if (txt) txt.textContent = 'Connected';
                return;
            }
            events.unshift(data);
            if (events.length > 500) events.pop();

            // Update event badge
            if (currentPage !== 'events') {
                unseenEventCount++;
                updateEventBadge();
            }

            // Live update event log page
            if (currentPage === 'events') {
                unseenEventCount = 0;
                updateEventBadge();
                const list = $('#event-list');
                if (list) {
                    const empty = list.querySelector('.empty-state');
                    if (empty) empty.remove();
                    list.insertAdjacentHTML('afterbegin', renderEventCard(data));
                }
            }
            // Refresh dashboard stats on new event
            if (currentPage === 'dashboard') renderPage();
        } catch { /* client parse error */ }
    };
    eventSource.onerror = () => {
        const dot = $('#status-dot');
        const txt = $('#status-text');
        if (dot) dot.classList.remove('online');
        if (txt) txt.textContent = 'Reconnecting...';
    };
}

// ─── Data Loading ───────────────────────────────────────────────────────────
async function loadAll() {
    const [wf, tmpl, intg, evt, stats] = await Promise.all([
        api.get('/api/workflows'), api.get('/api/templates'), api.get('/api/integrations'),
        api.get('/api/events'), api.get('/api/events/stats'),
    ]);
    workflows = wf.workflows || [];
    templates = tmpl.templates || [];
    integrations = intg.integrations || {};
    events = evt.events || [];
    eventStats = stats;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function fmtDateTime(ts) {
    try {
        const d = new Date(ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (isToday) return time;
        return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    } catch { return ts; }
}

function sourceBadge(src) {
    const s = src || 'unknown';
    return `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
}

function esc(s) {
    return (s ?? '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function renderSettings(el) {
    const data = await api.get('/api/config');
    const configYaml = typeof data.config === 'string' ? data.config : toYaml(data.config);

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Settings</h1>
                <p class="page-subtitle">Edit your sokuza.config.yaml directly</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost" onclick="renderPage()">↻ Reload</button>
                <button class="btn btn-primary" onclick="saveConfig()" id="save-config-btn">Save Config</button>
            </div>
        </div>

        <div class="editor-layout" style="grid-template-columns:1fr 320px">
            <div>
                <div class="code-editor">
                    <textarea id="config-editor" spellcheck="false">${esc(configYaml)}</textarea>
                    <div class="code-editor-toolbar">
                        <span>sokuza.config.yaml</span>
                        <span id="config-status">Ready</span>
                    </div>
                </div>
            </div>
            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Quick Reference</span></div>
                    <div class="panel-body" style="font-size:12px;color:var(--text-secondary);line-height:1.7">
                        <p><strong>integrations:</strong> Define event sources (github, slack, webhook, cron)</p>
                        <p style="margin-top:8px"><strong>workflows:</strong> Each workflow needs:</p>
                        <div style="padding-left:12px;color:var(--text-muted);font-family:var(--mono);font-size:11px;margin-top:4px">
                            - name: my-workflow<br>
                            &nbsp;&nbsp;trigger:<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;source: github<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;event: push<br>
                            &nbsp;&nbsp;steps:<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;- action: log<br>
                        </div>
                        <p style="margin-top:12px"><strong>Available actions:</strong></p>
                        <div class="event-tags" style="margin-top:4px">
                            ${availableActions.map(a => `<span class="event-tag">${esc(a)}</span>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Tips</span></div>
                    <div class="panel-body" style="font-size:12px;color:var(--text-secondary);line-height:1.7">
                        <p>💡 Use <code style="color:var(--accent)">template:</code> to reference a template by name instead of defining steps inline.</p>
                        <p style="margin-top:8px">🔄 Changes are saved to disk immediately — the engine reloads on the next event.</p>
                        <p style="margin-top:8px">⚠️ Invalid YAML will show an error. Double-check indentation.</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Tab key support in textarea
    const editor = $('#config-editor');
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + 2;
        }
    });
}

function toYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    let out = '';
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) {
            out += `${pad}${k}:\n`;
            for (const item of v) {
                if (typeof item === 'object') {
                    const lines = toYaml(item, indent + 2).split('\n').filter(Boolean);
                    out += `${pad}  - ${lines[0].trim()}\n`;
                    for (let i = 1; i < lines.length; i++) out += `${pad}    ${lines[i].trim()}\n`;
                } else {
                    out += `${pad}  - ${item}\n`;
                }
            }
        } else if (typeof v === 'object') {
            out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        } else {
            out += `${pad}${k}: ${v}\n`;
        }
    }
    return out;
}

window.saveConfig = async function () {
    const editor = $('#config-editor');
    const statusEl = $('#config-status');
    const saveBtn = $('#save-config-btn');
    if (!editor) return;

    const yamlText = editor.value;
    statusEl.textContent = 'Saving...';
    saveBtn.disabled = true;

    try {
        // Parse locally first to validate
        const parsed = parseSimpleYaml(yamlText);
        if (!parsed) throw new Error('Invalid YAML structure');

        const result = await api.put('/api/config', { config: parsed });
        if (result.error) throw new Error(result.error);
        statusEl.textContent = '✓ Saved';
        toast('Config saved successfully');
        setTimeout(() => { if (statusEl) statusEl.textContent = 'Ready'; }, 2000);
    } catch (err) {
        statusEl.textContent = '✗ Error';
        toast(`Save failed: ${err.message}`, 'error');
    } finally {
        saveBtn.disabled = false;
    }
};

function parseSimpleYaml(text) {
    // Send raw text to backend for YAML parsing (backend uses js-yaml)
    // We send as a JSON string to be parsed server-side
    try {
        // Basic structural validation: check it's not empty
        if (!text.trim()) return null;
        // The backend already accepts a config object, but we've been
        // serializing/deserializing. For the settings editor, let's
        // just send the raw text as a JSON structure the backend accepts.
        // Actually the PUT /api/config expects { config: object }, so
        // we need to do a simple parse. We'll use a fetch to re-read
        // after save, or we can just send raw and let the backend handle it.
        // For now, return a marker that signals raw yaml.
        return { __raw_yaml: text };
    } catch { return null; }
}

// ─── Event Badge ────────────────────────────────────────────────────────────
let unseenEventCount = 0;
function updateEventBadge() {
    const badge = $('#event-badge');
    if (!badge) return;
    if (unseenEventCount > 0 && currentPage !== 'events') {
        badge.style.display = '';
        badge.textContent = unseenEventCount > 99 ? '99+' : unseenEventCount;
    } else {
        badge.style.display = 'none';
        unseenEventCount = 0;
    }
}

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Skip if in a text input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
    }
    if (e.key === 'Escape') {
        const confirmEl = document.querySelector('.confirm-overlay');
        if (confirmEl) { confirmEl.remove(); return; }
        if ($('#modal-overlay')?.classList.contains('open')) { closeModal(); return; }
    }
    // Navigation shortcuts: Alt+1-6
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const pages = ['dashboard', 'workflows', 'templates', 'integrations', 'events', 'settings'];
        const num = parseInt(e.key);
        if (num >= 1 && num <= 6) { e.preventDefault(); navigate(pages[num - 1]); }
    }
});

// ─── Init ───────────────────────────────────────────────────────────────────
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (e) => { if (e.target === $('#modal-overlay')) closeModal(); });
$$('.nav-link').forEach((link) => link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.dataset.page); }));

window.navigate = navigate;

// Hash routing: restore page from URL hash
const validPages = ['dashboard', 'workflows', 'templates', 'integrations', 'events', 'settings'];
const hashPage = window.location.hash.replace('#', '');
if (validPages.includes(hashPage)) currentPage = hashPage;
window.addEventListener('hashchange', () => {
    const p = window.location.hash.replace('#', '');
    if (validPages.includes(p) && p !== currentPage) navigate(p);
});

connectSSE();
navigate(currentPage);
