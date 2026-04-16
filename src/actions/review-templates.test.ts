import { describe, it, expect } from 'vitest';
import {
    determineDecision,
    parseDecisionFromResponse,
    generateCodeReviewPrompt,
    ReviewDecision,
    DEFAULT_THRESHOLDS,
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
});
