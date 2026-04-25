import { describe, it, expect } from 'vitest';
import {
    isMergeReady,
    parseAgentOutput,
    renderSuggestModeBody,
    formatSuggestionComment,
    parseSlashArgs,
} from '../actions/address-review.js';
import type { AiReviewRunRecord } from '../core/run-store.js';

function makeReview(issues: Array<{ priority: 'P1' | 'P2' | 'P3'; title?: string; file?: string }>): AiReviewRunRecord {
    return {
        id: 'r1', action: 'ai-review', createdAt: '2026-04-25T00:00:00.000Z',
        durationMs: 0, event: { source: 'github', event: 'pull_request.opened' },
        provider: 'anthropic', model: 'claude-sonnet-4-6', strategy: 'truncate',
        input: { diffBytes: 0, diffSha1: '', incompleteFiles: [] },
        truncation: { triggered: false, originalChars: 0, finalChars: 0, totalFiles: 0, fullyIncludedFiles: 0, truncatedFiles: 0, skippedFiles: 0, files: [] },
        output: {
            parseSucceeded: true,
            decision: issues.some((i) => i.priority === 'P1') ? 'CHANGES_REQUESTED' : 'APPROVE',
            issueCount: issues.length,
            issues: issues.map((i) => ({ priority: i.priority, title: i.title ?? '?', file: i.file ?? '' })),
            reviewChars: 100,
        },
    };
}

describe('isMergeReady', () => {
    it('returns true when review has no issues', () => {
        expect(isMergeReady(makeReview([]), { max_p1: 0, max_p2: 1, max_p3: -1 })).toBe(true);
    });

    it('returns false when P1 issues exceed cap', () => {
        const review = makeReview([{ priority: 'P1' }]);
        expect(isMergeReady(review, { max_p1: 0, max_p2: 1, max_p3: -1 })).toBe(false);
    });

    it('returns true when P2 count is within cap', () => {
        const review = makeReview([{ priority: 'P2' }]);
        expect(isMergeReady(review, { max_p1: 0, max_p2: 1, max_p3: -1 })).toBe(true);
    });

    it('returns false when P2 count exceeds cap', () => {
        const review = makeReview([{ priority: 'P2' }, { priority: 'P2' }]);
        expect(isMergeReady(review, { max_p1: 0, max_p2: 1, max_p3: -1 })).toBe(false);
    });

    it('treats max_p3=-1 as unlimited', () => {
        const review = makeReview([{ priority: 'P3' }, { priority: 'P3' }, { priority: 'P3' }]);
        expect(isMergeReady(review, { max_p1: 0, max_p2: 1, max_p3: -1 })).toBe(true);
    });

    it('returns false when P3 cap is set and exceeded', () => {
        const review = makeReview([{ priority: 'P3' }, { priority: 'P3' }]);
        expect(isMergeReady(review, { max_p1: 0, max_p2: 1, max_p3: 1 })).toBe(false);
    });
});

describe('parseAgentOutput', () => {
    it('takes structured json directly when present', () => {
        const out = parseAgentOutput({
            issues: { addressed: [{ priority: 'P1', title: 't', file: 'f', reasoning: 'r' }], rejected: [], deferred: [] },
            bodySummary: 'fixed all the things',
        }, '');
        expect(out.issues.addressed).toHaveLength(1);
        expect(out.bodySummary).toBe('fixed all the things');
    });

    it('extracts json from raw text when parsedJson is undefined', () => {
        const raw = `prelude...\n{"issues":{"addressed":[],"rejected":[],"deferred":[]},"bodySummary":"ok"}\nepilogue`;
        const out = parseAgentOutput(undefined, raw);
        expect(out.bodySummary).toBe('ok');
    });

    it('returns a sentinel when no json is found', () => {
        const out = parseAgentOutput(undefined, 'no json here at all');
        expect(out.issues.addressed).toEqual([]);
        expect(out.bodySummary).toMatch(/did not produce structured/);
    });

    it('coerces missing arrays to empty', () => {
        const out = parseAgentOutput({}, '');
        expect(out.issues.addressed).toEqual([]);
        expect(out.issues.rejected).toEqual([]);
        expect(out.issues.deferred).toEqual([]);
    });
});

describe('renderSuggestModeBody', () => {
    it('embeds the source-review marker and iteration counter', () => {
        const body = renderSuggestModeBody(
            { issues: { addressed: [], rejected: [], deferred: [] }, bodySummary: 'no-op' },
            'src-id', 2, 5,
        );
        expect(body).toContain('sokuza:address-run sourceReviewRunId=src-id');
        expect(body).toContain('iter=2/5');
        expect(body).toContain('mode=suggest');
        expect(body).toContain('iteration 2/5');
    });

    it('lists rejected and deferred issues separately', () => {
        const body = renderSuggestModeBody({
            issues: {
                addressed: [],
                rejected: [{ priority: 'P2', title: 'spurious', file: 'f.ts', reasoning: 'no actual bug' }],
                deferred: [{ priority: 'P1', title: 'large refactor', file: 'g.ts', reasoning: 'needs human' }],
            },
            bodySummary: 's',
        }, 'r', 1, 3);
        expect(body).toContain('Rejected as not authentic');
        expect(body).toContain('spurious');
        expect(body).toContain('Deferred — human attention');
        expect(body).toContain('large refactor');
    });
});

describe('parseSlashArgs', () => {
    it('parses mode= argument from a /sokuza fix comment', () => {
        expect(parseSlashArgs('/sokuza fix mode=push')).toEqual({ mode: 'push' });
    });

    it('returns empty when comment is not a fix command', () => {
        expect(parseSlashArgs('lgtm')).toEqual({});
        expect(parseSlashArgs('/sokuza skip')).toEqual({});
    });

    it('parses with surrounding text and multiple args', () => {
        expect(parseSlashArgs('please /sokuza fix mode=suggest priority=P1\nthanks'))
            .toEqual({ mode: 'suggest', priority: 'P1' });
    });

    it('ignores tokens without =', () => {
        expect(parseSlashArgs('/sokuza fix bare-token mode=push'))
            .toEqual({ mode: 'push' });
    });

    it('handles empty / undefined', () => {
        expect(parseSlashArgs('')).toEqual({});
        expect(parseSlashArgs(undefined)).toEqual({});
    });

    it('is case-insensitive on the command name', () => {
        expect(parseSlashArgs('/Sokuza Fix mode=push')).toEqual({ mode: 'push' });
    });
});

describe('formatSuggestionComment', () => {
    it('wraps the suggested code in a ```suggestion fence', () => {
        const comment = formatSuggestionComment({
            priority: 'P2',
            title: 'extract constant',
            reasoning: 'magic number 5000 is unclear',
            suggestion: { path: 'src/cache.ts', line: 42, code: 'const TTL = 5000;' },
        });
        expect(comment).toContain('**P2 — extract constant**');
        expect(comment).toContain('magic number 5000 is unclear');
        expect(comment).toContain('```suggestion\nconst TTL = 5000;\n```');
    });
});
