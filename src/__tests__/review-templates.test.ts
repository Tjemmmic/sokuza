import { describe, it, expect } from 'vitest';
import {
    parseStructuredReview,
    parseStructuredReviewExt,
    parseFileLocation,
    renderReviewForApi,
    type StructuredReview,
} from '../actions/review-templates.js';

describe('parseFileLocation', () => {
    it('parses :L42-L50 form', () => {
        expect(parseFileLocation('src/foo.ts:L42-L50')).toEqual({
            path: 'src/foo.ts', lineStart: 42, lineEnd: 50,
        });
    });

    it('parses :L42 single-line form', () => {
        expect(parseFileLocation('src/foo.ts:L42')).toEqual({
            path: 'src/foo.ts', lineStart: 42, lineEnd: 42,
        });
    });

    it('parses :42 numeric form', () => {
        expect(parseFileLocation('src/foo.ts:42')).toEqual({
            path: 'src/foo.ts', lineStart: 42, lineEnd: 42,
        });
    });

    it('parses #L42 form (GitHub anchor style)', () => {
        expect(parseFileLocation('src/foo.ts#L42-L50')).toEqual({
            path: 'src/foo.ts', lineStart: 42, lineEnd: 50,
        });
    });

    it('handles missing line range', () => {
        expect(parseFileLocation('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
    });

    it('handles empty input', () => {
        expect(parseFileLocation('')).toEqual({ path: '' });
    });
});

describe('parseStructuredReview', () => {
    it('extracts path + lines from file field', () => {
        const review = parseStructuredReview(JSON.stringify({
            summary: 's',
            issues: [{ priority: 'P1', title: 't', file: 'src/foo.ts:L42-L50', problem: 'p', fix: 'f' }],
            decision: 'CHANGES_REQUESTED',
            justification: 'j',
        }));
        expect(review?.issues[0]).toMatchObject({
            file: 'src/foo.ts:L42-L50',
            path: 'src/foo.ts',
            lineStart: 42,
            lineEnd: 50,
        });
    });

    it('preserves backward-compatible file with no line range', () => {
        const review = parseStructuredReview(JSON.stringify({
            summary: 's',
            issues: [{ priority: 'P2', title: 't', file: 'src/foo.ts', problem: '', fix: '' }],
            decision: 'APPROVE',
            justification: '',
        }));
        expect(review?.issues[0]).toMatchObject({
            file: 'src/foo.ts',
            path: 'src/foo.ts',
            lineStart: undefined,
            lineEnd: undefined,
        });
    });
});

describe('parseStructuredReviewExt failure classification', () => {
    it('classifies pure prose with no braces as no-json', () => {
        // Real-world failure: opencode + GLM 5.1 emitted exploration text
        // with no final JSON. The CLI agent gave up before converging.
        const raw = `Let me investigate the codebase to verify several potential issues I've spotted in the diff.Good — \`custom_debug::Debug\` and \`bytes_debug_fmt\` are well-established in the codebase. Let me verify one more edge case and check the test file.Let me verify the \`sanitize_file_name\` edge cases for "." and ".."`;
        const result = parseStructuredReviewExt(raw);
        expect(result.review).toBeNull();
        expect(result.failureKind).toBe('no-json');
    });

    it('classifies a candidate with broken JSON as malformed-json', () => {
        // Trailing comma — no JSON.parse will accept this.
        const raw = '{"summary": "x", "issues": [], "decision": "APPROVE",}';
        const result = parseStructuredReviewExt(raw);
        expect(result.review).toBeNull();
        expect(result.failureKind).toBe('malformed-json');
    });

    it('classifies parsable JSON in wrong shape as invalid-shape', () => {
        // Valid JSON, but no summary, no issues, no justification — the
        // validator rejects it. Distinct from "model emitted nothing".
        const raw = '{"foo": "bar"}';
        const result = parseStructuredReviewExt(raw);
        expect(result.review).toBeNull();
        expect(result.failureKind).toBe('invalid-shape');
    });

    it('returns success for valid review JSON wrapped in conversational prose', () => {
        const raw = `Sure, here's my review:\n\n{"summary": "ok", "issues": [], "decision": "APPROVE", "justification": "lgtm"}\n\nLet me know if you have questions.`;
        const result = parseStructuredReviewExt(raw);
        expect(result.review).not.toBeNull();
        expect(result.failureKind).toBeUndefined();
    });

    it('parseStructuredReview legacy signature still returns null on failure', () => {
        // Callers that haven't migrated to parseStructuredReviewExt should
        // continue to work — same null-on-failure shape.
        expect(parseStructuredReview('not json at all')).toBeNull();
    });
});

describe('renderReviewForApi', () => {
    function makeReview(over: Partial<StructuredReview> = {}): StructuredReview {
        return {
            summary: 'PR adds caching',
            decision: 'CHANGES_REQUESTED',
            justification: 'Two P1s before merge',
            issues: [
                { priority: 'P1', title: 'Race in cache invalidation', file: 'src/cache.ts:L42-L50', path: 'src/cache.ts', lineStart: 42, lineEnd: 50, problem: 'concurrent puts can stomp', fix: 'wrap in mutex' },
                { priority: 'P3', title: 'Magic number', file: 'src/cache.ts:L100', path: 'src/cache.ts', lineStart: 100, lineEnd: 100, problem: '', fix: '' },
                { priority: 'P2', title: 'Missing test', file: 'src/cache.ts', path: 'src/cache.ts', problem: 'uncovered branch', fix: 'add test' },
            ],
            ...over,
        };
    }

    it('builds inline comments for issues with line info', () => {
        const payload = renderReviewForApi(makeReview());
        expect(payload.comments).toHaveLength(2);
        expect(payload.comments[0]).toMatchObject({
            path: 'src/cache.ts', line: 50, start_line: 42, side: 'RIGHT',
        });
        expect(payload.comments[1]).toMatchObject({
            path: 'src/cache.ts', line: 100, side: 'RIGHT',
        });
        expect(payload.comments[1].start_line).toBeUndefined();
    });

    it('omits start_line for single-line issues', () => {
        const payload = renderReviewForApi(makeReview({
            issues: [{ priority: 'P3', title: 't', file: 'src/foo.ts:L7', path: 'src/foo.ts', lineStart: 7, lineEnd: 7, problem: '', fix: '' }],
        }));
        expect(payload.comments[0].start_line).toBeUndefined();
        expect(payload.comments[0].line).toBe(7);
    });

    it('lists orphan issues in the body', () => {
        const payload = renderReviewForApi(makeReview());
        expect(payload.body).toContain('Issues without diff anchor');
        expect(payload.body).toContain('Missing test');
        // Anchored issues should NOT also appear in the body's orphan section.
        expect(payload.body).not.toContain('Race in cache invalidation');
    });

    it('embeds the run-id marker when provided', () => {
        const payload = renderReviewForApi(makeReview(), 'abc-xyz');
        expect(payload.body.startsWith('<!-- sokuza:run-id=abc-xyz -->')).toBe(true);
    });

    it('omits the marker when not provided', () => {
        const payload = renderReviewForApi(makeReview());
        expect(payload.body).not.toContain('sokuza:run-id');
    });

    it('maps decision to event', () => {
        expect(renderReviewForApi(makeReview({ decision: 'CHANGES_REQUESTED' })).event).toBe('REQUEST_CHANGES');
        expect(renderReviewForApi(makeReview({ decision: 'APPROVE' })).event).toBe('COMMENT');
    });

    it('produces a usable body with no issues', () => {
        const payload = renderReviewForApi(makeReview({ issues: [], decision: 'APPROVE' }));
        expect(payload.comments).toHaveLength(0);
        expect(payload.body).toContain('PR adds caching');
        expect(payload.event).toBe('COMMENT');
    });
});
