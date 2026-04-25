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
 *
 * We ask the model for **structured JSON**, not hand-formatted markdown.
 * Renderer-side formatting means we don't depend on every AI model
 * (GLM, Claude, GPT-4, etc.) correctly obeying a long list of markdown
 * rules — some ignore heading levels, some add stray fences, some flatten
 * lists. JSON is a target every modern model hits reliably.
 *
 * The action layer parses this JSON and calls \`renderReviewMarkdown()\`
 * to produce the final GitHub comment. If parsing fails, the raw text
 * is still posted with a warning so the user gets *something*.
 */
export const STANDARD_OUTPUT_FORMAT = `
## Output format (strict JSON — no markdown, no prose before or after)

Respond with a SINGLE JSON object matching the schema below. Do NOT wrap it in a code fence. Do NOT add explanatory text before or after. The FIRST character of your response MUST be \`{\` and the LAST must be \`}\`.

Schema:

{
  "summary": "1-3 sentence plain-text overview of what the PR does and your overall take. No markdown in this field.",
  "issues": [
    {
      "priority": "P1" | "P2" | "P3",
      "title": "Specific, descriptive one-line title. Plain text only.",
      "file": "path/to/file.ts:L42-L50",
      "problem": "What is wrong and WHY it's a problem. Concrete. Inline backticks for identifiers are OK.",
      "fix": "Exact fix suggestion. You MAY include fenced code blocks inside this field when showing code — use \\\`\\\`\\\` as fence markers."
    }
  ],
  "decision": "APPROVE" | "CHANGES_REQUESTED",
  "justification": "Short paragraph explaining the decision. Plain text, max ~3 sentences."
}

Decision rules (STRICT):

- \`APPROVE\` — Zero P1s AND fewer than {{MAX_P2}} P2s. Ready to merge with at most minor follow-ups.
- \`CHANGES_REQUESTED\` — ANY of:
  - At least one P1 issue exists.
  - {{MAX_P2}} or more P2 issues exist (cumulative risk warrants another pass).
  - A P2 issue indicates missing tests for significant new logic.

If the PR is genuinely fine: return an empty \`issues\` array and \`"decision": "APPROVE"\`.

Remember: JSON only. No leading commentary, no trailing commentary. First character \`{\`, last character \`}\`.
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
- If genuinely no issues: return \`issues: []\` and \`decision: "APPROVE"\` with a one-sentence \`summary\` and \`justification\`.
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
 *
 * Works with both the current JSON-based format and the older markdown-
 * heading format — so a review posted before this migration is still
 * parseable by any downstream tooling. Tries JSON first; falls back to
 * the heading regex.
 */
export function parseDecisionFromResponse(review: string): ReviewDecision | null {
    const structured = parseStructuredReview(review);
    if (structured) {
        return structured.decision === 'CHANGES_REQUESTED'
            ? ReviewDecision.CHANGES_REQUESTED
            : ReviewDecision.APPROVE;
    }

    // Legacy markdown: match any heading level so minor drift doesn't change the outcome.
    if (/^#{1,6}\s*✅\s*APPROVED?\b/m.test(review)) {
        return ReviewDecision.APPROVE;
    }
    if (/^#{1,6}\s*❌\s*CHANGES\s+REQUESTED\b/m.test(review)) {
        return ReviewDecision.CHANGES_REQUESTED;
    }
    return null;
}

// ─── Structured review (JSON in, markdown out) ──────────────────────────────

/**
 * Shape the model is asked to return (matches STANDARD_OUTPUT_FORMAT).
 * Decision values are the raw JSON strings; the action layer maps them
 * into \`ReviewDecision\` enum values if needed.
 */
export interface StructuredReview {
    summary: string;
    issues: Array<{
        priority: ReviewPriority;
        title: string;
        /** Original `file` string from the model — kept verbatim for UI
         *  display and run-store records. Often of the form
         *  `path/to/file.ts:L42-L50`. */
        file: string;
        /** Filename portion only, parsed out of `file`. Empty when the
         *  model omitted it or used an unrecognized format. */
        path: string;
        /** First line of the issue range, parsed from `file`. */
        lineStart?: number;
        /** Last line of the issue range. Equals `lineStart` for single-line. */
        lineEnd?: number;
        problem: string;
        fix: string;
    }>;
    decision: 'APPROVE' | 'CHANGES_REQUESTED';
    justification: string;
}

/** Split a `file` string like `src/foo.ts:L42-L50` into `{path, lineStart, lineEnd}`.
 *  Returns `{path: input, lineStart: undefined, lineEnd: undefined}` if no
 *  recognizable line range is present. Accepts `:42`, `:L42`, `:L42-L50`,
 *  `:L42-50`, `#L42`, `#L42-L50`. */
export function parseFileLocation(raw: string): { path: string; lineStart?: number; lineEnd?: number } {
    if (!raw) return { path: '' };
    // Match path[:#]L?N[-L?N]?  at end of string.
    const m = raw.match(/^(.+?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$/);
    if (!m) return { path: raw };
    const path = m[1] ?? raw;
    const lineStart = m[2] ? parseInt(m[2], 10) : undefined;
    const lineEnd = m[3] ? parseInt(m[3], 10) : lineStart;
    return { path, lineStart, lineEnd };
}

/**
 * Extract and validate the structured review from the model's raw output.
 *
 * We accept a few forms because different models wrap JSON differently:
 *  - bare JSON (preferred — matches the prompt)
 *  - JSON inside a fenced code block (\`\`\`json … \`\`\`)
 *  - JSON with leading/trailing prose (we slice between the first \`{\` and last \`}\`)
 *
 * Returns \`null\` when nothing parseable is found; callers should fall
 * back to posting the raw text with a warning.
 */
export function parseStructuredReview(raw: string): StructuredReview | null {
    const candidates: string[] = [];
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) candidates.push(trimmed);

    // ```json … ``` fence
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) candidates.push(fence[1].trim());

    // Broadest fallback: slice between first '{' and last '}'
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const validated = validateStructuredReview(parsed);
            if (validated) return validated;
        } catch { /* try next */ }
    }
    return null;
}

function validateStructuredReview(raw: unknown): StructuredReview | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const summary = typeof obj.summary === 'string' ? obj.summary : '';
    const decision = obj.decision === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVE';
    const justification = typeof obj.justification === 'string' ? obj.justification : '';
    const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];

    const issues: StructuredReview['issues'] = [];
    for (const rawIssue of rawIssues) {
        if (!rawIssue || typeof rawIssue !== 'object') continue;
        const i = rawIssue as Record<string, unknown>;
        const priority = i.priority;
        if (priority !== 'P1' && priority !== 'P2' && priority !== 'P3') continue;
        const file = typeof i.file === 'string' ? i.file : '';
        const loc = parseFileLocation(file);
        issues.push({
            priority: priority as ReviewPriority,
            title: typeof i.title === 'string' ? i.title : '(no title)',
            file,
            path: loc.path,
            lineStart: loc.lineStart,
            lineEnd: loc.lineEnd,
            problem: typeof i.problem === 'string' ? i.problem : '',
            fix: typeof i.fix === 'string' ? i.fix : '',
        });
    }

    // A review is "valid" if it at least has a summary or a decision we
    // recognize — we're forgiving of missing fields because the alternative
    // is throwing away an otherwise-usable review.
    if (!summary && issues.length === 0 && !justification) return null;

    return { summary, issues, decision, justification };
}

/**
 * Render a structured review into the markdown that gets posted as a
 * GitHub PR comment. Deterministic: same input always produces the
 * same output. Model obedience is no longer a factor here.
 */
export function renderReviewMarkdown(review: StructuredReview): string {
    const lines: string[] = [];

    if (review.summary) {
        lines.push('### Summary', '', review.summary, '');
    }

    if (review.issues.length === 0) {
        lines.push('### No Issues Found', '');
    } else {
        const counts = { P1: 0, P2: 0, P3: 0 };
        for (const issue of review.issues) counts[issue.priority]++;
        lines.push('### Issues Found');
        lines.push(
            `**${review.issues.length} total** — ` +
            `${counts.P1} P1 (blocking) · ${counts.P2} P2 (should fix) · ${counts.P3} P3 (nice to have)`,
        );
        lines.push('');

        for (const issue of review.issues) {
            const emoji = PRIORITY_LEVELS[issue.priority].emoji;
            lines.push(`#### ${emoji} ${issue.priority} — ${issue.title}`);
            lines.push('');
            if (issue.file) lines.push(`- **File:** \`${issue.file}\``);
            if (issue.problem) lines.push(`- **Problem:** ${issue.problem}`);
            if (issue.fix) lines.push(`- **Fix:** ${issue.fix}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    const decisionHeading = review.decision === 'CHANGES_REQUESTED'
        ? '### ❌ CHANGES REQUESTED'
        : '### ✅ APPROVE';
    lines.push(decisionHeading);
    if (review.justification) {
        lines.push('');
        lines.push(review.justification);
    }
    lines.push('');

    if (review.issues.length > 0) {
        lines.push('### Quick Reference');
        for (const issue of review.issues) {
            lines.push(`- **${issue.priority}**: ${issue.title}`);
        }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ReviewApiPayload {
    /** Top-level body text. Includes summary, decision, and any issues
     *  that couldn't be anchored to specific lines. */
    body: string;
    /** Inline review comments anchored to file+line. */
    comments: Array<{
        path: string;
        line: number;
        side: 'RIGHT';
        start_line?: number;
        body: string;
    }>;
    /** GitHub review state derived from `decision`. */
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
}

/**
 * Render a structured review for posting via the PR Reviews API.
 *
 * Issues with a parseable file path AND line number become inline
 * comments anchored to the diff. Issues without anchoring info land in
 * the body so reviewers still see them. The body always carries summary
 * + decision + justification at minimum.
 *
 * `markerRunId`, when present, is embedded as `<!-- sokuza:run-id=ID -->`
 * at the top of the body so trigger filters can identify AI reviews
 * without relying on the comment author.
 */
export function renderReviewForApi(
    review: StructuredReview,
    markerRunId?: string,
): ReviewApiPayload {
    const event = review.decision === 'CHANGES_REQUESTED' ? 'REQUEST_CHANGES' : 'COMMENT';
    const comments: ReviewApiPayload['comments'] = [];
    const orphans: typeof review.issues = [];

    for (const issue of review.issues) {
        if (issue.path && typeof issue.lineStart === 'number' && issue.lineStart > 0) {
            const body = formatIssueBody(issue);
            const comment: ReviewApiPayload['comments'][number] = {
                path: issue.path,
                line: issue.lineEnd ?? issue.lineStart,
                side: 'RIGHT',
                body,
            };
            if (issue.lineEnd && issue.lineEnd !== issue.lineStart) {
                comment.start_line = issue.lineStart;
            }
            comments.push(comment);
        } else {
            orphans.push(issue);
        }
    }

    const bodyLines: string[] = [];
    if (markerRunId) bodyLines.push(`<!-- sokuza:run-id=${markerRunId} -->`);
    if (review.summary) bodyLines.push(review.summary, '');

    const counts = { P1: 0, P2: 0, P3: 0 };
    for (const issue of review.issues) counts[issue.priority]++;
    if (review.issues.length > 0) {
        bodyLines.push(
            `**${review.issues.length} issues** — ${counts.P1} P1 · ${counts.P2} P2 · ${counts.P3} P3` +
            (comments.length > 0 ? ` · ${comments.length} commented inline below` : ''),
            '',
        );
    }

    if (orphans.length > 0) {
        bodyLines.push('### Issues without diff anchor', '');
        for (const issue of orphans) {
            const emoji = PRIORITY_LEVELS[issue.priority].emoji;
            bodyLines.push(`**${emoji} ${issue.priority} — ${issue.title}**`);
            if (issue.file) bodyLines.push(`File: \`${issue.file}\``);
            if (issue.problem) bodyLines.push(`Problem: ${issue.problem}`);
            if (issue.fix) bodyLines.push(`Fix: ${issue.fix}`);
            bodyLines.push('');
        }
    }

    if (review.justification) {
        bodyLines.push('### Decision', review.justification, '');
    }

    return {
        body: bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        comments,
        event,
    };
}

function formatIssueBody(issue: StructuredReview['issues'][number]): string {
    const emoji = PRIORITY_LEVELS[issue.priority].emoji;
    const lines = [`**${emoji} ${issue.priority} — ${issue.title}**`];
    if (issue.problem) lines.push('', issue.problem);
    if (issue.fix) lines.push('', `**Fix:** ${issue.fix}`);
    return lines.join('\n');
}
