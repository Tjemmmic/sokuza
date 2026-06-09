import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SessionWatcher, buildEvent, type TranscriptEvent } from '../core/session-watcher.js';

const logger = pino({ level: 'silent' });

describe('buildEvent / preview extraction', () => {
    it('extracts a string message content', () => {
        const e = buildEvent({ type: 'user', message: { role: 'user', content: 'hello there' } }, 'proj', 'sess');
        expect(e.entryType).toBe('user');
        expect(e.role).toBe('user');
        expect(e.preview).toBe('hello there');
        expect(e.type).toBe('cli-transcript');
    });

    it('extracts the text part from array content', () => {
        const e = buildEvent({
            message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
        }, 'proj', 'sess');
        expect(e.preview).toBe('an answer');
        expect(e.role).toBe('assistant');
    });

    it('summarises tool_use content', () => {
        const e = buildEvent({
            message: { content: [{ type: 'tool_use', name: 'Bash' }] },
        }, 'proj', 'sess');
        expect(e.preview).toBe('[tool_use: Bash]');
    });

    it('falls back to a summary field', () => {
        const e = buildEvent({ type: 'summary', summary: 'session recap' }, 'proj', 'sess');
        expect(e.preview).toBe('session recap');
    });

    it('returns a minimal, well-formed event for non-object JSON lines', () => {
        for (const v of [42, 'a bare string', [1, 2, 3], true]) {
            const e = buildEvent(v, 'proj', 'sess');
            expect(e.type).toBe('cli-transcript');
            expect(e.project).toBe('proj');
            expect(e.sessionId).toBe('sess');
            expect(e.preview).toBeUndefined();
            expect(e.role).toBeUndefined();
        }
    });

    it('truncates long previews', () => {
        const long = 'x'.repeat(2000);
        const e = buildEvent({ message: { content: long } }, 'proj', 'sess');
        expect(e.preview!.length).toBeLessThanOrEqual(501);
        expect(e.preview!.endsWith('…')).toBe(true);
    });
});

describe('SessionWatcher.ingest (byte-offset tailing)', () => {
    let dir: string;
    let events: TranscriptEvent[];
    let watcher: SessionWatcher;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'sokuza-watch-'));
        events = [];
        watcher = new SessionWatcher({ logger, rootDir: dir, onEvent: (e) => events.push(e) });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('emits one event per complete appended line, tracking the offset', async () => {
        const projectDir = join(dir, 'proj');
        await mkdir(projectDir, { recursive: true });
        const file = join(projectDir, 'sess.jsonl');

        await writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } }) + '\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(1);
        expect(events[0].preview).toBe('one');
        expect(events[0].project).toBe('proj');
        expect(events[0].sessionId).toBe('sess');

        // Append more — only the new line should be emitted.
        await appendFile(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'two' } }) + '\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(2);
        expect(events[1].preview).toBe('two');
    });

    it('does not emit a partial (newline-less) trailing line until it completes', async () => {
        const file = join(dir, 'partial.jsonl');
        await writeFile(file, '{"type":"user","message":{"content":"complete"}}\n{"type":"user","message":{"content":"part');
        await watcher.ingest(file);
        expect(events).toHaveLength(1);
        expect(events[0].preview).toBe('complete');

        // Finish the partial line.
        await appendFile(file, 'ial"}}\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(2);
        expect(events[1].preview).toBe('partial');
    });

    it('skips malformed JSON lines without throwing', async () => {
        const file = join(dir, 'bad.jsonl');
        await writeFile(file, 'not json\n{"type":"user","message":{"content":"ok"}}\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(1);
        expect(events[0].preview).toBe('ok');
    });

    it('ignores non-jsonl files', async () => {
        const file = join(dir, 'notes.txt');
        await writeFile(file, '{"a":1}\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(0);
    });

    it('wires chokidar so a newly written .jsonl file emits an event', async () => {
        await watcher.start();
        try {
            const proj = join(dir, 'proj');
            await mkdir(proj, { recursive: true });
            await writeFile(join(proj, 'live.jsonl'),
                JSON.stringify({ message: { content: 'live-line' } }) + '\n');

            const deadline = Date.now() + 4000;
            while (Date.now() < deadline && !events.some((e) => e.preview === 'live-line')) {
                await new Promise((r) => setTimeout(r, 50));
            }
            expect(events.some((e) => e.preview === 'live-line')).toBe(true);
        } finally {
            await watcher.stop();
        }
    });

    it('creates the transcript root if it does not exist yet (first-run path)', async () => {
        const sub = join(dir, 'nested', 'projects');
        expect(existsSync(sub)).toBe(false);
        const w = new SessionWatcher({ logger, rootDir: sub, onEvent: (e) => events.push(e) });
        await w.start();
        expect(existsSync(sub)).toBe(true);
        await w.stop();
    });

    it('does not replay pre-existing content after start() seeds offsets', async () => {
        const file = join(dir, 'pre.jsonl');
        await writeFile(file, JSON.stringify({ message: { content: 'old' } }) + '\n');

        await watcher.start(); // seeds offset to the current file size
        await watcher.ingest(file);
        expect(events).toHaveLength(0); // nothing new since seed

        await appendFile(file, JSON.stringify({ message: { content: 'fresh' } }) + '\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(1);
        expect(events[0].preview).toBe('fresh');

        await watcher.stop();
    });

    it('resets the offset when a file is truncated', async () => {
        const file = join(dir, 'rot.jsonl');
        await writeFile(file, JSON.stringify({ message: { content: 'first' } }) + '\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(1);

        // Truncate + rewrite shorter content (offset now exceeds length).
        await writeFile(file, JSON.stringify({ message: { content: 'new' } }) + '\n');
        await watcher.ingest(file);
        expect(events).toHaveLength(2);
        expect(events[1].preview).toBe('new');
    });
});
