import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { PTYManager, DEFAULT_ALLOWED_COMMANDS } from '../core/pty-manager.js';

const logger = pino({ level: 'silent' });

describe('PTYManager allow-list', () => {
    afterEach(() => { delete process.env.SOKUZA_PTY_ALLOWED_COMMANDS; });

    it('permits the default developer CLIs and rejects others', () => {
        const m = new PTYManager(logger);
        for (const cmd of DEFAULT_ALLOWED_COMMANDS) expect(m.isAllowed(cmd)).toBe(true);
        expect(m.isAllowed('rm')).toBe(false);
        // Path-qualified commands are rejected even when the basename is
        // allowed — otherwise /tmp/bash would bypass the allow-list.
        expect(m.isAllowed('/usr/bin/bash')).toBe(false);
        expect(m.isAllowed('./bash')).toBe(false);
        expect(m.isAllowed('/tmp/bash')).toBe(false);
        expect(m.isAllowed('/usr/bin/rm')).toBe(false);
    });

    it('allows path-qualified commands only when the allow-list is "*"', () => {
        process.env.SOKUZA_PTY_ALLOWED_COMMANDS = '*';
        const m = new PTYManager(logger);
        expect(m.isAllowed('/tmp/anything')).toBe(true);
    });

    it('honours an env override', () => {
        process.env.SOKUZA_PTY_ALLOWED_COMMANDS = 'foo, bar';
        const m = new PTYManager(logger);
        expect(m.isAllowed('foo')).toBe(true);
        expect(m.isAllowed('bash')).toBe(false);
    });

    it('allows everything when the override is "*"', () => {
        process.env.SOKUZA_PTY_ALLOWED_COMMANDS = '*';
        const m = new PTYManager(logger);
        expect(m.isAllowed('anything')).toBe(true);
        expect(m.allowedCommands()).toBe('*');
    });
});

describe('PTYManager.createSession validation', () => {
    it('rejects a disallowed command', async () => {
        const m = new PTYManager(logger);
        await expect(m.createSession({ command: 'rm', cwd: process.cwd() }))
            .rejects.toThrow(/not allowed/);
    });

    it('rejects a missing cwd', async () => {
        const m = new PTYManager(logger);
        await expect(m.createSession({ command: 'bash', cwd: '/no/such/dir/here' }))
            .rejects.toThrow(/cwd does not exist/);
    });

    it('rejects an empty command', async () => {
        const m = new PTYManager(logger);
        await expect(m.createSession({ command: '   ', cwd: process.cwd() }))
            .rejects.toThrow(/command is required/);
    });
});

describe('PTYManager lifecycle (real PTY)', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sokuza-pty-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('spawns, streams output, and reports exit', async () => {
        const m = new PTYManager(logger);
        const output: string[] = [];
        m.on('data', (_id, chunk: string) => output.push(chunk));

        const exited = new Promise<number>((resolve) => {
            m.on('exit', (_id, code: number) => resolve(code));
        });

        const info = await m.createSession({
            command: 'bash',
            args: ['-c', 'printf SOKUZA_OK; exit 3'],
            cwd: dir,
        });
        expect(info.status).toBe('running');
        expect(info.pid).toBeGreaterThan(0);
        expect(m.list().some((s) => s.id === info.id)).toBe(true);

        const code = await withTimeout(exited, 8000);
        expect(code).toBe(3);
        expect(output.join('')).toContain('SOKUZA_OK');

        // After exit the session is excluded from list() (no stale rows) but
        // remains readable via get() for a late attach to read the exit code.
        expect(m.list().some((s) => s.id === info.id)).toBe(false);
        expect(m.get(info.id)?.status).toBe('exited');
    });

    it('writes input to a session and kills it', async () => {
        const m = new PTYManager(logger);
        const info = await m.createSession({ command: 'bash', args: ['-i'], cwd: dir });
        expect(() => m.write(info.id, 'echo hi\n')).not.toThrow();
        expect(m.kill(info.id)).toBe(true);
        expect(m.get(info.id)).toBeUndefined();
    });

    it('caps concurrent running sessions (SOKUZA_PTY_MAX_SESSIONS)', async () => {
        process.env.SOKUZA_PTY_MAX_SESSIONS = '2';
        try {
            const m = new PTYManager(logger);
            const a = await m.createSession({ command: 'bash', args: ['-i'], cwd: dir });
            const b = await m.createSession({ command: 'bash', args: ['-i'], cwd: dir });
            await expect(m.createSession({ command: 'bash', args: ['-i'], cwd: dir }))
                .rejects.toThrow(/maximum concurrent/);
            // Killing one frees a slot.
            m.kill(a.id);
            const c = await m.createSession({ command: 'bash', args: ['-i'], cwd: dir });
            expect(c.id).toBeTruthy();
            m.killAll();
            void b;
        } finally {
            delete process.env.SOKUZA_PTY_MAX_SESSIONS;
        }
    });
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}
