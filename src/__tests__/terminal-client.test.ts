// @vitest-environment jsdom
//
// Frontend smoke tests for dashboard/terminal.js. It's a classic-script IIFE
// that reads app.js globals (api, $) and browser globals (WebSocket, Terminal,
// FitAddon) at call time, so we stub those, eval the file to install
// window.renderTerminal/handleTerminalEvent, and exercise the key flows:
//   - render builds the toolbar and loads sessions + pending asks
//   - spawn mints a ticket BEFORE opening the WebSocket, with the ticket in URL
//   - transcript events render into the feed
//   - answering an MCP ask POSTs to the answer endpoint
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const terminalSrc = readFileSync(join(here, '../../dashboard/terminal.js'), 'utf8');

// Records of api calls for assertions.
let calls: Array<{ method: string; path: string; body?: any }>;
let wsInstances: FakeWebSocket[];

class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: any; onmessage: any; onclose: any;
    sent: string[] = [];
    constructor(public url: string) { wsInstances.push(this); }
    send(d: string) { this.sent.push(d); }
    close() { /* noop */ }
}

class FakeTerm {
    cols = 80; rows = 24;
    loadAddon() {} open() {} onData() {} reset() {} focus() {} write() {}
}

function installGlobals() {
    calls = [];
    wsInstances = [];
    (globalThis as any).$ = (s: string) => document.querySelector(s);
    (globalThis as any).WebSocket = FakeWebSocket;
    (window as any).Terminal = FakeTerm;
    (window as any).FitAddon = { FitAddon: class { fit() {} } };
    (window as any).alert = () => {};
    (globalThis as any).api = {
        get: async (path: string) => {
            calls.push({ method: 'GET', path });
            if (path === '/api/pty/sessions') return { sessions: [] };
            if (path === '/api/mcp/asks') return { asks: [] };
            return {};
        },
        post: async (path: string, body?: any) => {
            calls.push({ method: 'POST', path, body });
            if (path === '/api/pty/spawn') return { session: { id: 'sess1', command: 'bash', pid: 1 } };
            if (path === '/api/pty/ticket') return { ticket: 'TICKET123' };
            return { ok: true };
        },
        del: async (path: string) => { calls.push({ method: 'DELETE', path }); return { ok: true }; },
    };
}

beforeEach(() => {
    document.body.innerHTML = '<div id="content"></div>';
    installGlobals();
    // (Re)install the IIFE — it reassigns window.renderTerminal etc.
    // eslint-disable-next-line no-eval
    (0, eval)(terminalSrc);
});

const content = () => document.getElementById('content')!;

describe('terminal.js render', () => {
    it('builds the toolbar and loads sessions + pending asks', async () => {
        await (window as any).renderTerminal(content());
        expect(document.getElementById('term-command')).toBeTruthy();
        expect(document.getElementById('term-spawn')).toBeTruthy();
        expect(calls.some((c) => c.path === '/api/pty/sessions')).toBe(true);
        expect(calls.some((c) => c.path === '/api/mcp/asks')).toBe(true);
    });
});

describe('terminal.js spawn → ticket → WebSocket ordering', () => {
    it('mints a ticket before opening the socket, with the ticket in the URL', async () => {
        await (window as any).renderTerminal(content());
        (document.getElementById('term-command') as HTMLSelectElement).value = 'bash';
        (document.getElementById('term-spawn') as HTMLButtonElement).click();
        // let the async spawn/attach chain settle
        await new Promise((r) => setTimeout(r, 20));

        const spawnIdx = calls.findIndex((c) => c.path === '/api/pty/spawn');
        const ticketIdx = calls.findIndex((c) => c.path === '/api/pty/ticket');
        expect(spawnIdx).toBeGreaterThanOrEqual(0);
        expect(ticketIdx).toBeGreaterThan(spawnIdx); // ticket minted AFTER spawn
        expect(wsInstances).toHaveLength(1);
        expect(wsInstances[0].url).toContain('/api/pty/sess1');
        expect(wsInstances[0].url).toContain('ticket=TICKET123');
        // The long-lived bearer token (`?t=`/`&t=`) must NOT be in the URL.
        expect(/[?&]t=/.test(wsInstances[0].url)).toBe(false);
    });
});

describe('terminal.js event handling', () => {
    it('renders cli-transcript events into the feed', async () => {
        await (window as any).renderTerminal(content());
        (window as any).handleTerminalEvent({
            type: 'cli-transcript', project: 'proj', sessionId: 's', role: 'user', preview: 'hello world',
        });
        const feed = document.getElementById('term-transcripts')!;
        expect(feed.textContent).toContain('hello world');
    });

    it('renders an MCP ask and POSTs the answer', async () => {
        await (window as any).renderTerminal(content());
        (window as any).handleTerminalEvent({ type: 'mcp-ask', id: 'ask1', prompt: 'proceed?', source: 'cc' });
        const askRow = document.querySelector('.mcp-ask') as HTMLElement;
        expect(askRow).toBeTruthy();
        expect(askRow.textContent).toContain('proceed?');

        (askRow.querySelector('.mcp-ask-input') as HTMLInputElement).value = 'yes';
        (askRow.querySelector('.mcp-ask-send') as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 20));
        expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mcp/ask/ask1/answer' && c.body?.answer === 'yes')).toBe(true);
    });
});
