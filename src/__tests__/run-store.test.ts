import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
    recordAiReviewRun,
    listAiReviewRuns,
    getAiReviewRunById,
    setAiReviewLabel,
    clearAiReviewLabel,
    aggregateAiReviewStats,
    runStoreEvents,
    dateFromRunId,
    generateRunId,
    sha1,
    type AiReviewRunRecord,
} from '../core/run-store.js';

const logger = pino({ level: 'silent' });

function makeRecord(overrides: Partial<AiReviewRunRecord> = {}): AiReviewRunRecord {
    return {
        id: 'test-run-id',
        action: 'ai-review',
        createdAt: '2026-04-24T12:34:56.789Z',
        durationMs: 1234,
        workflowName: 'ai-pr-review',
        event: { source: 'github', event: 'pull_request.opened', repo: 'org/repo', prNumber: 42 },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 500, output_tokens: 100 },
        strategy: 'truncate',
        input: {
            diffSource: 'full',
            diffBytes: 1024,
            diffSha1: sha1('example'),
            incompleteFiles: [],
        },
        truncation: {
            triggered: false,
            originalChars: 1024,
            finalChars: 1024,
            totalFiles: 1,
            fullyIncludedFiles: 1,
            truncatedFiles: 0,
            skippedFiles: 0,
            files: [
                { filename: 'src/a.ts', originalBytes: 1024, finalBytes: 1024, status: 'included' },
            ],
        },
        output: {
            parseSucceeded: true,
            decision: 'APPROVE',
            issueCount: 0,
            issues: [],
            reviewChars: 500,
        },
        ...overrides,
    };
}

describe('run-store', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'sokuza-run-store-'));
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    it('generateRunId produces unique, sortable ids', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) ids.add(generateRunId());
        expect(ids.size).toBe(100);
    });

    it('sha1 is deterministic and matches canonical value', () => {
        expect(sha1('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('writes a record under <base>/ai-review/<date>/<id>.json', async () => {
        const record = makeRecord({ id: 'abc123' });
        await recordAiReviewRun(record, logger, tmpRoot);

        const expectedPath = join(tmpRoot, 'ai-review', '2026-04-24', 'abc123.json');
        const raw = await readFile(expectedPath, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed).toEqual(record);
    });

    it('creates date-partitioned directories from createdAt', async () => {
        await recordAiReviewRun(makeRecord({ id: 'r1', createdAt: '2026-01-02T00:00:00.000Z' }), logger, tmpRoot);
        await recordAiReviewRun(makeRecord({ id: 'r2', createdAt: '2026-01-03T00:00:00.000Z' }), logger, tmpRoot);

        const dir = join(tmpRoot, 'ai-review');
        const entries = await readdir(dir);
        expect(entries.sort()).toEqual(['2026-01-02', '2026-01-03']);
    });

    it('writes file with 0600 permissions', async () => {
        await recordAiReviewRun(makeRecord({ id: 'perm-test' }), logger, tmpRoot);
        const file = join(tmpRoot, 'ai-review', '2026-04-24', 'perm-test.json');
        const info = await stat(file);
        // Low 9 bits: owner/group/world rwx. 0o600 = owner read+write only.
        expect(info.mode & 0o777).toBe(0o600);
    });

    it('dateFromRunId decodes the partition date deterministically', () => {
        const id = generateRunId();
        const date = dateFromRunId(id);
        expect(date).toBe(new Date().toISOString().slice(0, 10));
        expect(dateFromRunId('not-a-real-id')).toBeNull();
        expect(dateFromRunId('')).toBeNull();
    });

    describe('listAiReviewRuns', () => {
        beforeEach(async () => {
            // Seed three records across two days with varied attributes.
            await recordAiReviewRun(makeRecord({
                id: 'r-old', createdAt: '2026-01-02T08:00:00.000Z',
                workflowName: 'wf-a',
                event: { source: 'github', event: 'pull_request.opened', repo: 'org/a' },
                truncation: { triggered: false, originalChars: 10, finalChars: 10, totalFiles: 1, fullyIncludedFiles: 1, truncatedFiles: 0, skippedFiles: 0, files: [] },
                output: { parseSucceeded: true, decision: 'APPROVE', issueCount: 0, issues: [], reviewChars: 100 },
            }), logger, tmpRoot);
            await recordAiReviewRun(makeRecord({
                id: 'r-mid', createdAt: '2026-01-03T09:00:00.000Z',
                workflowName: 'wf-b',
                event: { source: 'github', event: 'pull_request.opened', repo: 'org/b' },
                truncation: { triggered: true, originalChars: 100, finalChars: 50, totalFiles: 2, fullyIncludedFiles: 1, truncatedFiles: 0, skippedFiles: 1, files: [] },
                output: { parseSucceeded: true, decision: 'CHANGES_REQUESTED', issueCount: 2, issues: [], reviewChars: 200 },
            }), logger, tmpRoot);
            await recordAiReviewRun(makeRecord({
                id: 'r-new', createdAt: '2026-01-03T10:00:00.000Z',
                workflowName: 'wf-a',
                event: { source: 'github', event: 'pull_request.opened', repo: 'org/a' },
                output: { parseSucceeded: false, reviewChars: 0 },
                error: 'provider exploded',
            }), logger, tmpRoot);
        });

        it('returns summaries newest-first without per-file or per-issue detail', async () => {
            const runs = await listAiReviewRuns({ baseDir: tmpRoot });
            expect(runs.map((r) => r.id)).toEqual(['r-new', 'r-mid', 'r-old']);
            const r = runs[0];
            expect((r as any).truncation.files).toBeUndefined();
            expect((r as any).output.issues).toBeUndefined();
            expect(r.input.incompleteFileCount).toBe(0);
        });

        it('honors limit', async () => {
            const runs = await listAiReviewRuns({ baseDir: tmpRoot, limit: 2 });
            expect(runs).toHaveLength(2);
            expect(runs[0].id).toBe('r-new');
        });

        it('filters by workflowName', async () => {
            const runs = await listAiReviewRuns({ baseDir: tmpRoot, workflowName: 'wf-a' });
            expect(runs.map((r) => r.id).sort()).toEqual(['r-new', 'r-old']);
        });

        it('filters by truncatedOnly, erroredOnly, parseFailedOnly', async () => {
            expect((await listAiReviewRuns({ baseDir: tmpRoot, truncatedOnly: true })).map((r) => r.id)).toEqual(['r-mid']);
            expect((await listAiReviewRuns({ baseDir: tmpRoot, erroredOnly: true })).map((r) => r.id)).toEqual(['r-new']);
            expect((await listAiReviewRuns({ baseDir: tmpRoot, parseFailedOnly: true })).map((r) => r.id)).toEqual(['r-new']);
        });

        it('filters by date range and decision', async () => {
            const runs = await listAiReviewRuns({ baseDir: tmpRoot, since: '2026-01-03', decision: 'CHANGES_REQUESTED' });
            expect(runs.map((r) => r.id)).toEqual(['r-mid']);
        });

        it('returns [] when the runs dir does not exist', async () => {
            const runs = await listAiReviewRuns({ baseDir: join(tmpRoot, 'absent') });
            expect(runs).toEqual([]);
        });
    });

    describe('getAiReviewRunById', () => {
        it('returns the full record including per-file detail', async () => {
            const id = generateRunId();
            const record = makeRecord({ id });
            await recordAiReviewRun(record, logger, tmpRoot);
            const got = await getAiReviewRunById(id, tmpRoot);
            expect(got).toEqual(record);
            expect(got!.truncation.files).toBeDefined();
        });

        it('returns null for unknown ids', async () => {
            const got = await getAiReviewRunById('does-not-exist', tmpRoot);
            expect(got).toBeNull();
        });

        it('finds runs even when the id timestamp does not decode', async () => {
            // ID without the dash-prefixed ts → falls back to scanning all dirs.
            await recordAiReviewRun(makeRecord({ id: 'manual-id', createdAt: '2026-02-02T00:00:00.000Z' }), logger, tmpRoot);
            const got = await getAiReviewRunById('manual-id', tmpRoot);
            expect(got?.id).toBe('manual-id');
        });
    });

    describe('labels', () => {
        it('setAiReviewLabel writes verdict + note and bumps labeledAt', async () => {
            const id = 'label-1';
            await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
            const updated = await setAiReviewLabel(id, { verdict: 'good', note: 'caught the migration bug' }, logger, tmpRoot);
            expect(updated?.label).toMatchObject({ verdict: 'good', note: 'caught the migration bug' });
            expect(updated?.label?.labeledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

            const reread = await getAiReviewRunById(id, tmpRoot);
            expect(reread?.label?.verdict).toBe('good');
        });

        it('setAiReviewLabel returns null for unknown ids', async () => {
            const got = await setAiReviewLabel('nope', { verdict: 'good' }, logger, tmpRoot);
            expect(got).toBeNull();
        });

        it('setAiReviewLabel trims notes and drops empty', async () => {
            const id = 'label-2';
            await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
            const updated = await setAiReviewLabel(id, { verdict: 'bad', note: '   ' }, logger, tmpRoot);
            expect(updated?.label?.note).toBeUndefined();
        });

        it('clearAiReviewLabel removes the label', async () => {
            const id = 'label-3';
            await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
            await setAiReviewLabel(id, { verdict: 'good' }, logger, tmpRoot);
            const cleared = await clearAiReviewLabel(id, logger, tmpRoot);
            expect(cleared?.label).toBeUndefined();
        });

        it('list summaries include the label so the table can render badges', async () => {
            const id = 'label-4';
            await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
            await setAiReviewLabel(id, { verdict: 'bad', note: 'flag' }, logger, tmpRoot);
            const runs = await listAiReviewRuns({ baseDir: tmpRoot });
            const row = runs.find((r) => r.id === id);
            expect(row?.label?.verdict).toBe('bad');
        });
    });

    describe('runStoreEvents', () => {
        it('emits ai-review-run on initial record write', async () => {
            const events: any[] = [];
            const handler = (s: any) => events.push(s);
            runStoreEvents.on('ai-review-run', handler);
            try {
                const id = 'emit-1';
                await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
                expect(events.some((e) => e.id === id)).toBe(true);
            } finally {
                runStoreEvents.off('ai-review-run', handler);
            }
        });

        it('emits ai-review-run on label change', async () => {
            const id = 'emit-2';
            await recordAiReviewRun(makeRecord({ id }), logger, tmpRoot);
            const events: any[] = [];
            const handler = (s: any) => events.push(s);
            runStoreEvents.on('ai-review-run', handler);
            try {
                await setAiReviewLabel(id, { verdict: 'good' }, logger, tmpRoot);
                expect(events.some((e) => e.id === id && e.label?.verdict === 'good')).toBe(true);
            } finally {
                runStoreEvents.off('ai-review-run', handler);
            }
        });
    });

    describe('aggregateAiReviewStats', () => {
        beforeEach(async () => {
            await recordAiReviewRun(makeRecord({
                id: 's-untrunc', createdAt: '2026-04-20T10:00:00.000Z',
                truncation: { triggered: false, originalChars: 1000, finalChars: 1000, totalFiles: 1, fullyIncludedFiles: 1, truncatedFiles: 0, skippedFiles: 0, files: [{ filename: 'a.ts', originalBytes: 1000, finalBytes: 1000, status: 'included' }] },
                output: { parseSucceeded: true, decision: 'APPROVE', issueCount: 0, issues: [], reviewChars: 200 },
            }), logger, tmpRoot);
            await recordAiReviewRun(makeRecord({
                id: 's-trunc', createdAt: '2026-04-22T10:00:00.000Z',
                truncation: {
                    triggered: true, originalChars: 50_000, finalChars: 9_000, totalFiles: 3, fullyIncludedFiles: 1, truncatedFiles: 0, skippedFiles: 2,
                    files: [
                        { filename: 'good.ts', originalBytes: 9000, finalBytes: 9000, status: 'included' },
                        { filename: 'package-lock.json', originalBytes: 30_000, finalBytes: 0, status: 'skipped', skipReason: 'pattern' },
                        { filename: 'src/big.ts', originalBytes: 11_000, finalBytes: 0, status: 'skipped', skipReason: 'budget' },
                    ],
                },
                output: { parseSucceeded: true, decision: 'CHANGES_REQUESTED', issueCount: 1, issues: [], reviewChars: 400 },
            }), logger, tmpRoot);
            await recordAiReviewRun(makeRecord({
                id: 's-error', createdAt: '2026-04-23T10:00:00.000Z',
                truncation: { triggered: false, originalChars: 200, finalChars: 200, totalFiles: 1, fullyIncludedFiles: 1, truncatedFiles: 0, skippedFiles: 0, files: [] },
                output: { parseSucceeded: false, reviewChars: 0 },
                error: 'boom',
            }), logger, tmpRoot);
            await setAiReviewLabel('s-trunc', { verdict: 'bad' }, logger, tmpRoot);
            await setAiReviewLabel('s-untrunc', { verdict: 'good' }, logger, tmpRoot);
        });

        it('counts totals and rates over the window', async () => {
            const stats = await aggregateAiReviewStats({ since: '2026-04-19T00:00:00.000Z', baseDir: tmpRoot });
            expect(stats.total).toBe(3);
            expect(stats.truncated).toBe(1);
            expect(stats.truncatedRate).toBeCloseTo(1 / 3, 5);
            expect(stats.parseFailed).toBe(1);
            expect(stats.errored).toBe(1);
            expect(stats.labeled).toEqual({ good: 1, bad: 1 });
        });

        it('sums dropped bytes by reason and ranks top dropped paths', async () => {
            const stats = await aggregateAiReviewStats({ since: '2026-04-19T00:00:00.000Z', baseDir: tmpRoot });
            expect(stats.droppedBytes.pattern).toBe(30_000);
            expect(stats.droppedBytes.budget).toBe(11_000);
            expect(stats.topDroppedPaths[0]).toMatchObject({ filename: 'package-lock.json', bytes: 30_000 });
            expect(stats.topDroppedPaths[1]).toMatchObject({ filename: 'src/big.ts', bytes: 11_000 });
        });

        it('honors the date window', async () => {
            const stats = await aggregateAiReviewStats({ since: '2026-04-23T00:00:00.000Z', baseDir: tmpRoot });
            expect(stats.total).toBe(1);
            expect(stats.errored).toBe(1);
            expect(stats.truncated).toBe(0);
        });
    });

    it('swallows write errors rather than throwing', async () => {
        // Pass an invalid baseDir (a file, not a directory) to force mkdir failure.
        // The call must not throw — observability is best-effort.
        const bogusBase = join(tmpRoot, 'not-a-dir');
        await (await import('node:fs/promises')).writeFile(bogusBase, 'x');
        await expect(
            recordAiReviewRun(makeRecord(), logger, bogusBase),
        ).resolves.toBeUndefined();
    });
});
