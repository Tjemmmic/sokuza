// ─── Sokuza Dashboard — Terminal Console + CLI Transcripts ──────────────────
// Loaded as a classic script AFTER app.js, so it shares app.js's global lexical
// scope (`api`, `dashboardToken`, `$`). Exposes a few functions on `window` for
// app.js to call: renderTerminal, renderCliTranscriptsFeed, handleTerminalEvent.
//
// - Terminal Console: spawn an interactive CLI in a host PTY and drive it via
//   xterm.js over a WebSocket (/api/pty/:id).
// - CLI Transcripts: a live, in-memory feed of locally-run Claude Code session
//   entries broadcast over the event stream (type: 'cli-transcript').
// - MCP bridge: surface `sokuza_ask_human` questions and let a human answer.

(() => {
    'use strict';

    const MAX_TRANSCRIPTS = 200;
    const COMMAND_PRESETS = [
        { value: 'claude', label: 'Claude Code' },
        { value: 'gemini', label: 'Gemini CLI' },
        { value: 'opencode', label: 'opencode' },
        { value: 'codex', label: 'Codex' },
        { value: '', label: 'Shell' }, // empty → server picks $SHELL
    ];

    // Live state (module-scoped).
    let term = null;
    let fitAddon = null;
    let socket = null;
    let activeSessionId = null;
    let resizeHandlerBound = false;
    const transcripts = []; // newest-last ring buffer
    const pendingAsks = new Map(); // id -> { prompt, source }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function token() {
        try {
            if (typeof dashboardToken === 'string' && dashboardToken) return dashboardToken;
        } catch { /* not in scope yet */ }
        try { return localStorage.getItem('sokuza:dashboardToken') || ''; } catch { return ''; }
    }

    function wsUrl(id) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${location.host}/api/pty/${encodeURIComponent(id)}?t=${encodeURIComponent(token())}`;
    }

    function librariesReady() {
        return typeof window.Terminal === 'function'
            && window.FitAddon && typeof window.FitAddon.FitAddon === 'function';
    }

    // ─── Page render ──────────────────────────────────────────────────────────

    async function renderTerminal(el) {
        let sessions = [];
        try {
            sessions = (await api.get('/api/pty/sessions')).sessions || [];
        } catch { /* engine may be momentarily unavailable */ }

        el.innerHTML = `
            <div class="page-header">
                <div class="page-header-left">
                    <h1 class="page-title">Terminal</h1>
                    <p class="page-subtitle">Run an interactive CLI in a real PTY on the Sokuza host. Output streams here live.</p>
                </div>
            </div>

            ${librariesReady() ? '' : `
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <p class="empty-text">Terminal libraries failed to load (offline?). The xterm.js assets are loaded from a CDN.</p>
                </div>`}

            <div class="term-toolbar">
                <select id="term-command" class="input input-sm">
                    ${COMMAND_PRESETS.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}
                </select>
                <input id="term-cwd" class="input input-sm" placeholder="working directory (optional)" style="flex:1;min-width:180px">
                <button id="term-spawn" class="btn btn-primary btn-sm">▶ Spawn</button>
                <button id="term-kill" class="btn btn-ghost btn-sm" disabled>■ Kill</button>
            </div>

            <div id="term-sessions" class="term-sessions"></div>

            <div class="terminal-frame">
                <div id="term-host" class="terminal-host"></div>
            </div>

            <div id="mcp-asks" class="mcp-asks"></div>

            <div class="panel" style="margin-top:18px">
                <div class="panel-header"><span class="panel-title">CLI Transcripts</span></div>
                <div class="panel-body" id="term-transcripts"></div>
            </div>
        `;

        renderSessionList(sessions);
        renderAsks();
        renderTranscripts($('#term-transcripts'));

        $('#term-spawn').addEventListener('click', spawnFromToolbar);
        $('#term-kill').addEventListener('click', killActive);

        if (!resizeHandlerBound) {
            window.addEventListener('resize', () => { try { fitAddon?.fit(); sendResize(); } catch { /* */ } });
            window.addEventListener('hashchange', onHashChange);
            resizeHandlerBound = true;
        }
    }

    function renderSessionList(sessions) {
        const host = $('#term-sessions');
        if (!host) return;
        if (!sessions.length) {
            host.innerHTML = '<span class="term-hint">No active sessions.</span>';
            return;
        }
        host.innerHTML = sessions.map((s) => `
            <button class="term-session-chip ${s.id === activeSessionId ? 'active' : ''}" data-id="${esc(s.id)}">
                ${esc(s.label || s.command)} <span class="term-session-pid">#${esc(s.pid)}</span>
            </button>
        `).join('');
        host.querySelectorAll('.term-session-chip').forEach((b) => {
            b.addEventListener('click', () => attach(b.dataset.id));
        });
    }

    // ─── Spawn / attach / detach ──────────────────────────────────────────────

    async function spawnFromToolbar() {
        const command = $('#term-command').value;
        const cwd = $('#term-cwd').value.trim();
        const body = {};
        if (command) body.command = command;
        if (cwd) body.cwd = cwd;
        try {
            const { session } = await api.post('/api/pty/spawn', body);
            await refreshSessions();
            attach(session.id);
        } catch (err) {
            alert(`Failed to spawn: ${err.message || err}`);
        }
    }

    async function refreshSessions() {
        try {
            const { sessions } = await api.get('/api/pty/sessions');
            renderSessionList(sessions || []);
        } catch { /* */ }
    }

    function ensureTerminal() {
        if (!librariesReady()) return false;
        const hostEl = $('#term-host');
        if (!hostEl) return false;
        if (!term) {
            term = new window.Terminal({
                fontFamily: 'var(--mono), monospace',
                fontSize: 13,
                cursorBlink: true,
                theme: { background: '#0a0e17', foreground: '#f1f5f9', cursor: '#6366f1' },
            });
            fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(hostEl);
            term.onData((data) => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'input', data }));
                }
            });
        }
        try { fitAddon.fit(); } catch { /* not visible yet */ }
        return true;
    }

    function attach(id) {
        if (!id) return;
        if (!ensureTerminal()) return;
        detachSocket();
        activeSessionId = id;
        term.reset();
        term.focus();

        socket = new WebSocket(wsUrl(id));
        socket.onopen = () => sendResize();
        socket.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'output') term.write(msg.data);
            else if (msg.type === 'ready') sendResize();
            else if (msg.type === 'exit') term.write(`\r\n\x1b[33m[process exited${msg.exitCode != null ? ` (${msg.exitCode})` : ''}]\x1b[0m\r\n`);
            else if (msg.type === 'error') term.write(`\r\n\x1b[31m[${esc(msg.error)}]\x1b[0m\r\n`);
        };
        socket.onclose = () => {
            const kill = $('#term-kill');
            if (kill) kill.disabled = activeSessionId == null;
        };
        const kill = $('#term-kill');
        if (kill) kill.disabled = false;
        refreshSessions();
    }

    function sendResize() {
        if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }

    function detachSocket() {
        if (socket) {
            try { socket.onclose = null; socket.close(); } catch { /* */ }
            socket = null;
        }
    }

    async function killActive() {
        if (!activeSessionId) return;
        const id = activeSessionId;
        detachSocket();
        try { await api.del(`/api/pty/${encodeURIComponent(id)}`); } catch { /* */ }
        activeSessionId = null;
        const kill = $('#term-kill');
        if (kill) kill.disabled = true;
        refreshSessions();
    }

    function onHashChange() {
        // Leaving the terminal page: drop the socket so it doesn't leak. The
        // PTY session itself keeps running on the host and can be re-attached.
        if (location.hash.replace('#', '') !== 'terminal') {
            detachSocket();
            activeSessionId = null;
        }
    }

    // ─── CLI transcripts feed ─────────────────────────────────────────────────

    function renderTranscripts(container) {
        if (!container) return;
        if (!transcripts.length) {
            container.innerHTML = '<span class="term-hint">No CLI activity yet. Run Claude Code locally and it will appear here live.</span>';
            return;
        }
        container.innerHTML = transcripts.slice(-80).reverse().map((t) => `
            <div class="transcript-row">
                <span class="transcript-meta">${esc(t.role || t.entryType || 'entry')} · ${esc(t.project)}</span>
                ${t.preview ? `<span class="transcript-text">${esc(t.preview)}</span>` : ''}
            </div>
        `).join('');
    }

    // Called by app.js when rendering the Auto-Fix page.
    function renderCliTranscriptsFeed(container) {
        renderTranscripts(container);
    }

    // ─── MCP human-in-the-loop asks ───────────────────────────────────────────

    function renderAsks() {
        const host = $('#mcp-asks');
        if (!host) return;
        if (!pendingAsks.size) { host.innerHTML = ''; return; }
        host.innerHTML = [...pendingAsks.entries()].map(([id, a]) => `
            <div class="mcp-ask" data-id="${esc(id)}">
                <div class="mcp-ask-prompt">🤖 ${esc(a.source || 'CLI')} asks: ${esc(a.prompt)}</div>
                <div class="mcp-ask-form">
                    <input class="input input-sm mcp-ask-input" placeholder="Your answer…" style="flex:1">
                    <button class="btn btn-primary btn-sm mcp-ask-send">Answer</button>
                </div>
            </div>
        `).join('');
        host.querySelectorAll('.mcp-ask').forEach((row) => {
            const id = row.dataset.id;
            const send = async () => {
                const input = row.querySelector('.mcp-ask-input');
                const answer = input.value.trim();
                if (!answer) return;
                try {
                    await api.post(`/api/mcp/ask/${encodeURIComponent(id)}/answer`, { answer });
                    pendingAsks.delete(id);
                    renderAsks();
                } catch (err) {
                    alert(`Failed to answer: ${err.message || err}`);
                }
            };
            row.querySelector('.mcp-ask-send').addEventListener('click', send);
            row.querySelector('.mcp-ask-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') send();
            });
        });
    }

    // ─── Event stream handler (called by app.js) ──────────────────────────────

    function handleTerminalEvent(data) {
        if (data.type === 'cli-transcript') {
            transcripts.push(data);
            if (transcripts.length > MAX_TRANSCRIPTS) transcripts.shift();
            renderTranscripts($('#term-transcripts'));
            renderTranscripts($('#auto-fix-cli-transcripts'));
        } else if (data.type === 'mcp-status') {
            transcripts.push({
                role: `status:${data.level || 'info'}`,
                project: data.source || 'mcp',
                preview: data.message,
            });
            if (transcripts.length > MAX_TRANSCRIPTS) transcripts.shift();
            renderTranscripts($('#term-transcripts'));
            renderTranscripts($('#auto-fix-cli-transcripts'));
        } else if (data.type === 'mcp-ask') {
            pendingAsks.set(data.id, { prompt: data.prompt, source: data.source });
            renderAsks();
        } else if (data.type === 'mcp-ask-answered') {
            pendingAsks.delete(data.id);
            renderAsks();
        }
    }

    // Expose the bits app.js calls.
    window.renderTerminal = renderTerminal;
    window.renderCliTranscriptsFeed = renderCliTranscriptsFeed;
    window.handleTerminalEvent = handleTerminalEvent;
})();
