import { describe, it, expect } from 'vitest';
import {
    determineDecision,
    parseDecisionFromResponse,
    generateCodeReviewPrompt,
    parseStructuredReview,
    renderReviewMarkdown,
    ReviewDecision,
    ReviewPriority,
    DEFAULT_THRESHOLDS,
    type StructuredReview,
} from './review-templates.js';

describe('determineDecision', () => {
    it('approves when there are no issues', () => {
        expect(determineDecision(0, 0)).toBe(ReviewDecision.APPROVE);
    });

    it('requests changes for any P1', () => {
        expect(determineDecision(1, 0)).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('requests changes when P2 count reaches threshold (default 3)', () => {
        expect(determineDecision(0, 3)).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('approves when P2 count is below threshold', () => {
        expect(determineDecision(0, 2)).toBe(ReviewDecision.APPROVE);
    });

    it('requests changes for multiple P1s', () => {
        expect(determineDecision(5, 0)).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('respects custom thresholds', () => {
        const custom = { maxP1: 1, maxP2: 5 };
        expect(determineDecision(0, 4, custom)).toBe(ReviewDecision.APPROVE);
        expect(determineDecision(0, 5, custom)).toBe(ReviewDecision.CHANGES_REQUESTED);
    });
});

describe('parseDecisionFromResponse', () => {
    it('parses APPROVE marker', () => {
        expect(parseDecisionFromResponse('## Summary\n\n# ✅ APPROVE')).toBe(ReviewDecision.APPROVE);
    });

    it('parses APPROVED variant', () => {
        expect(parseDecisionFromResponse('# ✅ APPROVED')).toBe(ReviewDecision.APPROVE);
    });

    it('parses CHANGES REQUESTED marker', () => {
        expect(parseDecisionFromResponse('# ❌ CHANGES REQUESTED')).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('returns null when no decision marker is present', () => {
        expect(parseDecisionFromResponse('This is a review with no decision.')).toBe(null);
    });

    it('finds decision within surrounding text', () => {
        const review = `Here are my findings.\n\nSome analysis here.\n\n# ✅ APPROVE\n\nLooks good.`;
        expect(parseDecisionFromResponse(review)).toBe(ReviewDecision.APPROVE);
    });

    it('parses decision at H3 (current format)', () => {
        expect(parseDecisionFromResponse('### ✅ APPROVE')).toBe(ReviewDecision.APPROVE);
        expect(parseDecisionFromResponse('### ❌ CHANGES REQUESTED')).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('parses decision at H2 or H4 (tolerant of minor drift)', () => {
        expect(parseDecisionFromResponse('## ✅ APPROVE')).toBe(ReviewDecision.APPROVE);
        expect(parseDecisionFromResponse('#### ❌ CHANGES REQUESTED')).toBe(ReviewDecision.CHANGES_REQUESTED);
    });

    it('ignores decisions mentioned in body text (not as a heading)', () => {
        const review = 'Some prose that mentions ✅ APPROVE inline without a leading hash.';
        expect(parseDecisionFromResponse(review)).toBe(null);
    });
});

describe('parseStructuredReview', () => {
    const validJson = JSON.stringify({
        summary: 'Adds a helper.',
        issues: [
            { priority: 'P2', title: 'Missing test', file: 'src/a.ts:L1', problem: 'No test.', fix: 'Add one.' },
        ],
        decision: 'CHANGES_REQUESTED',
        justification: 'Needs a test before merging.',
    });

    it('parses bare JSON', () => {
        const r = parseStructuredReview(validJson);
        expect(r).not.toBeNull();
        expect(r!.decision).toBe('CHANGES_REQUESTED');
        expect(r!.issues).toHaveLength(1);
        expect(r!.issues[0].priority).toBe('P2');
    });

    it('parses JSON wrapped in a ```json fence', () => {
        const wrapped = 'Here is the review:\n\n```json\n' + validJson + '\n```';
        const r = parseStructuredReview(wrapped);
        expect(r).not.toBeNull();
        expect(r!.issues).toHaveLength(1);
    });

    it('parses JSON with leading/trailing prose', () => {
        const noisy = `Let me think…\n\n${validJson}\n\nThat's my review.`;
        const r = parseStructuredReview(noisy);
        expect(r).not.toBeNull();
        expect(r!.decision).toBe('CHANGES_REQUESTED');
    });

    it('returns null when no valid JSON is present', () => {
        expect(parseStructuredReview('just some markdown')).toBeNull();
    });

    it('drops issues with unknown priority values (defensive)', () => {
        const bad = JSON.stringify({
            summary: 's',
            issues: [
                { priority: 'URGENT', title: 'x', file: '', problem: '', fix: '' },
                { priority: 'P1', title: 'real', file: '', problem: '', fix: '' },
            ],
            decision: 'CHANGES_REQUESTED',
            justification: 'j',
        });
        const r = parseStructuredReview(bad);
        expect(r!.issues).toHaveLength(1);
        expect(r!.issues[0].title).toBe('real');
    });

    it('defaults decision to APPROVE when unrecognized value is given', () => {
        const weird = JSON.stringify({
            summary: 's', issues: [], decision: 'MAYBE', justification: 'j',
        });
        expect(parseStructuredReview(weird)!.decision).toBe('APPROVE');
    });
});

describe('renderReviewMarkdown', () => {
    it('renders a clean markdown comment for a review with issues', () => {
        const review: StructuredReview = {
            summary: 'Adds a helper.',
            issues: [
                { priority: ReviewPriority.P1, title: 'Null deref', file: 'src/a.ts:L1', problem: 'Crashes on null.', fix: 'Add guard.' },
                { priority: ReviewPriority.P3, title: 'Naming', file: 'src/b.ts:L5', problem: 'Unclear.', fix: 'Rename.' },
            ],
            decision: 'CHANGES_REQUESTED',
            justification: 'One P1 blocks.',
        };
        const md = renderReviewMarkdown(review);

        // Structural checks — exact heading levels are load-bearing for the
        // outer `## 🤖 AI Code Review` that sokuza prepends.
        expect(md).toContain('### Summary');
        expect(md).toContain('### Issues Found');
        expect(md).toContain('**2 total**');
        expect(md).toContain('#### ❗ P1 — Null deref');
        expect(md).toContain('#### ℹ️ P3 — Naming');
        expect(md).toContain('- **File:** `src/a.ts:L1`');
        expect(md).toContain('### ❌ CHANGES REQUESTED');
        expect(md).toContain('### Quick Reference');
        expect(md).toContain('- **P1**: Null deref');

        // And the anti-patterns that broke past renders:
        expect(md).not.toMatch(/^#\s/m);          // no H1
        expect(md).not.toContain('```\n❗');       // no issue wrapped in a fence
    });

    it('renders an APPROVE block when there are no issues', () => {
        const md = renderReviewMarkdown({
            summary: 'Simple refactor.',
            issues: [],
            decision: 'APPROVE',
            justification: 'Looks clean.',
        });
        expect(md).toContain('### No Issues Found');
        expect(md).toContain('### ✅ APPROVE');
        expect(md).not.toContain('### Quick Reference');
    });

    it('parseDecisionFromResponse works with the rendered markdown (round-trip)', () => {
        const md = renderReviewMarkdown({
            summary: 's', issues: [], decision: 'APPROVE', justification: 'j',
        });
        expect(parseDecisionFromResponse(md)).toBe(ReviewDecision.APPROVE);
    });

    it('parseDecisionFromResponse works on raw JSON (structured preferred over regex)', () => {
        const raw = JSON.stringify({
            summary: 's', issues: [], decision: 'CHANGES_REQUESTED', justification: 'j',
        });
        expect(parseDecisionFromResponse(raw)).toBe(ReviewDecision.CHANGES_REQUESTED);
    });
});

describe('generateCodeReviewPrompt', () => {
    it('contains the default max P2 threshold value', () => {
        const prompt = generateCodeReviewPrompt();
        expect(prompt).toContain(`fewer than ${DEFAULT_THRESHOLDS.maxP2} P2s`);
    });

    it('uses default thresholds when none are provided', () => {
        const defaultPrompt = generateCodeReviewPrompt();
        const explicitPrompt = generateCodeReviewPrompt(DEFAULT_THRESHOLDS);
        expect(defaultPrompt).toBe(explicitPrompt);
    });

    it('uses custom thresholds when provided', () => {
        const prompt = generateCodeReviewPrompt({ maxP1: 0, maxP2: 10 });
        expect(prompt).toContain('fewer than 10 P2s');
    });

    it('includes mandatory checklist', () => {
        const prompt = generateCodeReviewPrompt();
        expect(prompt).toContain('Mandatory Checklist');
    });

    it('includes review rules', () => {
        const prompt = generateCodeReviewPrompt();
        expect(prompt).toContain('Be SKEPTICAL');
    });

    it('instructs the model to return JSON (not markdown)', () => {
        const prompt = generateCodeReviewPrompt();
        expect(prompt).toContain('SINGLE JSON object');
        expect(prompt).toContain('"priority"');
        expect(prompt).toContain('"decision"');
        // No residual markdown-formatting instructions:
        expect(prompt).not.toContain('#### {{PRIORITY_EMOJI}}');
    });
});
