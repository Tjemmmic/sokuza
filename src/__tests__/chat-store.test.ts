import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { ChatStore } from '../core/chat-store.js';

const silent = pino({ level: 'silent' });

describe('ChatStore', () => {
    let dir: string;
    let store: ChatStore;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'sokuza-chat-test-'));
        store = new ChatStore(silent, dir);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('creates a session with auto-derived title for each scope', async () => {
        const repoSession = await store.createSession({
            scope: { kind: 'repo', repo: 'owner/repo' },
            provider: 'zai-glm',
        });
        expect(repoSession.title).toBe('owner/repo');
        expect(repoSession.workdir).toContain(repoSession.id);

        const branchSession = await store.createSession({
            scope: { kind: 'branch', repo: 'owner/repo', ref: 'main' },
            provider: 'zai-glm',
        });
        expect(branchSession.title).toBe('owner/repo @ main');

        const prSession = await store.createSession({
            scope: { kind: 'pr', repo: 'owner/repo', ref: 'feat/x', prNumber: 42, title: 'My feature' },
            provider: 'zai-glm',
        });
        expect(prSession.title).toBe('PR #42: My feature');
    });

    it('respects an explicit title override', async () => {
        const s = await store.createSession({
            scope: { kind: 'repo', repo: 'owner/repo' },
            provider: 'zai-glm',
            title: 'My custom thread',
        });
        expect(s.title).toBe('My custom thread');
    });

    it('lists sessions newest-first', async () => {
        const a = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        // Space them apart so timestamps differ reliably.
        await new Promise((r) => setTimeout(r, 10));
        const b = await store.createSession({ scope: { kind: 'repo', repo: 'b/b' }, provider: 'zai-glm' });
        const list = await store.listSessions();
        expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    });

    it('appends messages in order and reloads them verbatim', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });

        const sent = [
            { role: 'system' as const, content: 'Seed context' },
            { role: 'user' as const, content: 'hi' },
            { role: 'assistant' as const, content: 'hello!' },
        ];
        const appended = [];
        for (const m of sent) appended.push(await store.appendMessage(s.id, m));

        const loaded = await store.getMessages(s.id);
        expect(loaded).toHaveLength(3);
        expect(loaded.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
        expect(loaded.map((m) => m.content)).toEqual(['Seed context', 'hi', 'hello!']);
        // Persisted IDs should match what appendMessage returned.
        expect(loaded.map((m) => m.id)).toEqual(appended.map((a) => a.id));
    });

    it('preserves toolCall and toolResult round-trip', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        await store.appendMessage(s.id, {
            role: 'assistant',
            content: '',
            toolCall: { id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
        });
        await store.appendMessage(s.id, {
            role: 'tool',
            content: '# Readme',
            toolResult: { callId: 'tu_1', output: '# Readme', isError: false },
        });
        const msgs = await store.getMessages(s.id);
        expect(msgs[0].toolCall?.name).toBe('read_file');
        expect(msgs[0].toolCall?.input).toEqual({ path: 'README.md' });
        expect(msgs[1].toolResult?.callId).toBe('tu_1');
        expect(msgs[1].toolResult?.output).toBe('# Readme');
    });

    it('updates session metadata and bumps updatedAt', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        await new Promise((r) => setTimeout(r, 10));
        const patched = await store.updateSession(s.id, { title: 'Renamed' });
        expect(patched?.title).toBe('Renamed');
        expect(patched!.updatedAt > s.updatedAt).toBe(true);
    });

    it('deleteSession removes the entire session tree', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        const ok = await store.deleteSession(s.id);
        expect(ok).toBe(true);
        expect(await store.getSession(s.id)).toBeNull();
        expect(await store.deleteSession(s.id)).toBe(false);
    });

    it('skips corrupt lines in messages.jsonl without crashing', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        await store.appendMessage(s.id, { role: 'user', content: 'valid' });
        // Hand-write a broken line between valid ones.
        const { appendFile } = await import('node:fs/promises');
        await appendFile(join(dir, s.id, 'messages.jsonl'), '{ not valid json\n', 'utf-8');
        await store.appendMessage(s.id, { role: 'assistant', content: 'also valid' });

        const msgs = await store.getMessages(s.id);
        expect(msgs).toHaveLength(2);
        expect(msgs.map((m) => m.content)).toEqual(['valid', 'also valid']);
    });

    it('serializes concurrent appends within a session', async () => {
        const s = await store.createSession({ scope: { kind: 'repo', repo: 'a/a' }, provider: 'zai-glm' });
        // Fire 10 appends concurrently — they should all land in order.
        const indices = Array.from({ length: 10 }, (_, i) => i);
        await Promise.all(indices.map((i) =>
            store.appendMessage(s.id, { role: 'user', content: `msg ${i}` })
        ));
        const msgs = await store.getMessages(s.id);
        expect(msgs).toHaveLength(10);
        // Content ordering isn't strictly guaranteed by Promise.all submission
        // order, but every entry must be one of the 10 we wrote (no dropped,
        // no partially-written lines).
        const contents = new Set(msgs.map((m) => m.content));
        for (const i of indices) expect(contents.has(`msg ${i}`)).toBe(true);
    });
});
