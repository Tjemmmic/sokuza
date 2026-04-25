import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { WorkdirManager, type WorkdirMeta } from '../core/workdir-store.js';

const logger = pino({ level: 'silent' });

const META: WorkdirMeta = {
    owner: 'acme',
    repo: 'platform',
    prNumber: 42,
    headSha: 'abc',
    headRef: 'feat/x',
    clonedAt: '2026-04-25T10:00:00.000Z',
    lastSyncAt: '2026-04-25T10:00:00.000Z',
};

describe('WorkdirManager', () => {
    let root: string;
    let manager: WorkdirManager;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'sokuza-workdir-'));
        manager = new WorkdirManager(logger, root, 'test-instance');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('returns null for getMeta when nothing has been written', async () => {
        expect(await manager.getMeta('acme', 'platform', 42)).toBeNull();
    });

    it('round-trips meta', async () => {
        await manager.writeMeta(META);
        const got = await manager.getMeta('acme', 'platform', 42);
        expect(got).toEqual(META);
    });

    it('list returns nothing when base dir is missing', async () => {
        await rm(root, { recursive: true, force: true });
        expect(await manager.list()).toEqual([]);
    });

    it('list reports written workdirs with sizes', async () => {
        await manager.writeMeta(META);
        const repoDir = manager.repoPath('acme', 'platform', 42);
        await mkdir(repoDir, { recursive: true });
        await writeFile(join(repoDir, 'README.md'), 'x'.repeat(1234), 'utf-8');

        const list = await manager.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ owner: 'acme', repo: 'platform', prNumber: 42, locked: false });
        expect(list[0].sizeBytes).toBeGreaterThanOrEqual(1234);
    });

    describe('locking', () => {
        it('acquires and releases', async () => {
            const release = await manager.acquire('acme', 'platform', 42);
            const lockPath = join(root, 'acme', 'platform', '42', '.sokuza-lock');
            expect(existsSync(lockPath)).toBe(true);
            await release();
            expect(existsSync(lockPath)).toBe(false);
        });

        it('refuses a second acquire while live', async () => {
            const release = await manager.acquire('acme', 'platform', 42);
            await expect(manager.acquire('acme', 'platform', 42)).rejects.toThrow(/locked/);
            await release();
        });

        it('reclaims a stale lock with expired lease', async () => {
            const dir = join(root, 'acme', 'platform', '42');
            await mkdir(dir, { recursive: true });
            const stale = {
                pid: 999_999_999,
                instanceId: 'foreign-and-dead',
                leaseUntil: '2020-01-01T00:00:00.000Z',
            };
            await writeFile(join(dir, '.sokuza-lock'), JSON.stringify(stale), 'utf-8');

            const release = await manager.acquire('acme', 'platform', 42);
            const lock = JSON.parse(await readFile(join(dir, '.sokuza-lock'), 'utf-8'));
            expect(lock.pid).toBe(process.pid);
            expect(lock.instanceId).toBe('test-instance');
            await release();
        });

        it('respects a foreign live lock with unexpired lease', async () => {
            // A different instance holds the lock with a future lease.
            // We can't tell if its host is alive, so we trust the lease.
            const dir = join(root, 'acme', 'platform', '42');
            await mkdir(dir, { recursive: true });
            const foreign = {
                pid: 1,
                instanceId: 'other-instance',
                leaseUntil: new Date(Date.now() + 60_000).toISOString(),
            };
            await writeFile(join(dir, '.sokuza-lock'), JSON.stringify(foreign), 'utf-8');

            await expect(manager.acquire('acme', 'platform', 42)).rejects.toThrow(/locked/);
        });
    });

    describe('eviction', () => {
        beforeEach(async () => {
            await manager.writeMeta(META);
            await mkdir(manager.repoPath('acme', 'platform', 42), { recursive: true });
        });

        it('removes the workdir directory', async () => {
            const evicted = await manager.evict('acme', 'platform', 42);
            expect(evicted).toBe(true);
            expect(existsSync(join(root, 'acme', 'platform', '42'))).toBe(false);
        });

        it('returns false when nothing to evict', async () => {
            await manager.evict('acme', 'platform', 42);
            expect(await manager.evict('acme', 'platform', 42)).toBe(false);
        });

        it('refuses to evict a live-locked workdir without force', async () => {
            const release = await manager.acquire('acme', 'platform', 42);
            await expect(manager.evict('acme', 'platform', 42)).rejects.toThrow(/locked/);
            await release();
        });

        it('force-evicts a live-locked workdir', async () => {
            const release = await manager.acquire('acme', 'platform', 42);
            await manager.evict('acme', 'platform', 42, { force: true });
            expect(existsSync(join(root, 'acme', 'platform', '42'))).toBe(false);
            // Release no-op since the dir is gone.
            await release();
        });

        it('evictIdle skips non-stale workdirs', async () => {
            const fresh = { ...META, lastSyncAt: new Date().toISOString() };
            await manager.writeMeta(fresh);
            const result = await manager.evictIdle(60_000);
            expect(result.evicted).toBe(0);
        });

        it('evictIdle removes stale workdirs', async () => {
            const stale = { ...META, lastSyncAt: '2020-01-01T00:00:00.000Z' };
            await manager.writeMeta(stale);
            const result = await manager.evictIdle(60_000);
            expect(result.evicted).toBe(1);
            expect(existsSync(join(root, 'acme', 'platform', '42'))).toBe(false);
        });

        it('evictIdle skips locked workdirs and counts them as skipped', async () => {
            const stale = { ...META, lastSyncAt: '2020-01-01T00:00:00.000Z' };
            await manager.writeMeta(stale);
            const release = await manager.acquire('acme', 'platform', 42);
            const result = await manager.evictIdle(60_000);
            expect(result.evicted).toBe(0);
            expect(result.skipped).toBeGreaterThanOrEqual(1);
            await release();
        });
    });

    describe('recoverStaleLocks', () => {
        it('reclaims expired locks at startup', async () => {
            await manager.writeMeta(META);
            const dir = join(root, 'acme', 'platform', '42');
            const lockPath = join(dir, '.sokuza-lock');
            await writeFile(lockPath, JSON.stringify({
                pid: 999_999_999, instanceId: 'dead', leaseUntil: '2020-01-01T00:00:00.000Z',
            }), 'utf-8');

            const reclaimed = await manager.recoverStaleLocks();
            expect(reclaimed).toBe(1);
            expect(existsSync(lockPath)).toBe(false);
        });

        it('leaves live locks alone', async () => {
            await manager.writeMeta(META);
            const release = await manager.acquire('acme', 'platform', 42);
            const reclaimed = await manager.recoverStaleLocks();
            expect(reclaimed).toBe(0);
            await release();
        });
    });

    it('inspect surfaces lock state', async () => {
        await manager.writeMeta(META);
        await mkdir(manager.repoPath('acme', 'platform', 42), { recursive: true });
        const before = await manager.inspect('acme', 'platform', 42);
        expect(before?.locked).toBe(false);

        const release = await manager.acquire('acme', 'platform', 42);
        const during = await manager.inspect('acme', 'platform', 42);
        expect(during?.locked).toBe(true);
        expect(during?.lockHolder?.pid).toBe(process.pid);
        await release();
    });
});
