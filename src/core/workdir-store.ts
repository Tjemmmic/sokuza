/**
 * Persistent per-PR git workdirs for the auto address-review action.
 *
 * Layout under `<workdir_root>/<owner>/<repo>/<prNumber>/`:
 *
 *   repo/              — the actual git checkout
 *   meta.json          — { owner, repo, prNumber, headSha, headRef, clonedAt, lastSyncAt }
 *   .sokuza-lock       — { pid, instanceId, leaseUntil } JSON; advisory lock
 *
 * `workdir_root` defaults to `~/.sokuza/auto-fix-workdirs/`. Overridable via
 * `SOKUZA_WORKDIR_ROOT` so a service-mode deployment or shared-storage setup
 * can relocate without code changes.
 *
 * Two layers of safety against concurrent access:
 *   1. Sokuza's queue dedup_key serializes within a single instance.
 *   2. The file lock makes shared-storage usage safe across instances.
 *
 * Stale locks (lease expired AND PID not running) are reclaimed on engine
 * startup and lazily on `acquire`. Without that, a crashed run would leave
 * a workdir wedged.
 */

import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

export interface WorkdirMeta {
    owner: string;
    repo: string;
    prNumber: number;
    /** PR head SHA the working tree is currently checked out at. */
    headSha: string;
    /** PR head branch name, used for `git fetch origin <ref>`. */
    headRef: string;
    clonedAt: string;
    lastSyncAt: string;
}

export interface WorkdirInfo extends WorkdirMeta {
    path: string;
    sizeBytes: number;
    locked: boolean;
    /** Present only if the workdir is currently locked. */
    lockHolder?: { pid: number; instanceId: string; leaseUntil: string };
}

interface LockFile {
    pid: number;
    instanceId: string;
    leaseUntil: string;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const META_FILE = 'meta.json';
const LOCK_FILE = '.sokuza-lock';
const REPO_DIR = 'repo';

function defaultWorkdirRoot(): string {
    return process.env.SOKUZA_WORKDIR_ROOT
        ?? join(homedir(), '.sokuza', 'auto-fix-workdirs');
}

export class WorkdirManager {
    private readonly logger: Logger;
    private readonly baseDir: string;
    private readonly instanceId: string;

    constructor(logger: Logger, baseDir?: string, instanceId?: string) {
        this.logger = logger;
        this.baseDir = baseDir ?? defaultWorkdirRoot();
        this.instanceId = instanceId ?? `${process.pid}-${randomBytes(4).toString('hex')}`;
    }

    private dirFor(owner: string, repo: string, prNumber: number): string {
        return join(this.baseDir, owner, repo, String(prNumber));
    }

    /** Absolute path to the git checkout for this PR. Caller writes here. */
    repoPath(owner: string, repo: string, prNumber: number): string {
        return join(this.dirFor(owner, repo, prNumber), REPO_DIR);
    }

    /**
     * Acquire an advisory lock on this PR's workdir. Returns a release
     * function. Throws if a live process holds the lock.
     *
     * Stale locks (expired lease AND PID not running) are reclaimed
     * silently with a warning log. The owner/repo/pr triple is the lock
     * key — concurrent acquires for different PRs proceed independently.
     */
    async acquire(owner: string, repo: string, prNumber: number): Promise<() => Promise<void>> {
        const dir = this.dirFor(owner, repo, prNumber);
        await mkdir(dir, { recursive: true });
        const lockPath = join(dir, LOCK_FILE);

        if (existsSync(lockPath)) {
            const existing = await this.readLock(lockPath);
            if (existing && this.isLockLive(existing)) {
                throw new Error(
                    `workdir locked: pid=${existing.pid} instance=${existing.instanceId} leaseUntil=${existing.leaseUntil}`,
                );
            }
            this.logger.warn({ existing, lockPath }, 'Reclaiming stale workdir lock');
        }

        const lock: LockFile = {
            pid: process.pid,
            instanceId: this.instanceId,
            leaseUntil: new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(),
        };
        await writeFile(lockPath, JSON.stringify(lock), 'utf-8');

        return async () => {
            try {
                if (existsSync(lockPath)) await rm(lockPath, { force: true });
            } catch (err) {
                this.logger.warn({ err, lockPath }, 'Failed to release workdir lock');
            }
        };
    }

    async getMeta(owner: string, repo: string, prNumber: number): Promise<WorkdirMeta | null> {
        const path = join(this.dirFor(owner, repo, prNumber), META_FILE);
        if (!existsSync(path)) return null;
        try {
            return JSON.parse(await readFile(path, 'utf-8')) as WorkdirMeta;
        } catch {
            return null;
        }
    }

    async writeMeta(meta: WorkdirMeta): Promise<void> {
        const dir = this.dirFor(meta.owner, meta.repo, meta.prNumber);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
    }

    async list(): Promise<WorkdirInfo[]> {
        if (!existsSync(this.baseDir)) return [];
        const out: WorkdirInfo[] = [];

        const owners = await readdir(this.baseDir, { withFileTypes: true });
        for (const o of owners) {
            if (!o.isDirectory()) continue;
            const repos = await readdir(join(this.baseDir, o.name), { withFileTypes: true });
            for (const r of repos) {
                if (!r.isDirectory()) continue;
                const prs = await readdir(join(this.baseDir, o.name, r.name), { withFileTypes: true });
                for (const p of prs) {
                    if (!p.isDirectory()) continue;
                    const prNumber = parseInt(p.name, 10);
                    if (!Number.isFinite(prNumber)) continue;
                    const info = await this.inspect(o.name, r.name, prNumber);
                    if (info) out.push(info);
                }
            }
        }
        return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
    }

    async inspect(owner: string, repo: string, prNumber: number): Promise<WorkdirInfo | null> {
        const dir = this.dirFor(owner, repo, prNumber);
        if (!existsSync(dir)) return null;
        const meta = await this.getMeta(owner, repo, prNumber);
        if (!meta) return null;

        const sizeBytes = await dirSize(dir);
        const lockPath = join(dir, LOCK_FILE);
        let locked = false;
        let lockHolder: WorkdirInfo['lockHolder'];
        if (existsSync(lockPath)) {
            const lock = await this.readLock(lockPath);
            if (lock && this.isLockLive(lock)) {
                locked = true;
                lockHolder = lock;
            }
        }
        return { ...meta, path: dir, sizeBytes, locked, lockHolder };
    }

    /** Remove the workdir entirely. Refuses if a live lock exists unless
     *  `force` is set; force is for dashboard "evict anyway" actions. */
    async evict(
        owner: string,
        repo: string,
        prNumber: number,
        opts: { force?: boolean } = {},
    ): Promise<boolean> {
        const dir = this.dirFor(owner, repo, prNumber);
        if (!existsSync(dir)) return false;
        const lockPath = join(dir, LOCK_FILE);
        if (existsSync(lockPath) && !opts.force) {
            const lock = await this.readLock(lockPath);
            if (lock && this.isLockLive(lock)) {
                throw new Error(
                    `cannot evict locked workdir: pid=${lock.pid} instance=${lock.instanceId}`,
                );
            }
        }
        await rm(dir, { recursive: true, force: true });
        this.logger.info({ owner, repo, prNumber, force: !!opts.force }, 'Workdir evicted');
        return true;
    }

    /** Clean up workdirs whose `lastSyncAt` is older than `maxAgeMs`. */
    async evictIdle(maxAgeMs: number): Promise<{ evicted: number; skipped: number }> {
        const now = Date.now();
        const list = await this.list();
        let evicted = 0;
        let skipped = 0;
        for (const info of list) {
            const age = now - new Date(info.lastSyncAt).getTime();
            if (age <= maxAgeMs) continue;
            if (info.locked) { skipped++; continue; }
            try {
                await this.evict(info.owner, info.repo, info.prNumber);
                evicted++;
            } catch {
                skipped++;
            }
        }
        return { evicted, skipped };
    }

    /** Boot-time sweep: find lock files whose holders are no longer live
     *  and remove them. Safe to run at any time; the live-lock check
     *  prevents stomping an active acquirer. Returns count reclaimed. */
    async recoverStaleLocks(): Promise<number> {
        if (!existsSync(this.baseDir)) return 0;
        let reclaimed = 0;
        const list = await this.list();
        for (const info of list) {
            const lockPath = join(info.path, LOCK_FILE);
            if (!existsSync(lockPath)) continue;
            const lock = await this.readLock(lockPath);
            if (!lock || this.isLockLive(lock)) continue;
            try {
                await rm(lockPath, { force: true });
                reclaimed++;
                this.logger.info({ lock, lockPath }, 'Reclaimed stale workdir lock at startup');
            } catch (err) {
                this.logger.warn({ err, lockPath }, 'Failed to reclaim stale lock');
            }
        }
        return reclaimed;
    }

    private async readLock(path: string): Promise<LockFile | null> {
        try {
            return JSON.parse(await readFile(path, 'utf-8')) as LockFile;
        } catch {
            return null;
        }
    }

    /** A lock is live if the lease hasn't expired AND, if the holder is
     *  on this host, the PID is still running. Locks held by other
     *  instances (foreign instanceId) are trusted to expire on lease. */
    private isLockLive(lock: LockFile): boolean {
        if (new Date(lock.leaseUntil).getTime() < Date.now()) return false;
        if (lock.instanceId === this.instanceId) {
            // Same instance — check if the PID is the current process.
            return lock.pid === process.pid || isPidAlive(lock.pid);
        }
        return true;
    }
}

function isPidAlive(pid: number): boolean {
    try {
        // Signal 0 is a no-op kill that throws ESRCH if the process is gone.
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function dirSize(path: string): Promise<number> {
    let total = 0;
    try {
        const entries = await readdir(path, { withFileTypes: true });
        for (const e of entries) {
            const full = join(path, e.name);
            if (e.isDirectory()) {
                total += await dirSize(full);
            } else if (e.isFile()) {
                try {
                    total += (await stat(full)).size;
                } catch { /* race with eviction */ }
            }
        }
    } catch { /* dir vanished mid-walk */ }
    return total;
}
