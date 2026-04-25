/**
 * On-disk store for AI action run records.
 *
 * Layout under `~/.sokuza/runs/<action>/<YYYY-MM-DD>/<run-id>.json`, one
 * JSON file per run. No append logic, no locks — each run writes once.
 *
 * Records capture inputs, strategy, provider, structured output, and (for
 * ai-review) per-file truncation outcomes so we can evaluate whether the
 * diff truncator is dropping review-relevant signal.
 *
 * Writes are best-effort: disk failures log a warning and never propagate,
 * since run logging is observability, not correctness.
 */

import { mkdir, writeFile, chmod, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { TruncatedDiffFile } from './diff-truncator.js';

export type AiReviewVerdict = 'good' | 'bad';

export interface AiReviewLabel {
    verdict: AiReviewVerdict;
    note?: string;
    /** ISO-8601 timestamp of the most recent label change. */
    labeledAt: string;
}

/** Module-level emitter; subscribers notified after a successful record
 *  write or label change. The API layer forwards events through SSE so
 *  the dashboard can refresh without polling. Failures never propagate. */
export const runStoreEvents = new EventEmitter();

/** Default runs root. Overridable via SOKUZA_RUNS_DIR so tests and alternate
 *  install layouts can relocate the log without code changes. Resolved
 *  per-call rather than at import so env changes within a test apply. */
function defaultRunsDir(): string {
    return process.env.SOKUZA_RUNS_DIR ?? join(homedir(), '.sokuza', 'runs');
}

export interface AiReviewRunRecord {
    id: string;
    action: 'ai-review';
    /** ISO-8601 start timestamp. Also used to derive the date-partition dir. */
    createdAt: string;
    durationMs: number;
    workflowName?: string;
    event: {
        source: string;
        event: string;
        repo?: string;
        prNumber?: number;
        branch?: string;
    };
    provider: string;
    model: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    /** Context-handling strategy. Future values: 'rlm'. */
    strategy: 'truncate';
    input: {
        /** 'full' | 'file-patches' | 'summary' — from upstream fetch step. */
        diffSource?: string;
        diffBytes: number;
        /** SHA-1 of the raw diff for correlating re-runs of the same input. */
        diffSha1: string;
        incompleteFiles: string[];
    };
    truncation: {
        triggered: boolean;
        originalChars: number;
        finalChars: number;
        totalFiles: number;
        fullyIncludedFiles: number;
        truncatedFiles: number;
        skippedFiles: number;
        files: TruncatedDiffFile[];
    };
    output: {
        parseSucceeded: boolean;
        decision?: string;
        issueCount?: number;
        issues?: Array<{ priority: string; title: string; file: string }>;
        reviewChars: number;
    };
    /** Set when the action threw before completing. */
    error?: string;
    /** Operator-supplied verdict on whether this review was useful. */
    label?: AiReviewLabel;
}

export function generateRunId(): string {
    const ts = Date.now().toString(36);
    const rand = randomBytes(8).toString('hex');
    return `${ts}-${rand}`;
}

export function sha1(content: string): string {
    return createHash('sha1').update(content).digest('hex');
}

/** Subset of an AiReviewRunRecord without per-file or per-issue detail —
 *  cheap to list, sufficient for the dashboard table. */
export type AiReviewRunSummary = Omit<AiReviewRunRecord, 'truncation' | 'output' | 'input'> & {
    truncation: Omit<AiReviewRunRecord['truncation'], 'files'>;
    output: Omit<AiReviewRunRecord['output'], 'issues'>;
    input: Omit<AiReviewRunRecord['input'], 'incompleteFiles'> & { incompleteFileCount: number };
};

export interface ListAiReviewRunsOptions {
    /** Cap on returned rows. Default 100, hard max 1000. */
    limit?: number;
    /** Earliest createdAt to include (inclusive). */
    since?: string;
    /** Latest createdAt to include (inclusive). */
    until?: string;
    workflowName?: string;
    repo?: string;
    decision?: string;
    truncatedOnly?: boolean;
    parseFailedOnly?: boolean;
    erroredOnly?: boolean;
    baseDir?: string;
}

export async function recordAiReviewRun(
    record: AiReviewRunRecord,
    logger: Logger,
    baseDir?: string,
): Promise<void> {
    await writeRecord(record, logger, baseDir);
}

/** Apply a label to an existing record. Read-modify-write under the
 *  assumption that records are never updated concurrently from multiple
 *  callers (label edits are user-driven and rare). Returns the updated
 *  record, or null if the run id was unknown. */
export async function setAiReviewLabel(
    id: string,
    label: { verdict: AiReviewVerdict; note?: string },
    logger: Logger,
    baseDir?: string,
): Promise<AiReviewRunRecord | null> {
    const record = await getAiReviewRunById(id, baseDir);
    if (!record) return null;
    record.label = {
        verdict: label.verdict,
        note: label.note?.trim() ? label.note.trim() : undefined,
        labeledAt: new Date().toISOString(),
    };
    await writeRecord(record, logger, baseDir);
    return record;
}

export async function clearAiReviewLabel(
    id: string,
    logger: Logger,
    baseDir?: string,
): Promise<AiReviewRunRecord | null> {
    const record = await getAiReviewRunById(id, baseDir);
    if (!record) return null;
    delete record.label;
    await writeRecord(record, logger, baseDir);
    return record;
}

/** Single writer for both the initial record and label edits. Emits
 *  `ai-review-run` on success so SSE subscribers refresh consistently
 *  for either origin. Disk failures log and swallow — observability is
 *  best-effort and must never fail an action. */
async function writeRecord(
    record: AiReviewRunRecord,
    logger: Logger,
    baseDir?: string,
): Promise<void> {
    const root = baseDir ?? defaultRunsDir();
    const datePart = record.createdAt.slice(0, 10);
    const dir = join(root, record.action, datePart);
    const file = join(dir, `${record.id}.json`);
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(record, null, 2), 'utf-8');
        await chmod(file, 0o600).catch(() => undefined);
        runStoreEvents.emit('ai-review-run', toSummary(record));
    } catch (err) {
        logger.warn({ err, file }, 'Failed to persist ai-review run record; continuing');
    }
}

/** Recover the date partition directory from a run id by decoding the
 *  base36 timestamp prefix produced by `generateRunId`. The id and the
 *  partition both derive from the same Date.now() snapshot, so this is
 *  exact for runs created with the matching helper.
 *
 *  Returns null for ids whose prefix doesn't decode to a plausible
 *  recent timestamp (e.g. hand-crafted ids in tests, or pre-helper
 *  formats). Callers should treat null as "scan all partitions". */
export function dateFromRunId(id: string): string | null {
    const dash = id.indexOf('-');
    if (dash < 1) return null;
    const prefix = id.slice(0, dash);
    if (!/^[0-9a-z]+$/.test(prefix)) return null;
    const ms = parseInt(prefix, 36);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const year = new Date(ms).getUTCFullYear();
    if (year < 2020 || year > 2100) return null;
    return new Date(ms).toISOString().slice(0, 10);
}

/** Enumerate ai-review run summaries, newest first. Walks the date
 *  partitions under <base>/ai-review/, parses each record, applies the
 *  filters in memory. Cheap for thousands of records; revisit when the
 *  log grows past that. */
export async function listAiReviewRuns(
    opts: ListAiReviewRunsOptions = {},
): Promise<AiReviewRunSummary[]> {
    const root = join(opts.baseDir ?? defaultRunsDir(), 'ai-review');
    if (!existsSync(root)) return [];

    const limit = Math.min(opts.limit ?? 100, 1000);
    const dateDirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse(); // newest day first

    const results: AiReviewRunSummary[] = [];
    for (const dateDir of dateDirs) {
        if (opts.since && dateDir < opts.since.slice(0, 10)) break;
        if (opts.until && dateDir > opts.until.slice(0, 10)) continue;

        const dirPath = join(root, dateDir);
        const files = (await readdir(dirPath))
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse(); // newest run first within the day

        for (const file of files) {
            const record = await readRunFile(join(dirPath, file));
            if (!record) continue;
            if (!matchesFilters(record, opts)) continue;
            results.push(toSummary(record));
            if (results.length >= limit) return results;
        }
    }
    return results;
}

export interface AiReviewStats {
    /** Window the stats cover, echoed back so the caller can render it. */
    window: { since: string; until?: string };
    total: number;
    truncated: number;
    truncatedRate: number;
    parseFailed: number;
    errored: number;
    labeled: { good: number; bad: number };
    meanOriginalChars: number;
    meanFinalChars: number;
    droppedBytes: { pattern: number; budget: number };
    /** Files most often dropped by the truncator, ranked by total bytes
     *  dropped across the window. Caps at 10 entries. */
    topDroppedPaths: Array<{ filename: string; bytes: number; count: number; reasons: { pattern: number; budget: number } }>;
}

export interface StatsOptions {
    since: string;
    until?: string;
    baseDir?: string;
}

/** Fold over every record in the window. Re-uses `listAiReviewRuns`'s
 *  date-partition walk, but reads full records (not summaries) so the
 *  per-file breakdown is available for `topDroppedPaths`. */
export async function aggregateAiReviewStats(
    opts: StatsOptions,
): Promise<AiReviewStats> {
    const root = join(opts.baseDir ?? defaultRunsDir(), 'ai-review');
    const stats: AiReviewStats = {
        window: { since: opts.since, until: opts.until },
        total: 0,
        truncated: 0,
        truncatedRate: 0,
        parseFailed: 0,
        errored: 0,
        labeled: { good: 0, bad: 0 },
        meanOriginalChars: 0,
        meanFinalChars: 0,
        droppedBytes: { pattern: 0, budget: 0 },
        topDroppedPaths: [],
    };
    if (!existsSync(root)) return stats;

    const dropAccum = new Map<string, { bytes: number; count: number; reasons: { pattern: number; budget: number } }>();
    let originalSum = 0;
    let finalSum = 0;

    const dateDirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

    for (const dateDir of dateDirs) {
        if (dateDir < opts.since.slice(0, 10)) continue;
        if (opts.until && dateDir > opts.until.slice(0, 10)) continue;
        const dirPath = join(root, dateDir);
        const files = (await readdir(dirPath)).filter((f) => f.endsWith('.json'));
        for (const file of files) {
            const record = await readRunFile(join(dirPath, file));
            if (!record) continue;
            if (record.createdAt < opts.since) continue;
            if (opts.until && record.createdAt > opts.until) continue;

            stats.total++;
            originalSum += record.truncation.originalChars;
            finalSum += record.truncation.finalChars;
            if (record.truncation.triggered) stats.truncated++;
            if (record.error) stats.errored++;
            if (!record.output.parseSucceeded) stats.parseFailed++;
            if (record.label?.verdict === 'good') stats.labeled.good++;
            if (record.label?.verdict === 'bad') stats.labeled.bad++;

            for (const f of record.truncation.files) {
                if (f.status !== 'skipped') continue;
                const lost = f.originalBytes;
                const reason = f.skipReason ?? 'pattern';
                stats.droppedBytes[reason] += lost;
                const entry = dropAccum.get(f.filename) ?? {
                    bytes: 0,
                    count: 0,
                    reasons: { pattern: 0, budget: 0 },
                };
                entry.bytes += lost;
                entry.count += 1;
                entry.reasons[reason] += 1;
                dropAccum.set(f.filename, entry);
            }
        }
    }

    if (stats.total > 0) {
        stats.truncatedRate = stats.truncated / stats.total;
        stats.meanOriginalChars = Math.round(originalSum / stats.total);
        stats.meanFinalChars = Math.round(finalSum / stats.total);
    }
    stats.topDroppedPaths = [...dropAccum.entries()]
        .map(([filename, v]) => ({ filename, ...v }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 10);

    return stats;
}

export async function getAiReviewRunById(
    id: string,
    baseDir?: string,
): Promise<AiReviewRunRecord | null> {
    const root = join(baseDir ?? defaultRunsDir(), 'ai-review');
    if (!existsSync(root)) return null;

    // Try the decoded partition first as a fast path; fall back to a full
    // scan when that misses (older record formats, hand-crafted ids, or
    // clock skew between id-generation and date partitioning).
    const expectedDate = dateFromRunId(id);
    if (expectedDate) {
        const fastPath = join(root, expectedDate, `${id}.json`);
        if (existsSync(fastPath)) return readRunFile(fastPath);
    }

    const dateDirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
    for (const dateDir of dateDirs) {
        if (dateDir === expectedDate) continue; // already tried
        const file = join(root, dateDir, `${id}.json`);
        if (existsSync(file)) return readRunFile(file);
    }
    return null;
}

async function readRunFile(path: string): Promise<AiReviewRunRecord | null> {
    try {
        const raw = await readFile(path, 'utf-8');
        return JSON.parse(raw) as AiReviewRunRecord;
    } catch {
        return null;
    }
}

function matchesFilters(record: AiReviewRunRecord, opts: ListAiReviewRunsOptions): boolean {
    if (opts.since && record.createdAt < opts.since) return false;
    if (opts.until && record.createdAt > opts.until) return false;
    if (opts.workflowName && record.workflowName !== opts.workflowName) return false;
    if (opts.repo && record.event.repo !== opts.repo) return false;
    if (opts.decision && record.output.decision !== opts.decision) return false;
    if (opts.truncatedOnly && !record.truncation.triggered) return false;
    if (opts.parseFailedOnly && record.output.parseSucceeded) return false;
    if (opts.erroredOnly && !record.error) return false;
    return true;
}

function toSummary(record: AiReviewRunRecord): AiReviewRunSummary {
    const { files: _files, ...truncation } = record.truncation;
    const { issues: _issues, ...output } = record.output;
    const { incompleteFiles, ...inputRest } = record.input;
    return {
        ...record,
        truncation,
        output,
        input: { ...inputRest, incompleteFileCount: incompleteFiles.length },
    };
}
