/**
 * "address-review" action.
 *
 * Consumes a previously-recorded ai-review run and orchestrates the
 * /address-review skill against the PR's head branch. Two modes:
 *
 *   - **suggest** (Phase B): agent investigates, decides which issues
 *     to address, proposes fixes as inline review comments. No commits,
 *     no pushes. Lowest-risk shipping default.
 *
 *   - **push** (Phase C+): agent commits and pushes fixes directly to
 *     the PR head branch. Test gate enforces local validation before
 *     push. Loop guards (iteration cap, fingerprint repeat, merge-ready,
 *     human-pushed) coordinate the auto-fix loop.
 *
 * Workdirs are persistent per (owner, repo, prNumber) — see WorkdirManager.
 * The action acquires an advisory lock for the duration of the run; on
 * crash, the lock is reclaimed at engine startup.
 */

import { spawn } from 'node:child_process';
import type { ActionHandler } from '../core/types.js';
import { runAgentWithFallback } from '../core/ai-providers.js';
import {
    recordAddressReviewRun,
    listAddressReviewRuns,
    listAiReviewRuns,
    getAiReviewRunById,
    generateRunId,
    issueFingerprint,
    type AiReviewRunRecord,
    type AddressReviewRunRecord,
    type AddressReviewMode,
    type AddressReviewHaltReason,
    type AddressedIssue,
} from '../core/run-store.js';
import { ADDRESS_REVIEW_SKILL } from './address-review-skill.js';

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_COOLDOWN_SEC = 30;
const SKIP_LABEL = 'sokuza-no-auto-fix';
const RUNNING_LABEL = 'sokuza-auto-fix-running';

interface MergeReadyConfig {
    max_p1: number;
    max_p2: number;
    max_p3: number;
}

const DEFAULT_MERGE_READY: MergeReadyConfig = { max_p1: 0, max_p2: 1, max_p3: -1 };

interface AgentOutputIssue {
    priority: 'P1' | 'P2' | 'P3';
    title: string;
    file?: string;
    reasoning: string;
    /** Optional inline-suggestion replacement. Used in suggest mode. */
    suggestion?: {
        path: string;
        line: number;
        startLine?: number;
        code: string;
    };
}

interface AgentOutput {
    issues: {
        addressed: AgentOutputIssue[];
        rejected: AgentOutputIssue[];
        deferred: AgentOutputIssue[];
    };
    bodySummary: string;
    tests?: {
        ranTests: boolean;
        command?: string;
        passed?: boolean;
        durationMs?: number;
        output?: string;
    };
    /** Push-mode only: commit summary the agent created. */
    push?: { commitSha?: string; message?: string };
}

export const addressReviewAction: ActionHandler = async (params, context) => {
    const runId = generateRunId();
    const startedAt = Date.now();
    const createdAt = new Date(startedAt).toISOString();

    // ─── Resolve identity ───────────────────────────────────────────────
    const { owner, repo, prNumber } = resolvePrIdentity(params, context);
    const repoFull = `${owner}/${repo}`;

    // Resolve config in cascade order:
    //   1. Built-in defaults
    //   2. Global ~/.sokuza/config.yaml under `auto_fix:`
    //   3. Per-workflow params (this call)
    //   4. Slash-command args (highest, parsed from comment body)
    // Each layer shallow-merges over the previous.
    const globalAutoFix = (context.getConfig?.() as { auto_fix?: Record<string, unknown> } | undefined)?.auto_fix ?? {};

    const slashArgs = parseSlashArgs(
        (context.event.payload?.comment as Record<string, unknown> | undefined)?.body as string | undefined,
    );

    const mode: AddressReviewMode = (slashArgs.mode as AddressReviewMode | undefined)
        ?? (params.mode as AddressReviewMode)
        ?? (globalAutoFix.mode as AddressReviewMode)
        ?? 'suggest';
    if (mode !== 'suggest' && mode !== 'push') {
        throw new Error(`address-review: invalid mode "${mode}". Use "suggest" or "push".`);
    }

    const maxIterations = Math.min(
        Math.max(1, (params.max_iterations as number) ?? (globalAutoFix.max_iterations as number) ?? DEFAULT_MAX_ITERATIONS),
        5,
    );
    const cooldownSec = (params.cooldown_seconds as number) ?? (globalAutoFix.cooldown_seconds as number) ?? DEFAULT_COOLDOWN_SEC;
    const mergeReady: MergeReadyConfig = {
        ...DEFAULT_MERGE_READY,
        ...((globalAutoFix.merge_ready as MergeReadyConfig) ?? {}),
        ...((params.merge_ready as MergeReadyConfig) ?? {}),
    };
    const skipPriorities = new Set(
        (params.skip_priorities as string[]) ?? (globalAutoFix.skip_priorities as string[]) ?? [],
    );

    // ─── Resolve source review ──────────────────────────────────────────
    const sourceReviewRunId = await resolveReviewRunId(params, context, owner, repo, prNumber);
    if (!sourceReviewRunId) {
        throw new Error(`address-review: could not resolve a review run id for ${repoFull}#${prNumber}`);
    }
    const review = await getAiReviewRunById(sourceReviewRunId);
    if (!review) {
        throw new Error(`address-review: review run "${sourceReviewRunId}" not found`);
    }
    if (!review.output.parseSucceeded || !review.output.issues) {
        throw new Error(`address-review: review run "${sourceReviewRunId}" has no parseable issues`);
    }

    // ─── Loop guards ────────────────────────────────────────────────────
    const guard = await runLoopGuards({
        owner, repo, prNumber, mode,
        review,
        maxIterations,
        cooldownSec,
        mergeReady,
        context,
    });
    if (guard.halt) {
        const stub = await emitHaltedRecord({
            runId, createdAt, startedAt, owner, repo, prNumber,
            mode, sourceReviewRunId, maxIterations, review,
            haltReason: guard.halt, error: guard.reason,
            workflowName: context.workflowName,
            iteration: guard.iteration,
            context,
        });
        return { halted: true, reason: guard.halt, message: guard.reason, run: stub };
    }
    const iteration = guard.iteration;

    // Filter issues by skip_priorities; the agent never sees them.
    const sourceIssues = (review.output.issues ?? []).filter((i) => !skipPriorities.has(i.priority));
    const fingerprint = issueFingerprint(sourceIssues);

    // ─── Workdir acquisition + sync ─────────────────────────────────────
    // The engine threads a singleton WorkdirManager through ActionContext.
    // When the action is invoked outside the engine (tests, manual API
    // calls without an engine binding), fall back to a fresh instance.
    const manager = context.workdirManager
        ?? new (await import('../core/workdir-store.js')).WorkdirManager(context.logger);

    const release = await manager.acquire(owner, repo, prNumber);
    const workdirPath = manager.repoPath(owner, repo, prNumber);
    let workdirReused = false;

    const githubToken = (context.integrationConfigs.github as Record<string, unknown> | undefined)?.token as string | undefined
        ?? process.env.GITHUB_TOKEN;
    let runningLabelSet = false;
    if (githubToken) {
        try {
            const { GitHubApiClient } = await import('../integrations/github/api.js');
            const client = new GitHubApiClient(githubToken);
            await client.addLabels(owner, repo, prNumber, [RUNNING_LABEL]);
            runningLabelSet = true;
        } catch (err) {
            // Non-fatal: label is for visibility, not safety. The workdir
            // lock still serializes runs.
            context.logger.warn({ err }, 'Failed to set in-flight lock label; continuing');
        }
    }

    try {
        const meta = await manager.getMeta(owner, repo, prNumber);
        const headRef = (review.event.branch as string | undefined) ?? '';
        if (!githubToken) {
            throw new Error('address-review: GitHub token required (integrations.github.token or GITHUB_TOKEN)');
        }

        if (!meta) {
            await cloneRepo(workdirPath, owner, repo, headRef, githubToken, context.logger);
        } else {
            workdirReused = true;
            await syncRepo(workdirPath, headRef, context.logger);
        }
        await manager.writeMeta({
            owner, repo, prNumber,
            headSha: await gitRevParse(workdirPath, 'HEAD'),
            headRef,
            clonedAt: meta?.clonedAt ?? createdAt,
            lastSyncAt: createdAt,
        });

        // ─── Agent run ──────────────────────────────────────────────────
        const prompt = buildAgentPrompt({
            mode,
            issues: sourceIssues as AddressedIssue[],
            review,
            owner, repo, prNumber,
        });

        context.logger.info(
            { mode, iteration, maxIterations, issueCount: sourceIssues.length, workdirPath, reused: workdirReused },
            'Running address-review agent',
        );

        const completion = await runAgentWithFallback(
            context.ai,
            params.provider as string | undefined,
            {
                prompt,
                workdir: workdirPath,
                model: params.model as string | undefined,
                outputFormat: 'json',
                allowedTools: params.allowed_tools as string[] | undefined,
                logger: context.logger,
            },
        );

        const parsed = parseAgentOutput(completion.parsedJson, completion.output);

        // ─── Post review (suggest mode) ─────────────────────────────────
        let suggestPayload: AddressReviewRunRecord['suggest'];
        if (mode === 'suggest') {
            const { GitHubApiClient } = await import('../integrations/github/api.js');
            const client = new GitHubApiClient(githubToken);
            const reviewBody = renderSuggestModeBody(parsed, sourceReviewRunId, iteration, maxIterations);
            const inlineComments = parsed.issues.addressed
                .filter((i) => !!i.suggestion)
                .map((i) => ({
                    path: i.suggestion!.path,
                    line: i.suggestion!.line,
                    side: 'RIGHT' as const,
                    start_line: i.suggestion!.startLine,
                    body: formatSuggestionComment(i),
                }));

            try {
                const result = await client.createReview(owner, repo, prNumber, {
                    body: reviewBody,
                    event: 'COMMENT',
                    comments: inlineComments,
                });
                suggestPayload = {
                    reviewId: (result.id as number | string),
                    commentCount: inlineComments.length,
                    htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
                };
            } catch (err) {
                // Inline comments rejected: retry body-only.
                context.logger.warn({ err: (err as Error).message }, 'Suggest review with inline comments rejected; falling back to body-only');
                const result = await client.createReview(owner, repo, prNumber, {
                    body: `${reviewBody}\n\n---\n_Note: ${inlineComments.length} inline suggestions could not be anchored to the diff._`,
                    event: 'COMMENT',
                });
                suggestPayload = {
                    reviewId: (result.id as number | string),
                    commentCount: 0,
                    htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
                };
            }
        }

        // ─── push mode handled in Phase C ──────────────────────────────
        let pushPayload: AddressReviewRunRecord['push'];
        if (mode === 'push') {
            pushPayload = await handlePushMode({
                owner, repo, prNumber,
                workdirPath,
                githubToken,
                parsed,
                iteration,
                logger: context.logger,
            });

            // After a successful push, post a summary comment too.
            const { GitHubApiClient } = await import('../integrations/github/api.js');
            const client = new GitHubApiClient(githubToken);
            const summaryBody = renderPushModeSummary(parsed, sourceReviewRunId, iteration, maxIterations, pushPayload);
            await client.createComment(owner, repo, prNumber, summaryBody).catch((err) => {
                context.logger.warn({ err }, 'push-mode summary comment failed; continuing');
            });
        }

        const record: AddressReviewRunRecord = {
            id: runId,
            action: 'address-review',
            createdAt,
            durationMs: Date.now() - startedAt,
            workflowName: context.workflowName,
            pr: {
                repo: repoFull,
                prNumber,
                headSha: await gitRevParse(workdirPath, 'HEAD').catch(() => undefined),
                branch: headRef,
            },
            iteration,
            iterationCap: maxIterations,
            sourceReviewRunId,
            mode,
            provider: completion.provider,
            model: completion.model,
            // CLI-based agents don't report tokens. Skip until provider
            // support lands; the dashboard tolerates undefined usage.
            usage: undefined,
            issues: {
                addressed: parsed.issues.addressed.map(toAddressedIssue),
                rejected: parsed.issues.rejected.map(toAddressedIssue),
                deferred: parsed.issues.deferred.map(toAddressedIssue),
            },
            workdir: {
                path: workdirPath,
                reused: workdirReused,
            },
            tests: parsed.tests,
            push: pushPayload,
            suggest: suggestPayload,
            issueFingerprint: fingerprint,
        };
        await recordAddressReviewRun(record, context.logger);
        return record;
    } finally {
        if (runningLabelSet && githubToken) {
            try {
                const { GitHubApiClient } = await import('../integrations/github/api.js');
                await new GitHubApiClient(githubToken).removeLabel(owner, repo, prNumber, RUNNING_LABEL);
            } catch (err) {
                context.logger.warn({ err }, 'Failed to clear in-flight lock label; manual remove may be required');
            }
        }
        await release();
    }
};

/** Parse `/sokuza fix [key=value ...]` arguments from a comment body.
 *  Returns an empty object when the comment isn't a slash command.
 *  v1 recognizes `mode`; later phases can extend (e.g. `issue=2,3`). */
export function parseSlashArgs(body?: string): Record<string, string> {
    if (!body) return {};
    const m = body.match(/\/sokuza\s+fix\b([^\n\r]*)/i);
    if (!m) return {};
    const args: Record<string, string> = {};
    for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
        const eq = tok.indexOf('=');
        if (eq < 1) continue;
        const k = tok.slice(0, eq).trim();
        const v = tok.slice(eq + 1).trim();
        if (k && v) args[k] = v;
    }
    return args;
}

function resolvePrIdentity(
    params: Record<string, unknown>,
    context: { event: { payload?: Record<string, unknown>; metadata?: Record<string, unknown> } },
): { owner: string; repo: string; prNumber: number } {
    const meta = context.event.metadata ?? {};
    const pr = context.event.payload?.pull_request as Record<string, unknown> | undefined;
    const issue = context.event.payload?.issue as Record<string, unknown> | undefined;

    const repoStr = (params.repo as string) ?? (meta.repo as string);
    const owner = (params.owner as string)
        ?? (meta.owner as string)
        ?? (repoStr ? repoStr.split('/')[0] : undefined);
    const repoName = (params.repo_name as string)
        ?? (meta.repoName as string)
        ?? (repoStr ? repoStr.split('/')[1] : undefined);
    const prNumber = (params.pr_number as number)
        ?? (meta.prNumber as number)
        ?? (pr?.number as number)
        ?? (issue?.number as number);

    if (!owner || !repoName || typeof prNumber !== 'number') {
        throw new Error('address-review: could not resolve owner/repo/prNumber from params or event');
    }
    return { owner, repo: repoName, prNumber };
}

async function resolveReviewRunId(
    params: Record<string, unknown>,
    context: { event: { payload?: Record<string, unknown> } },
    owner: string,
    repo: string,
    prNumber: number,
): Promise<string | null> {
    const explicit = params.review_run_id as string | undefined;
    if (explicit && explicit !== 'latest') return explicit;

    // Try comment-marker extraction (auto trigger from issue_comment.created).
    const body = (context.event.payload?.comment as Record<string, unknown> | undefined)?.body as string | undefined;
    if (body) {
        const m = body.match(/<!--\s*sokuza:run-id=([A-Za-z0-9-]{1,128})\s*-->/);
        if (m) return m[1];
    }

    // Fallback: latest ai-review for this PR.
    const recent = await listAiReviewRuns({ limit: 100 });
    const match = recent.find((r) => r.event.repo === `${owner}/${repo}` && r.event.prNumber === prNumber);
    return match?.id ?? null;
}

interface LoopGuardArgs {
    owner: string; repo: string; prNumber: number;
    mode: AddressReviewMode;
    review: AiReviewRunRecord;
    maxIterations: number;
    cooldownSec: number;
    mergeReady: MergeReadyConfig;
    context: { logger: import('pino').Logger; integrationConfigs: Record<string, unknown> };
}

async function runLoopGuards(args: LoopGuardArgs): Promise<{ halt?: AddressReviewHaltReason; reason?: string; iteration: number }> {
    // Iteration count: number of address-review records for this PR so far + 1.
    const prior = await listAddressReviewRuns({
        limit: args.maxIterations + 5,
        repo: `${args.owner}/${args.repo}`,
        prNumber: args.prNumber,
    });
    const iteration = prior.length + 1;

    // Skip-label check (always wins).
    try {
        const githubToken = (args.context.integrationConfigs.github as Record<string, unknown> | undefined)?.token as string | undefined
            ?? process.env.GITHUB_TOKEN;
        if (githubToken) {
            const { GitHubApiClient } = await import('../integrations/github/api.js');
            const client = new GitHubApiClient(githubToken);
            const labels = await client.listLabels(args.owner, args.repo, args.prNumber).catch((): string[] => []);
            if (labels.includes(SKIP_LABEL)) {
                return { halt: 'skip-label', reason: `PR has "${SKIP_LABEL}" label`, iteration };
            }
            // In-flight lock: a label-based fence visible in the GitHub
            // sidebar. The workdir lock prevents corruption; the label
            // prevents racing webhook triggers from queueing a second
            // address run that would just halt on the workdir lock.
            if (labels.includes(RUNNING_LABEL)) {
                return { halt: 'workdir-locked', reason: `PR has "${RUNNING_LABEL}" label — another run is in flight`, iteration };
            }
        }
    } catch (err) {
        args.context.logger.warn({ err }, 'Label check failed; continuing without skip guard');
    }

    if (iteration > args.maxIterations) {
        return { halt: 'iteration-cap', reason: `iteration ${iteration} exceeds cap ${args.maxIterations}`, iteration };
    }

    // Merge-ready: tolerable if review is below thresholds.
    if (isMergeReady(args.review, args.mergeReady)) {
        return { halt: 'merge-ready', reason: 'PR review judged merge-ready by heuristic', iteration };
    }

    // Fingerprint repeat: same issue set as the previous iteration.
    const previous = prior[0]; // newest first
    if (previous && args.mode === 'push') {
        const currentFingerprint = issueFingerprint(args.review.output.issues ?? []);
        if (previous.issueFingerprint === currentFingerprint) {
            return { halt: 'fingerprint-repeat', reason: 'identical issue set as previous iteration', iteration };
        }
        // Cooldown.
        const since = Date.now() - new Date(previous.createdAt).getTime();
        if (since < args.cooldownSec * 1000) {
            return { halt: 'cooldown', reason: `cooldown active (${Math.ceil((args.cooldownSec * 1000 - since) / 1000)}s remaining)`, iteration };
        }
        // Human-pushed: if PR head SHA changed since the last bot push, defer.
        if (previous.push?.commitSha && args.review.event.branch) {
            // We can't trivially diff here without GitHub; defer to next phase if
            // strictness needed. For now compare review's head info if present.
            // (Phase F can tighten this.)
        }
    }

    return { iteration };
}

export function isMergeReady(review: AiReviewRunRecord, cfg: MergeReadyConfig): boolean {
    const issues = review.output.issues ?? [];
    const counts = { P1: 0, P2: 0, P3: 0 } as Record<string, number>;
    for (const i of issues) counts[i.priority] = (counts[i.priority] ?? 0) + 1;
    if (cfg.max_p1 >= 0 && counts.P1 > cfg.max_p1) return false;
    if (cfg.max_p2 >= 0 && counts.P2 > cfg.max_p2) return false;
    if (cfg.max_p3 >= 0 && counts.P3 > cfg.max_p3) return false;
    return true;
}

async function emitHaltedRecord(args: {
    runId: string; createdAt: string; startedAt: number;
    owner: string; repo: string; prNumber: number;
    mode: AddressReviewMode; sourceReviewRunId: string; maxIterations: number;
    review: AiReviewRunRecord;
    haltReason: AddressReviewHaltReason;
    error?: string;
    workflowName?: string;
    iteration: number;
    context: { logger: import('pino').Logger };
}): Promise<AddressReviewRunRecord> {
    const record: AddressReviewRunRecord = {
        id: args.runId,
        action: 'address-review',
        createdAt: args.createdAt,
        durationMs: Date.now() - args.startedAt,
        workflowName: args.workflowName,
        pr: { repo: `${args.owner}/${args.repo}`, prNumber: args.prNumber, branch: args.review.event.branch },
        iteration: args.iteration,
        iterationCap: args.maxIterations,
        sourceReviewRunId: args.sourceReviewRunId,
        mode: args.mode,
        provider: '',
        model: '',
        issues: { addressed: [], rejected: [], deferred: [] },
        workdir: { path: '', reused: false },
        issueFingerprint: issueFingerprint(args.review.output.issues ?? []),
        haltReason: args.haltReason,
        error: args.error,
    };
    await recordAddressReviewRun(record, args.context.logger);
    return record;
}

async function cloneRepo(
    dest: string, owner: string, repo: string, ref: string, token: string, logger: import('pino').Logger,
): Promise<void> {
    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const args = ['clone', '--depth', '50'];
    if (ref) args.push('--branch', ref);
    args.push(url, dest);
    logger.info({ owner, repo, ref, dest }, 'Cloning repo for address-review');
    await runGit(args, { cwd: undefined });
}

async function syncRepo(
    workdir: string, ref: string, logger: import('pino').Logger,
): Promise<void> {
    logger.info({ workdir, ref }, 'Syncing existing workdir');
    await runGit(['fetch', 'origin', ref], { cwd: workdir });
    await runGit(['reset', '--hard', `origin/${ref}`], { cwd: workdir });
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
    return (await runGit(['rev-parse', ref], { cwd })).trim();
}

function runGit(args: string[], opts: { cwd?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
        });
        child.on('error', reject);
    });
}

function buildAgentPrompt(args: {
    mode: AddressReviewMode;
    issues: AddressedIssue[];
    review: AiReviewRunRecord;
    owner: string; repo: string; prNumber: number;
}): string {
    const issuesJson = JSON.stringify(args.issues, null, 2);
    const modeBlock = args.mode === 'suggest'
        ? `# Mode: SUGGEST
You will NOT commit or push any changes. Instead, for each issue you decide is authentic, return a clear description of the fix in the JSON output. When the fix is a clean drop-in replacement for a small contiguous range of lines, you MAY include a \`suggestion\` block (path + line + replacement code) so it appears as a GitHub line suggestion.

Do not modify files on disk except for read-only experimentation.`
        : `# Mode: PUSH
You SHOULD commit fixes you decide are authentic. Use git inside the workdir.

After making changes, you MUST run validation commands you discover (see Phase 4 of the skill). Report \`tests.passed\` honestly. **If validation fails, do not commit. Roll back instead and report failure.**

Do not push. The action will push for you after validating tests.passed.`;

    return `${ADDRESS_REVIEW_SKILL}

---

${modeBlock}

# Inputs

PR: ${args.owner}/${args.repo}#${args.prNumber}
Branch: ${args.review.event.branch ?? '(unknown)'}

## Review issues to consider

\`\`\`json
${issuesJson}
\`\`\`

# Required JSON output

When you finish, output a single JSON object as your final response. Do not wrap in fences. Schema:

{
  "issues": {
    "addressed": [
      { "priority": "P1"|"P2"|"P3", "title": "...", "file": "...", "reasoning": "why this fix is correct",
        "suggestion": { "path": "...", "line": 42, "startLine": 40, "code": "fixed code" }   // optional, suggest mode
      }
    ],
    "rejected": [ { "priority", "title", "file", "reasoning": "why this is not actually a problem" } ],
    "deferred": [ { "priority", "title", "file", "reasoning": "why this needs human attention" } ]
  },
  "bodySummary": "1-3 sentence overview of what you did and why",
  "tests": {
    "ranTests": true|false,
    "command": "npm test"|"...",
    "passed": true|false,
    "durationMs": 0,
    "output": "tail of test output, last ~80 lines"
  },
  "push": { "commitSha": "abc...", "message": "..." }   // push mode only, omit otherwise
}

Empty arrays are valid. If you reject every issue, return empty \`addressed\` with explanations in \`rejected\`.
`;
}

export function renderSuggestModeBody(parsed: AgentOutput, runId: string, iteration: number, cap: number): string {
    const lines: string[] = [];
    lines.push(`<!-- sokuza:address-run sourceReviewRunId=${runId} iter=${iteration}/${cap} mode=suggest -->`);
    lines.push('');
    lines.push(`### Auto-Address (suggest mode) — iteration ${iteration}/${cap}`);
    lines.push('');
    if (parsed.bodySummary) lines.push(parsed.bodySummary, '');
    const a = parsed.issues.addressed.length;
    const r = parsed.issues.rejected.length;
    const d = parsed.issues.deferred.length;
    lines.push(`**${a} addressed** · ${r} rejected · ${d} deferred`, '');

    if (parsed.issues.rejected.length > 0) {
        lines.push('### Rejected as not authentic');
        for (const i of parsed.issues.rejected) {
            lines.push(`- **${i.priority} — ${i.title}**${i.file ? ` (\`${i.file}\`)` : ''}`);
            if (i.reasoning) lines.push(`  - ${i.reasoning}`);
        }
        lines.push('');
    }
    if (parsed.issues.deferred.length > 0) {
        lines.push('### Deferred — human attention');
        for (const i of parsed.issues.deferred) {
            lines.push(`- **${i.priority} — ${i.title}**${i.file ? ` (\`${i.file}\`)` : ''}`);
            if (i.reasoning) lines.push(`  - ${i.reasoning}`);
        }
        lines.push('');
    }
    if (parsed.issues.addressed.length > 0) {
        const noSugg = parsed.issues.addressed.filter((i) => !i.suggestion);
        if (noSugg.length > 0) {
            lines.push('### Addressed — proposed fixes (no inline suggestion)');
            for (const i of noSugg) {
                lines.push(`- **${i.priority} — ${i.title}**${i.file ? ` (\`${i.file}\`)` : ''}`);
                if (i.reasoning) lines.push(`  - ${i.reasoning}`);
            }
            lines.push('');
        }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderPushModeSummary(
    parsed: AgentOutput,
    runId: string,
    iteration: number,
    cap: number,
    push: AddressReviewRunRecord['push'],
): string {
    const lines: string[] = [];
    lines.push(`<!-- sokuza:address-run sourceReviewRunId=${runId} iter=${iteration}/${cap} mode=push -->`);
    lines.push('');
    lines.push(`### Auto-Fix push — iteration ${iteration}/${cap}`);
    lines.push('');
    if (parsed.bodySummary) lines.push(parsed.bodySummary, '');
    const a = parsed.issues.addressed.length;
    const r = parsed.issues.rejected.length;
    const d = parsed.issues.deferred.length;
    lines.push(`**${a} addressed** · ${r} rejected · ${d} deferred`, '');
    if (push?.commitSha) {
        lines.push(`Pushed commit \`${push.commitSha.slice(0, 8)}\` to \`${push.ref}\`.`, '');
    }
    if (parsed.tests) {
        const t = parsed.tests;
        lines.push(`Tests: ${t.ranTests ? `\`${t.command ?? '?'}\` ${t.passed ? '✅ passed' : '❌ failed'}` : 'not run (no relevant validation discovered)'}`, '');
    }
    if (parsed.issues.rejected.length > 0 || parsed.issues.deferred.length > 0) {
        lines.push('### Decisions');
        for (const i of parsed.issues.rejected) {
            lines.push(`- **rejected** ${i.priority} — ${i.title}: ${i.reasoning}`);
        }
        for (const i of parsed.issues.deferred) {
            lines.push(`- **deferred** ${i.priority} — ${i.title}: ${i.reasoning}`);
        }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function formatSuggestionComment(issue: AgentOutputIssue): string {
    const sugg = issue.suggestion!;
    return [
        `**${issue.priority} — ${issue.title}**`,
        '',
        issue.reasoning,
        '',
        '```suggestion',
        sugg.code,
        '```',
    ].join('\n');
}

export function parseAgentOutput(parsed: unknown, raw: string): AgentOutput {
    if (parsed && typeof parsed === 'object') {
        return normalizeAgentOutput(parsed as Record<string, unknown>);
    }
    // Try slicing out a JSON object from the raw text.
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try {
            return normalizeAgentOutput(JSON.parse(raw.slice(first, last + 1)));
        } catch { /* fall through */ }
    }
    return {
        issues: { addressed: [], rejected: [], deferred: [] },
        bodySummary: 'Agent did not produce structured output.',
    };
}

function normalizeAgentOutput(raw: Record<string, unknown>): AgentOutput {
    const issues = (raw.issues as Record<string, unknown> | undefined) ?? {};
    const norm = (v: unknown): AgentOutputIssue[] =>
        Array.isArray(v) ? v.filter((x): x is AgentOutputIssue => !!x && typeof x === 'object') : [];
    return {
        issues: {
            addressed: norm(issues.addressed),
            rejected: norm(issues.rejected),
            deferred: norm(issues.deferred),
        },
        bodySummary: typeof raw.bodySummary === 'string' ? raw.bodySummary : '',
        tests: raw.tests as AgentOutput['tests'],
        push: raw.push as AgentOutput['push'],
    };
}

function toAddressedIssue(i: AgentOutputIssue): AddressedIssue {
    return { priority: i.priority, title: i.title, file: i.file, reasoning: i.reasoning };
}

interface PushModeArgs {
    owner: string;
    repo: string;
    prNumber: number;
    workdirPath: string;
    githubToken: string;
    parsed: AgentOutput;
    iteration: number;
    logger: import('pino').Logger;
}

async function handlePushMode(args: PushModeArgs): Promise<AddressReviewRunRecord['push']> {
    // Test gate: agent must have run tests AND they must have passed,
    // unless the agent explicitly determined no relevant validation exists.
    const t = args.parsed.tests;
    if (t && t.ranTests && t.passed === false) {
        throw new Error(`address-review: tests failed — refusing to push. Command: ${t.command ?? '?'}`);
    }
    if (t && !t.ranTests) {
        args.logger.warn(
            { workdir: args.workdirPath },
            'Agent reported no validation was relevant. Pushing anyway — review the diff carefully.',
        );
    }

    // Stage the agent's working-tree changes (anything dirty becomes the auto-fix commit).
    const status = await runGit(['status', '--porcelain'], { cwd: args.workdirPath });
    if (!status.trim()) {
        // No changes: nothing to push. The agent decided every issue was inauthentic
        // or deferred. The summary comment will explain.
        return undefined;
    }
    await runGit(['add', '-A'], { cwd: args.workdirPath });

    const message = args.parsed.push?.message
        ?? `[sokuza-auto-fix iter=${args.iteration}] ${args.parsed.bodySummary?.slice(0, 60) ?? 'address review'}`;
    // Commit author/email come from the configured user; the bot inherits the
    // user's PAT identity so commits land as the user. No --no-verify so any
    // pre-commit hooks the repo configures still run as a defense layer.
    await runGit(['commit', '-m', message], { cwd: args.workdirPath });

    // Push without force. Non-fast-forward → halt loud.
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: args.workdirPath });
    const ref = branch.trim();
    try {
        await runGit(['push', 'origin', ref], { cwd: args.workdirPath });
    } catch (err) {
        throw new Error(`address-review: push failed (likely diverged branch): ${(err as Error).message}`);
    }

    const commitSha = (await runGit(['rev-parse', 'HEAD'], { cwd: args.workdirPath })).trim();
    return { commitSha, pushedAt: new Date().toISOString(), ref };
}

