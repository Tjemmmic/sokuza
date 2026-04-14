/**
 * Shared review templates and constants for consistent AI reviews.
 *
 * Provides standardized output formats, priority systems, and review guidelines
 * across all PR review workflows.
 */

/**
 * Priority levels for review issues.
 */
export enum ReviewPriority {
    P1 = 'P1',
    P2 = 'P2',
    P3 = 'P3',
}

/**
 * Priority level metadata.
 */
export interface PriorityLevel {
    level: ReviewPriority;
    name: string;
    description: string;
    emoji: string;
    blocksMerge: boolean;
}

/**
 * Priority level definitions.
 */
export const PRIORITY_LEVELS: Readonly<Record<ReviewPriority, PriorityLevel>> = {
    [ReviewPriority.P1]: {
        level: ReviewPriority.P1,
        name: 'Blocking',
        description: 'Bugs that WILL cause failures, security vulnerabilities, data loss risks, crashes, broken API contracts',
        emoji: '❗',
        blocksMerge: true,
    },
    [ReviewPriority.P2]: {
        level: ReviewPriority.P2,
        name: 'Should Fix',
        description: 'Missing error handling, untested logic paths, performance regressions, maintainability problems, missing input validation, type safety gaps',
        emoji: '⚠️',
        blocksMerge: false,
    },
    [ReviewPriority.P3]: {
        level: ReviewPriority.P3,
        name: 'Nice to Have',
        description: 'Readability improvements, naming suggestions, minor code style, documentation improvements, minor duplication',
        emoji: 'ℹ️',
        blocksMerge: false,
    },
};

/**
 * Review decision types.
 */
export enum ReviewDecision {
    APPROVE = 'APPROVE',
    CHANGES_REQUESTED = 'CHANGES_REQUESTED',
    COMMENT = 'COMMENT',
}

/**
 * Review issue structure.
 */
export interface ReviewIssue {
    priority: ReviewPriority;
    title: string;
    file: string;
    lineRange: string;
    problem: string;
    fix: string;
}

/**
 * Approval thresholds for review decisions.
 */
export interface ApprovalThresholds {
    maxP1: number; // Default: 0 (any P1 blocks)
    maxP2: number; // Default: 3 (3+ P2s blocks)
}

/**
 * Default approval thresholds.
 */
export const DEFAULT_THRESHOLDS: Readonly<ApprovalThresholds> = {
    maxP1: 0,
    maxP2: 3,
};

/**
 * Standardized review output format.
 */
export const STANDARD_OUTPUT_FORMAT = `
For each issue found, output exactly this format:

\`\`\`
{{PRIORITY_EMOJI}} {{PRIORITY_LEVEL}} — [Specific, descriptive title]

**File:** \`path/to/file.ts:L42-L50\`

**Problem:** [What is wrong and WHY it's a problem. Be concrete.]

**Fix:** [Exact suggestion — show code if possible]

---
\`\`\`

## Final Decision (REQUIRED — this determines the review status)

Count your findings, then apply these rules STRICTLY:

\`# ✅ APPROVE\` — Zero P1s AND fewer than {{MAX_P2}} P2s. The code is genuinely ready to merge with at most minor follow-ups.

\`# ❌ CHANGES REQUESTED\` — ANY of these conditions:
- Any P1 issue exists
- {{MAX_P2}} or more P2 issues exist (even if no single one is critical, the cumulative risk means this PR needs another pass)
- A P2 issue indicates missing tests for significant new logic

After the decision, list a one-line summary of each issue for quick reference.
`;

/**
 * Mandatory checklist for all code reviews.
 */
export const MANDATORY_CHECKLIST = `
## Mandatory Checklist (All PRs)

- [ ] **Error Handling**: Are errors caught? Propagated correctly? Are there unhandled promise rejections or missing try/catch blocks?
- [ ] **Type Safety**: Any \`any\` casts, non-null assertions, or unsafe type coercions that could hide bugs?
- [ ] **Edge Cases**: What happens with null, undefined, empty arrays, zero, negative numbers, very large inputs?
- [ ] **Security**: SQL injection, XSS, SSRF, path traversal, secrets in code, insecure defaults?
- [ ] **Race Conditions**: Concurrent access, TOCTOU bugs, missing locks or atomicity?
- [ ] **Resource Cleanup**: Unclosed handles, missing cleanup in finally blocks, memory leaks?
- [ ] **API Contract**: Does the change break any existing callers or consumers? Are return types stable?
- [ ] **Project Guidelines**: Read \`CLAUDE.md\` if it exists, \`.memory/pitfalls/\` if it exists (flag violations as P1)
- [ ] **Tests**: Check whether tests exist for the changed code. If significant logic changed and no tests were added or updated, flag it as P2.
- [ ] **Documentation**: Check if documentation needs updating (README, JSDoc, API docs).
`;

/**
 * Standardized review rules.
 */
export const REVIEW_RULES = `
## Rules

- Be SKEPTICAL by default. Start from "what could go wrong?" not "this looks fine."
- Focus ONLY on concrete issues in the actual diff. No hypothetical advice.
- Every issue MUST reference a specific file and line number.
- Do NOT praise the code or add filler. Issues only, then the decision.
- Do NOT approve just because no single issue is critical — cumulative risk matters.
- If you're unsure whether something is a bug, investigate it (read the code, check callers) before dismissing it.
- No \`Co-Authored-By\` or AI attribution in the output.
- If genuinely no issues: output "No issues found." then \`# ✅ APPROVE\`
`;

/**
 * Generate system prompt for code review.
 */
export function generateCodeReviewPrompt(thresholds?: ApprovalThresholds): string {
    const thresholdsToUse = thresholds ?? DEFAULT_THRESHOLDS;
    const outputFormat = STANDARD_OUTPUT_FORMAT
        .replace('{{MAX_P2}}', String(thresholdsToUse.maxP2));

    return `You are a senior staff engineer conducting a thorough, skeptical code review. Your job is to catch real bugs, security issues, and architectural mistakes BEFORE they reach production. Do NOT rubber-stamp this PR.

${MANDATORY_CHECKLIST.trim()}

${REVIEW_RULES.trim()}

${outputFormat.trim()}`;
}

/**
 * Generate markdown header for review comments.
 */
export function generateReviewHeader(): string {
    return `## 🤖 AI Code Review`;
}

/**
 * Generate markdown footer for review comments.
 */
export function generateReviewFooter(model: string, provider: string): string {
    return `---
_Reviewed by Sokuza AI (${model}, via ${provider})_`;
}

/**
 * Determine review decision based on issue counts.
 */
export function determineDecision(
    p1Count: number,
    p2Count: number,
    thresholds: ApprovalThresholds = DEFAULT_THRESHOLDS,
): ReviewDecision {
    if (p1Count > 0) {
        return ReviewDecision.CHANGES_REQUESTED;
    }
    if (p2Count >= thresholds.maxP2) {
        return ReviewDecision.CHANGES_REQUESTED;
    }
    return ReviewDecision.APPROVE;
}

/**
 * Parse decision from AI review response.
 */
export function parseDecisionFromResponse(review: string): ReviewDecision | null {
    if (review.includes('# ✅ APPROVE') || review.includes('# ✅ APPROVED')) {
        return ReviewDecision.APPROVE;
    }
    if (review.includes('# ❌ CHANGES REQUESTED')) {
        return ReviewDecision.CHANGES_REQUESTED;
    }
    return null;
}
