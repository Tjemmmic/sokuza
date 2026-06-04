import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { VERSION } from '../version.js';

const CACHE_PATH = join(homedir(), '.sokuza', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/sokuza/latest';
const FETCH_TIMEOUT_MS = 5000;

export interface Cache {
    checkedAt: number;
    latest: string;
}

/**
 * Print a one-line "update available" notice if the cached registry version
 * is newer than the running one. Intentionally reads only from the on-disk
 * cache so a short-lived command (`sokuza version`, `sokuza help`) never
 * blocks on the network — the cache is refreshed separately by
 * `refreshUpdateCache`, typically from the long-running `start` process.
 *
 * Silent when stderr is not a TTY, in CI, or when NO_UPDATE_NOTIFIER=1. Any
 * I/O error is swallowed: a missed notice is strictly less bad than an
 * error surfaced to a user who was just running the CLI.
 */
export async function maybeNotifyUpdate(): Promise<void> {
    if (!shouldNotify()) return;
    const cache = await readCache();
    if (cache && isNewer(cache.latest, VERSION)) writeNotice(cache.latest);
}

export interface RefreshOptions {
    /** Skip the "cache is still fresh" short-circuit and always hit the registry. */
    force?: boolean;
}

export interface RefreshResult {
    /** True when the cache holds a usable `latest` (freshly fetched or still-fresh). */
    ok: boolean;
    latest?: string;
    /** Human-readable reason the check failed — surfaced by the dashboard button. */
    error?: string;
}

/**
 * Fetch the latest published version from the npm registry and write it to
 * the cache file used by `maybeNotifyUpdate`. No-op when the cache is still
 * fresh unless `force: true` is passed (used by the dashboard's explicit
 * "Check for updates" button).
 *
 * Returns a result so the dashboard can tell the user whether the check
 * actually succeeded. Fire-and-forget callers (the `start` process) can
 * ignore the return value — it never throws.
 */
export async function refreshUpdateCache(opts: RefreshOptions = {}): Promise<RefreshResult> {
    try {
        if (!opts.force) {
            const cache = await readCache();
            if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
                return { ok: true, latest: cache.latest };
            }
        }

        // No `accept: application/vnd.npm.install-v1+json` header: that
        // abbreviated-metadata media type is for the *packument*
        // (`/sokuza`); on the `/sokuza/latest` version endpoint npm returns
        // an empty body for it, which is why the cache used to get stuck on
        // a stale version. The default JSON for `/latest` is the version
        // manifest with a `version` field.
        const res = await fetch(REGISTRY_URL, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `npm registry returned HTTP ${res.status}` };
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version !== 'string' || body.version.length === 0) {
            return { ok: false, error: 'npm registry response had no version field' };
        }

        await mkdir(dirname(CACHE_PATH), { recursive: true });
        await writeFile(
            CACHE_PATH,
            JSON.stringify({ checkedAt: Date.now(), latest: body.version }),
            'utf-8',
        );
        return { ok: true, latest: body.version };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Read the on-disk update-check cache. Exported so the dashboard API can
 * surface the same values the CLI notifier uses. */
export async function readUpdateCache(): Promise<Cache | null> {
    return readCache();
}

function shouldNotify(): boolean {
    if (!process.stderr.isTTY) return false;
    if (process.env.NO_UPDATE_NOTIFIER === '1') return false;
    if (process.env.CI) return false;
    return true;
}

async function readCache(): Promise<Cache | null> {
    try {
        const raw = await readFile(CACHE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<Cache>;
        if (typeof parsed.checkedAt !== 'number') return null;
        if (typeof parsed.latest !== 'string' || parsed.latest.length === 0) return null;
        return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    } catch {
        return null;
    }
}

function writeNotice(latest: string): void {
    process.stderr.write(
        `\nsokuza ${latest} is available (current: ${VERSION}). Run \`sokuza update\` to upgrade.\n\n`,
    );
}

export function isNewer(latest: string, current: string): boolean {
    return compareSemver(latest, current) > 0;
}

/**
 * Compare two semver-ish strings. Positive result means `a` is newer than
 * `b`. Handles `X.Y.Z` and `X.Y.Z-prerelease`; not spec-complete — we treat
 * prerelease identifiers lexically and consider a stable release newer than
 * any prerelease at the same `X.Y.Z`.
 *
 * The consequences of a wrong comparison here are bounded: we either print
 * a spurious notice or fail to print a real one. Neither is destructive.
 */
export function compareSemver(a: string, b: string): number {
    const [amain, apre = ''] = a.split('-', 2);
    const [bmain, bpre = ''] = b.split('-', 2);
    const ap = amain.split('.').map(toInt);
    const bp = bmain.split('.').map(toInt);
    for (let i = 0; i < 3; i++) {
        const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
        if (diff !== 0) return diff;
    }
    if (apre === bpre) return 0;
    if (apre === '') return 1;
    if (bpre === '') return -1;
    return apre < bpre ? -1 : 1;
}

function toInt(s: string): number {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
}
