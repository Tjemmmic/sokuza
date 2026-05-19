import type { NodeDefinition, NodePort, DynamicOutputSpec } from './types.js';
import type { NodeRegistry } from './registry.js';
import { isStringTruthy } from './truthy.js';

// ─── Built-in node definitions ───────────────────────────────────────────────
//
// Each node is a thin declarative wrapper around an existing action handler
// (see src/actions and src/integrations/*/actions). The wrapping is:
//   1. Declare the user-facing form fields (config ports) and any wired data
//      ports the node exposes.
//   2. Declare the named outputs the node produces.
//   3. In execute(): assemble action params from the resolved inputs, look
//      up the action handler from the registry the engine handed in, run it,
//      and return its result as the node's output bag.
//
// Adding a new feature = appending one NodeDefinition here. The dashboard
// picks it up via /api/nodes; the runtime picks it up via the registry.

const COLOR_GITHUB = '#0d1117';
const COLOR_AI = '#a855f7';
const COLOR_FLOW = '#f59e0b';
const COLOR_NOTIFY = '#22c55e';
const COLOR_TRIGGER = '#3b82f6';
const COLOR_UTILITY = '#6b7280';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wraps an existing action handler as a node. Inputs become action params;
 * the action's full return value becomes the node's output bag (also
 * exposed as a synthetic `result` port for chained graphs).
 */
function actionNode(opts: {
    type: string;
    group: string;
    title: string;
    description: string;
    icon: string;
    color?: string;
    actionName: string;
    ports: NodePort[];
}): NodeDefinition {
    return {
        type: opts.type,
        category: 'action',
        group: opts.group,
        title: opts.title,
        description: opts.description,
        icon: opts.icon,
        color: opts.color,
        ports: opts.ports,
        execute: async (inputs, ctx) => {
            const handler = ctx.actions.get(opts.actionName);
            if (!handler) {
                throw new Error(
                    `Node "${opts.type}" depends on action "${opts.actionName}", ` +
                    `which is not registered. Check engine startup.`,
                );
            }
            // Drop undefined entries so the action sees only the keys the
            // user actually configured / wired in.
            const params: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(inputs)) {
                if (v !== undefined && v !== '') params[k] = v;
            }
            const result = await handler(params, ctx);
            return wrapResult(result);
        },
    };
}

/**
 * Builds a node's output bag from an action handler's return value: every
 * key of the returned object becomes its own port, plus a synthetic `result`
 * port carrying the whole value (see actionNode's doc comment).
 *
 * Precedence is deliberate: the synthetic `result` is written *after* the
 * spread, so if a handler ever returns its own `result` key it is shadowed
 * by the whole-object value. This is intentional and load-bearing — graph
 * chaining relies on `{{nodes.X.result}}` *always* meaning "X's full output",
 * regardless of which handler produced it. Making it conditional (keep the
 * handler's `result` when present) would make that port mean different
 * things for different nodes and silently break chained graphs. The
 * shadowed field remains reachable at `result.result`. No built-in handler
 * currently returns a `result` key; this comment exists so a future one
 * doesn't reintroduce the ambiguity by accident. Pinned by builtins.test.ts.
 *
 * Exported for unit testing only.
 */
export function wrapResult(result: unknown): Record<string, unknown> {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ...(result as Record<string, unknown>), result };
    }
    return { result };
}

// ─── Trigger nodes ───────────────────────────────────────────────────────────
//
// Triggers are virtual: the runtime synthesizes their outputs from the
// inbound event payload (see runtime.defaultTriggerOutputs). The form
// config is parsed by the engine when matching events to graphs (see
// extractTriggerFromGraph in workflow.ts).

// Trigger nodes have *dynamic* output ports — the editor and runtime both
// derive the visible port list from the node's config. We expose the
// derivation rules in the serialized definition so the dashboard can render
// the right ports without hard-coding logic. Built-in helpers below.

/** Always-present trigger outputs — useful escape hatches even when more
 *  specific event-derived ports exist. */
const TRIGGER_BASE_OUTPUTS: NodePort[] = [
    { name: 'event', label: 'Event', role: 'output', wire: true, type: 'event', helpText: 'The full canonical event object' },
    { name: 'payload', label: 'Payload', role: 'output', wire: true, type: 'json', helpText: 'event.payload — provider-specific raw payload' },
];

// Event-conditional output rules used by every github-flavored trigger.
// When the user selects, e.g. `pull_request.opened`, the trigger node
// grows `pr`/`prNumber`/`repo`/`branch`/`author` ports — the same fields
// the runtime synthesizes onto the event so wires resolve to real values.
const GITHUB_EVENT_RULES: DynamicOutputSpec = {
    kind: 'event-conditional',
    eventsConfigKey: 'events',
    rules: [
        {
            whenEvents: ['pull_request.*', 'pull_request_review.*', 'pull_request_review_comment.*'],
            ports: [
                { name: 'pr', label: 'Pull Request', role: 'output', wire: true, type: 'pr' },
                { name: 'prNumber', label: 'PR Number', role: 'output', wire: true, type: 'number' },
                { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
                { name: 'branch', label: 'Head Branch', role: 'output', wire: true, type: 'string' },
                { name: 'author', label: 'PR Author', role: 'output', wire: true, type: 'string' },
            ],
        },
        {
            whenEvents: ['pull_request_review.*'],
            ports: [
                { name: 'review', label: 'Review', role: 'output', wire: true, type: 'review' },
            ],
        },
        {
            whenEvents: ['issues.*'],
            ports: [
                { name: 'issue', label: 'Issue', role: 'output', wire: true, type: 'issue' },
                { name: 'issueNumber', label: 'Issue Number', role: 'output', wire: true, type: 'number' },
                { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
                { name: 'author', label: 'Issue Author', role: 'output', wire: true, type: 'string' },
            ],
        },
        {
            whenEvents: ['issue_comment.*'],
            ports: [
                { name: 'comment', label: 'Comment', role: 'output', wire: true, type: 'json' },
                { name: 'commentBody', label: 'Comment Body', role: 'output', wire: true, type: 'string' },
                { name: 'issueNumber', label: 'Issue/PR Number', role: 'output', wire: true, type: 'number' },
                { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
            ],
        },
        {
            whenEvents: ['push'],
            ports: [
                { name: 'branch', label: 'Branch', role: 'output', wire: true, type: 'string' },
                { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
                { name: 'commits', label: 'Commits', role: 'output', wire: true, type: 'commits' },
            ],
        },
    ],
};

const githubTrigger: NodeDefinition = {
    type: 'trigger.github',
    category: 'trigger',
    group: 'Triggers',
    title: 'GitHub Webhook',
    description: 'Listens for GitHub events delivered via webhook',
    icon: '🐙',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'events', label: 'Events', role: 'input', config: true, control: 'multiselect', required: true, helpText: 'pull_request.opened, issues.opened, review.submitted, …' },
        { name: 'repos', label: 'Repositories', role: 'input', config: true, control: 'text', helpText: 'Comma-separated org/repo names. Empty = all repos.' },
        { name: 'branches', label: 'Branches', role: 'input', config: true, control: 'text', helpText: 'Comma-separated. Empty = all branches.' },
        { name: 'authors', label: 'Authors', role: 'input', config: true, control: 'text', helpText: 'Comma-separated GitHub usernames. Empty = all.' },
        { name: 'labels', label: 'Labels (any of)', role: 'input', config: true, control: 'text' },
        ...TRIGGER_BASE_OUTPUTS,
    ],
    dynamicOutputs: [GITHUB_EVENT_RULES],
};

const githubPollTrigger: NodeDefinition = {
    type: 'trigger.github-poll',
    category: 'trigger',
    group: 'Triggers',
    title: 'GitHub (poll API)',
    description: 'Polls the GitHub REST API — useful when webhooks aren\'t available',
    icon: '🔄',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'events', label: 'Events', role: 'input', config: true, control: 'multiselect', required: true },
        { name: 'repos', label: 'Repositories', role: 'input', config: true, control: 'text' },
        ...TRIGGER_BASE_OUTPUTS,
    ],
    dynamicOutputs: [GITHUB_EVENT_RULES],
};

const ghCliTrigger: NodeDefinition = {
    type: 'trigger.gh-cli',
    category: 'trigger',
    group: 'Triggers',
    title: 'gh CLI (zero-config)',
    description: 'Uses your local gh CLI auth — no webhook setup required',
    icon: '⚡',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'events', label: 'Events', role: 'input', config: true, control: 'multiselect', required: true },
        { name: 'repos', label: 'Repositories', role: 'input', config: true, control: 'text' },
        ...TRIGGER_BASE_OUTPUTS,
    ],
    dynamicOutputs: [GITHUB_EVENT_RULES],
};

const slackTrigger: NodeDefinition = {
    type: 'trigger.slack',
    category: 'trigger',
    group: 'Triggers',
    title: 'Slack Event',
    description: 'Listens for Slack events (mentions, messages, reactions)',
    icon: '💬',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'events', label: 'Events', role: 'input', config: true, control: 'multiselect', required: true },
        { name: 'channels', label: 'Channels', role: 'input', config: true, control: 'text', helpText: 'Comma-separated channel ids/names' },
        ...TRIGGER_BASE_OUTPUTS,
        { name: 'channel', label: 'Channel', role: 'output', wire: true, type: 'string' },
        { name: 'user', label: 'User', role: 'output', wire: true, type: 'string' },
        { name: 'text', label: 'Message Text', role: 'output', wire: true, type: 'string' },
    ],
};

const webhookTrigger: NodeDefinition = {
    type: 'trigger.webhook',
    category: 'trigger',
    group: 'Triggers',
    title: 'Generic Webhook',
    description: 'Inbound HTTP webhook — payload becomes event.payload',
    icon: '📨',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'path', label: 'Path', role: 'input', config: true, control: 'text', placeholder: '/webhooks/my-hook' },
        ...TRIGGER_BASE_OUTPUTS,
    ],
};

const cronTrigger: NodeDefinition = {
    type: 'trigger.cron',
    category: 'trigger',
    group: 'Triggers',
    title: 'Schedule (cron)',
    description: 'Fires on a cron schedule',
    icon: '⏰',
    color: COLOR_TRIGGER,
    ports: [
        { name: 'schedule', label: 'Cron Expression', role: 'input', config: true, control: 'text', placeholder: '0 9 * * *', required: true },
        ...TRIGGER_BASE_OUTPUTS,
    ],
};

const manualTrigger: NodeDefinition = {
    type: 'trigger.manual',
    category: 'trigger',
    group: 'Triggers',
    title: 'Manual (run from dashboard)',
    description: 'Adds a "Run" form to the workflow. Each input becomes a typed output port you can wire directly.',
    icon: '🎮',
    color: COLOR_TRIGGER,
    ports: [
        // The `inputs` config is a structured list — the inspector renders
        // a sub-form that lets the user add named inputs with types. Each
        // input then materialises as its own typed output port (see
        // dynamicOutputs below).
        { name: 'inputs', label: 'Form Fields', role: 'input', config: true, control: 'kv', helpText: 'Define the fields that appear on the Run form. Each field becomes an output port.' },
        ...TRIGGER_BASE_OUTPUTS,
    ],
    dynamicOutputs: [
        { kind: 'per-input', inputsConfigKey: 'inputs' },
    ],
};

// ─── AI nodes ───────────────────────────────────────────────────────────────

const aiReviewNode = actionNode({
    type: 'ai.review',
    actionName: 'ai-review',
    group: 'AI',
    title: 'AI Code Review',
    description: 'Run a structured AI code review on a diff',
    icon: '🤖',
    color: COLOR_AI,
    ports: [
        { name: 'diff', label: 'Diff', role: 'input', wire: true, type: 'diff', helpText: 'Wire from a github-fetch-diff node, or paste raw diff' },
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string', placeholder: 'org/repo' },
        { name: 'prompt', label: 'System Prompt', role: 'input', config: true, control: 'textarea', defaultSource: 'ai-review-system-prompt',
          helpText: 'Leave blank to use the built-in review prompt. Click "Edit in modal" → "Load default" to start from the built-in and customise.' },
        { name: 'provider', label: 'AI Provider', role: 'input', config: true, control: 'text', placeholder: 'claude-code, anthropic, opencode…' },
        { name: 'model', label: 'Model', role: 'input', config: true, control: 'text', placeholder: 'opus, sonnet…' },
        { name: 'max_diff_chars', label: 'Max Diff Chars', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'max_tokens', label: 'Max Tokens', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'parse_repair_retries', label: 'Parse Repair Retries', role: 'input', config: true, control: 'number', type: 'number', default: 1 },
        // Outputs
        { name: 'markdown', label: 'Review Markdown', role: 'output', wire: true, type: 'string' },
        { name: 'structured', label: 'Structured Review', role: 'output', wire: true, type: 'review' },
        { name: 'summary', label: 'Summary', role: 'output', wire: true, type: 'string' },
        { name: 'issues', label: 'Issues', role: 'output', wire: true, type: 'json' },
        { name: 'mergeReady', label: 'Merge Ready?', role: 'output', wire: true, type: 'boolean' },
        { name: 'runId', label: 'Run Id', role: 'output', wire: true, type: 'string' },
    ],
});

const aiAgentNode = actionNode({
    type: 'ai.agent',
    actionName: 'ai-agent',
    group: 'AI',
    title: 'AI Agent (tool-using)',
    description: 'Run a tool-using AI agent inside a cloned repo',
    icon: '🛠️',
    color: COLOR_AI,
    ports: [
        { name: 'prompt', label: 'Prompt', role: 'input', wire: true, config: true, control: 'textarea', type: 'string', required: true },
        { name: 'workdir', label: 'Workdir', role: 'input', wire: true, type: 'string', helpText: 'From github-clone-repo' },
        { name: 'context', label: 'Extra Context', role: 'input', wire: true, config: true, control: 'textarea', type: 'string' },
        { name: 'output_format', label: 'Output Format', role: 'input', config: true, control: 'select', options: [
            { value: 'text', label: 'Text' },
            { value: 'json', label: 'JSON' },
        ], default: 'text' },
        { name: 'allowed_tools', label: 'Allowed Tools', role: 'input', config: true, control: 'text', placeholder: 'Comma-separated tool names' },
        { name: 'provider', label: 'AI Provider', role: 'input', config: true, control: 'text' },
        { name: 'model', label: 'Model', role: 'input', config: true, control: 'text' },
        { name: 'max_tokens', label: 'Max Tokens', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'output', label: 'Agent Output', role: 'output', wire: true, type: 'string' },
        { name: 'transcript', label: 'Transcript', role: 'output', wire: true, type: 'json' },
    ],
});

const addressReviewNode = actionNode({
    type: 'ai.address-review',
    actionName: 'address-review',
    group: 'AI',
    title: 'Address Review (auto-fix)',
    description: 'Consume a review and post suggestions or push fixes',
    icon: '🩹',
    color: COLOR_AI,
    ports: [
        { name: 'mode', label: 'Mode', role: 'input', config: true, control: 'select', options: [
            { value: 'suggest', label: 'Post inline suggestions (safe)' },
            { value: 'push', label: 'Commit + push fixes' },
        ], default: 'suggest' },
        { name: 'review_run_id', label: 'Review Run Id', role: 'input', wire: true, type: 'string' },
        { name: 'structured', label: 'Structured Review', role: 'input', wire: true, type: 'review' },
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'max_iterations', label: 'Max Iterations', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'cooldown_seconds', label: 'Cooldown (s)', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'provider', label: 'AI Provider', role: 'input', config: true, control: 'text' },
        { name: 'model', label: 'Model', role: 'input', config: true, control: 'text' },
        { name: 'iterationsRun', label: 'Iterations Run', role: 'output', wire: true, type: 'number' },
        { name: 'finalState', label: 'Final State', role: 'output', wire: true, type: 'string' },
    ],
});

// ─── GitHub action nodes ────────────────────────────────────────────────────

const githubFetchDiff = actionNode({
    type: 'github.fetch-diff',
    actionName: 'github-fetch-diff',
    group: 'GitHub',
    title: 'Fetch PR Diff',
    description: 'Pull a unified diff for a pull request, with smart truncation',
    icon: '📥',
    color: COLOR_GITHUB,
    ports: [
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'max_diff_chars', label: 'Max Chars', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'diff', label: 'Diff', role: 'output', wire: true, type: 'diff' },
        { name: 'truncated', label: 'Truncated?', role: 'output', wire: true, type: 'boolean' },
        { name: 'files', label: 'Files', role: 'output', wire: true, type: 'json' },
    ],
});

const githubComment = actionNode({
    type: 'github.comment',
    actionName: 'github-comment',
    group: 'GitHub',
    title: 'Post PR/Issue Comment',
    description: 'Post a comment to a pull request or issue',
    icon: '💬',
    color: COLOR_GITHUB,
    ports: [
        { name: 'body', label: 'Body', role: 'input', wire: true, config: true, control: 'code-md', type: 'string', required: true },
        { name: 'pr_number', label: 'PR/Issue Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        // Semantic alias for issue-focused workflows. _target.ts already
        // resolves params.issue_number to the same internal target as
        // params.pr_number, so authors can wire `trigger.issueNumber`
        // into a port named `issue_number` and the graph reads the same
        // way an issue triage workflow would.
        { name: 'issue_number', label: 'Issue Number (alias)', role: 'input', wire: true, type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'commentId', label: 'Comment Id', role: 'output', wire: true, type: 'string' },
        { name: 'url', label: 'Comment URL', role: 'output', wire: true, type: 'string' },
    ],
});

// Several action nodes deliberately expose an input AND an output that
// share a name (e.g. clone-repo's `repo`, wait-for-checks's `sha`,
// create-pr's `repo`/`branch`, fetch-pr's `repo`). This is a re-emit
// pattern: the output value IS the resolved input, exposed so downstream
// nodes can wire `clone.repo → fetch.repo` directly without also wiring
// back to the trigger. Same name communicates "same value".
//
// The runtime + editor both filter by role when looking up ports
// (resolveNodeInputs vs resolveOutputPorts; wireInputPorts vs
// wireOutputPorts) so the duplicate is unambiguous in code paths.
//
// Where the input and output have *different* semantics (merge-pr's
// guard SHA vs result SHA; update-pr's desired state vs actual state)
// the names diverge — see githubMergePr / githubUpdatePr above.
const githubCloneRepo = actionNode({
    type: 'github.clone-repo',
    actionName: 'github-clone-repo',
    group: 'GitHub',
    title: 'Clone Repository',
    description: 'Shallow-clone a repo (or branch) into a temp workdir',
    icon: '📁',
    color: COLOR_GITHUB,
    ports: [
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'ref', label: 'Ref / Branch', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'depth', label: 'Clone Depth', role: 'input', config: true, control: 'number', type: 'number' },
        { name: 'destDir', label: 'Destination Dir (optional)', role: 'input', config: true, control: 'text' },
        { name: 'path', label: 'Workdir Path', role: 'output', wire: true, type: 'string' },
        { name: 'sha', label: 'Cloned SHA', role: 'output', wire: true, type: 'string' },
        // Re-emit pattern (see comment above): output = the cloned repo.
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
        { name: 'branch', label: 'Branch / Ref', role: 'output', wire: true, type: 'string' },
    ],
});

const githubCreatePr = actionNode({
    type: 'github.create-pr',
    actionName: 'github-create-pr',
    group: 'GitHub',
    title: 'Create Pull Request',
    description: 'Push a branch and open a PR',
    icon: '🚀',
    color: COLOR_GITHUB,
    ports: [
        { name: 'workdir', label: 'Workdir', role: 'input', wire: true, type: 'string', required: true },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'branch', label: 'Branch', role: 'input', config: true, control: 'text' },
        { name: 'base', label: 'Base Branch', role: 'input', config: true, control: 'text', default: 'main' },
        { name: 'title', label: 'Title', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'body', label: 'Body', role: 'input', wire: true, config: true, control: 'code-md', type: 'string' },
        { name: 'commit_message', label: 'Commit Message', role: 'input', config: true, control: 'text' },
        { name: 'number', label: 'PR Number', role: 'output', wire: true, type: 'number' },
        { name: 'url', label: 'PR URL', role: 'output', wire: true, type: 'string' },
        // Re-emit construction-time fields so downstream PR-acting nodes can
        // be wired from this single source instead of also wiring back to
        // the trigger / clone-repo.
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
        { name: 'branch', label: 'Branch', role: 'output', wire: true, type: 'string' },
    ],
});

const githubCreateReview = actionNode({
    type: 'github.create-review',
    actionName: 'github-create-review',
    group: 'GitHub',
    title: 'Create PR Review',
    description: 'Post a real GitHub Review (not just a comment)',
    icon: '✅',
    color: COLOR_GITHUB,
    ports: [
        { name: 'body', label: 'Body', role: 'input', wire: true, config: true, control: 'code-md', type: 'string', required: true },
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'event', label: 'Review Event', role: 'input', config: true, control: 'select', options: [
            { value: 'COMMENT', label: 'Comment' },
            { value: 'APPROVE', label: 'Approve' },
            { value: 'REQUEST_CHANGES', label: 'Request Changes' },
        ], default: 'COMMENT' },
        { name: 'reviewId', label: 'Review Id', role: 'output', wire: true, type: 'string' },
        { name: 'url', label: 'Review URL', role: 'output', wire: true, type: 'string' },
    ],
});

const githubFetchReviews = actionNode({
    type: 'github.fetch-reviews',
    actionName: 'github-fetch-reviews',
    group: 'GitHub',
    title: 'Fetch PR Reviews',
    description: 'List existing reviews on a pull request',
    icon: '📜',
    color: COLOR_GITHUB,
    ports: [
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'reviews', label: 'Reviews', role: 'output', wire: true, type: 'json' },
    ],
});

const githubFetchPr = actionNode({
    type: 'github.fetch-pr',
    actionName: 'github-fetch-pr',
    group: 'GitHub',
    title: 'Fetch Pull Request',
    description: 'Round-trip: fetch the full PR object by number — pipe its output into Decompose Pull Request',
    icon: '📥',
    color: COLOR_GITHUB,
    ports: [
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number', required: true },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'pr', label: 'Pull Request', role: 'output', wire: true, type: 'pr' },
        { name: 'number', label: 'Number', role: 'output', wire: true, type: 'number' },
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
    ],
});

const githubFetchIssue = actionNode({
    type: 'github.fetch-issue',
    actionName: 'github-fetch-issue',
    group: 'GitHub',
    title: 'Fetch Issue',
    description: 'Round-trip: fetch the full Issue object by number — pipe into Decompose Issue',
    icon: '📥',
    color: COLOR_GITHUB,
    ports: [
        { name: 'issue_number', label: 'Issue Number', role: 'input', wire: true, config: true, control: 'number', type: 'number', required: true },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'issue', label: 'Issue', role: 'output', wire: true, type: 'issue' },
        { name: 'number', label: 'Number', role: 'output', wire: true, type: 'number' },
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
    ],
});

const githubMergePr = actionNode({
    type: 'github.merge-pr',
    actionName: 'github-merge-pr',
    group: 'GitHub',
    title: 'Merge Pull Request',
    description: 'Merge a PR via the API — supports merge / squash / rebase',
    icon: '🟣',
    color: COLOR_GITHUB,
    ports: [
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number', required: true },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'method', label: 'Merge Method', role: 'input', config: true, control: 'select', options: [
            { value: 'merge', label: 'Merge commit' },
            { value: 'squash', label: 'Squash and merge' },
            { value: 'rebase', label: 'Rebase and merge' },
        ], default: 'merge' },
        { name: 'commit_title', label: 'Commit Title (optional)', role: 'input', config: true, control: 'text' },
        { name: 'commit_message', label: 'Commit Message (optional)', role: 'input', config: true, control: 'textarea' },
        { name: 'sha', label: 'Required Head SHA (optional)', role: 'input', wire: true, config: true, control: 'text', type: 'string', helpText: 'If supplied, GitHub fails the merge if the PR HEAD has moved' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'merged', label: 'Merged?', role: 'output', wire: true, type: 'boolean' },
        // `mergeSha` (the resulting commit SHA) is intentionally distinct
        // from the input `sha` (the head SHA used as a merge guard) — the
        // two refer to different commits, so they get different port
        // names. The action handler also exposes the legacy `sha` alias
        // for older workflows that referenced {{nodes.x.sha}}.
        { name: 'mergeSha', label: 'Merge Commit SHA', role: 'output', wire: true, type: 'string' },
        { name: 'message', label: 'API Message', role: 'output', wire: true, type: 'string' },
    ],
});

const githubUpdatePr = actionNode({
    type: 'github.update-pr',
    actionName: 'github-update-pr',
    group: 'GitHub',
    title: 'Update Pull Request',
    description: 'PATCH a PR — change title/body/base, or close it via state="closed"',
    icon: '✏️',
    color: COLOR_GITHUB,
    ports: [
        { name: 'pr_number', label: 'PR Number', role: 'input', wire: true, config: true, control: 'number', type: 'number', required: true },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'title', label: 'Title (optional)', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'body', label: 'Body (optional)', role: 'input', wire: true, config: true, control: 'code-md', type: 'string' },
        { name: 'state', label: 'State', role: 'input', config: true, control: 'select', options: [
            { value: '', label: '(no change)' },
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
        ] },
        { name: 'base', label: 'Base Branch (optional)', role: 'input', config: true, control: 'text' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'url', label: 'PR URL', role: 'output', wire: true, type: 'string' },
        // `newState` (the post-update state, e.g. "closed") is distinct
        // from the input `state` (the desired state, may be "" for "no
        // change"). The action handler also exposes the legacy `state`
        // alias for backward compatibility.
        { name: 'newState', label: 'New State', role: 'output', wire: true, type: 'string' },
        { name: 'number', label: 'PR Number', role: 'output', wire: true, type: 'number' },
    ],
});

const githubWaitForChecks = actionNode({
    type: 'github.wait-for-checks',
    actionName: 'github-wait-for-checks',
    group: 'GitHub',
    title: 'Wait for CI Checks',
    description: 'Poll commit checks until done or timeout. Folds in both the Checks API and the legacy combined-status API.',
    icon: '⏳',
    color: COLOR_GITHUB,
    ports: [
        { name: 'sha', label: 'Commit SHA', role: 'input', wire: true, config: true, control: 'text', type: 'string', helpText: 'Defaults to the PR head SHA from the trigger event' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'timeout', label: 'Timeout (seconds)', role: 'input', config: true, control: 'number', type: 'number', default: 600 },
        { name: 'interval', label: 'Poll Interval (seconds)', role: 'input', config: true, control: 'number', type: 'number', default: 15 },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'success', label: 'All Passing?', role: 'output', wire: true, type: 'boolean' },
        { name: 'failedChecks', label: 'Failed Check Names', role: 'output', wire: true, type: 'json' },
        { name: 'totalChecks', label: 'Total Checks', role: 'output', wire: true, type: 'number' },
        { name: 'sha', label: 'SHA Polled', role: 'output', wire: true, type: 'string' },
        { name: 'timedOut', label: 'Timed Out?', role: 'output', wire: true, type: 'boolean' },
    ],
});

const githubAddLabel = actionNode({
    type: 'github.add-label',
    actionName: 'github-add-label',
    group: 'GitHub',
    title: 'Add Label',
    description: 'Add a label to a PR or issue',
    icon: '🏷️',
    color: COLOR_GITHUB,
    ports: [
        { name: 'label', label: 'Label(s)', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true, helpText: 'Comma-separated for multiple' },
        { name: 'pr_number', label: 'PR/Issue Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'success', label: 'Success', role: 'output', wire: true, type: 'boolean' },
        { name: 'appliedLabels', label: 'Applied Labels', role: 'output', wire: true, type: 'json' },
    ],
});

const githubRemoveLabel = actionNode({
    type: 'github.remove-label',
    actionName: 'github-remove-label',
    group: 'GitHub',
    title: 'Remove Label',
    description: 'Remove a label from a PR or issue',
    icon: '🗑️',
    color: COLOR_GITHUB,
    ports: [
        { name: 'label', label: 'Label', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'pr_number', label: 'PR/Issue Number', role: 'input', wire: true, config: true, control: 'number', type: 'number' },
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'success', label: 'Success', role: 'output', wire: true, type: 'boolean' },
        { name: 'removedLabel', label: 'Removed Label', role: 'output', wire: true, type: 'string' },
    ],
});

// ─── Git nodes (provider-agnostic) ──────────────────────────────────────────

const COLOR_GIT = '#dd4c35';

const gitCommitAndPush = actionNode({
    type: 'git.commit-and-push',
    actionName: 'git-commit-and-push',
    group: 'Git',
    title: 'Commit and Push',
    description: 'Stage, commit, and push changes in a workdir — works with GitHub, GitLab, self-hosted',
    icon: '⤴️',
    color: COLOR_GIT,
    ports: [
        { name: 'workdir', label: 'Workdir', role: 'input', wire: true, type: 'string', required: true, helpText: 'From github-clone-repo' },
        { name: 'message', label: 'Commit Message', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'branch', label: 'Branch (optional)', role: 'input', wire: true, config: true, control: 'text', type: 'string', helpText: 'Empty = use the workdir\'s current branch; named = checkout (creates if missing)' },
        { name: 'paths', label: 'Paths to Stage (optional)', role: 'input', config: true, control: 'text', helpText: 'Comma-separated. Empty = git add -A.' },
        { name: 'remote', label: 'Remote', role: 'input', config: true, control: 'text', default: 'origin' },
        { name: 'pushed', label: 'Pushed?', role: 'output', wire: true, type: 'boolean' },
        { name: 'hasChanges', label: 'Had Changes?', role: 'output', wire: true, type: 'boolean' },
        { name: 'sha', label: 'Commit SHA', role: 'output', wire: true, type: 'string' },
        { name: 'branch', label: 'Branch', role: 'output', wire: true, type: 'string' },
    ],
});

// ─── Notify nodes ───────────────────────────────────────────────────────────

const slackSend = actionNode({
    type: 'slack.send-message',
    actionName: 'slack-send-message',
    group: 'Notify',
    title: 'Send Slack Message',
    description: 'Post a message to a Slack channel',
    icon: '💬',
    color: COLOR_NOTIFY,
    ports: [
        { name: 'channel', label: 'Channel', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'text', label: 'Text', role: 'input', wire: true, config: true, control: 'textarea', type: 'string', required: true },
        { name: 'token', label: 'Slack Token (optional override)', role: 'input', config: true, control: 'text' },
        // Symmetry: slack.react expects `timestamp`. Using the same name here
        // means the obvious wire just works.
        { name: 'timestamp', label: 'Message Timestamp', role: 'output', wire: true, type: 'string' },
        { name: 'channel', label: 'Channel', role: 'output', wire: true, type: 'string' },
    ],
});

const slackReact = actionNode({
    type: 'slack.react',
    actionName: 'slack-react',
    group: 'Notify',
    title: 'Add Slack Reaction',
    description: 'Add an emoji reaction to a Slack message',
    icon: '👍',
    color: COLOR_NOTIFY,
    ports: [
        { name: 'channel', label: 'Channel', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'timestamp', label: 'Message Timestamp', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'emoji', label: 'Emoji', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true, placeholder: 'thumbsup' },
    ],
});

// ─── Utility / generic ──────────────────────────────────────────────────────

const logNode = actionNode({
    type: 'utility.log',
    actionName: 'log',
    group: 'Utility',
    title: 'Log Message',
    description: 'Write a message to the application log',
    icon: '📝',
    color: COLOR_UTILITY,
    ports: [
        { name: 'message', label: 'Message', role: 'input', wire: true, config: true, control: 'textarea', type: 'string', required: true },
        { name: 'level', label: 'Level', role: 'input', config: true, control: 'select', options: [
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warn' },
            { value: 'error', label: 'Error' },
            { value: 'debug', label: 'Debug' },
        ], default: 'info' },
    ],
});

const webhookNode = actionNode({
    type: 'utility.webhook',
    actionName: 'webhook',
    group: 'Utility',
    title: 'Outbound Webhook',
    description: 'POST data to an HTTP endpoint',
    icon: '🌐',
    color: COLOR_UTILITY,
    ports: [
        { name: 'url', label: 'URL', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true },
        { name: 'method', label: 'Method', role: 'input', config: true, control: 'select', options: [
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'PATCH', label: 'PATCH' },
            { value: 'DELETE', label: 'DELETE' },
            { value: 'GET', label: 'GET' },
        ], default: 'POST' },
        { name: 'body', label: 'Body (JSON)', role: 'input', wire: true, config: true, control: 'textarea', type: 'string' },
        { name: 'headers', label: 'Headers', role: 'input', config: true, control: 'kv' },
        { name: 'status', label: 'Status', role: 'output', wire: true, type: 'number' },
        { name: 'ok', label: 'OK?', role: 'output', wire: true, type: 'boolean' },
    ],
});

// ─── Control flow ───────────────────────────────────────────────────────────
//
// `if` evaluates a condition expression and emits either `then` or `else`
// outputs; downstream nodes wire to whichever branch they should run from.
// Skipped branches just produce empty outputs — sufficient for the 80/20
// case without requiring a separate "skipped" runtime concept.

const ifNode: NodeDefinition = {
    type: 'flow.if',
    category: 'control',
    group: 'Flow',
    title: 'If / Else',
    description: 'Branch based on a condition expression',
    icon: '🔀',
    color: COLOR_FLOW,
    ports: [
        { name: 'condition', label: 'Condition (template expression)', role: 'input', config: true, control: 'text', required: true, placeholder: '{{nodes.review.mergeReady}}' },
        { name: 'value', label: 'Pass-through Value', role: 'input', wire: true, type: 'any', helpText: 'Optional: forwarded to whichever branch fires' },
        { name: 'then', label: 'Then', role: 'output', wire: true, type: 'any' },
        { name: 'else', label: 'Else', role: 'output', wire: true, type: 'any' },
        { name: 'matched', label: 'Branch Taken', role: 'output', wire: true, type: 'string' },
    ],
    execute: async (inputs) => {
        const cond = String(inputs.condition ?? '').trim();
        const truthy = isStringTruthy(cond);
        return {
            then: truthy ? (inputs.value ?? true) : undefined,
            else: truthy ? undefined : (inputs.value ?? true),
            matched: truthy ? 'then' : 'else',
        };
    },
};

const setNode: NodeDefinition = {
    type: 'flow.set',
    category: 'control',
    group: 'Flow',
    title: 'Set Variable',
    description: 'Define a named value other nodes can read via {{nodes.<id>.value}}',
    icon: '🏷️',
    color: COLOR_FLOW,
    ports: [
        { name: 'input', label: 'Value', role: 'input', wire: true, config: true, control: 'textarea', type: 'any', required: true },
        { name: 'value', label: 'Value', role: 'output', wire: true, type: 'any' },
    ],
    execute: async (inputs) => ({ value: inputs.input }),
};

const filterListNode: NodeDefinition = {
    type: 'flow.filter-list',
    category: 'control',
    group: 'Flow',
    title: 'Filter List',
    description: 'Filter a JSON array by a per-item field test (equals / not-equals / truthy / exists)',
    icon: '⚗️',
    color: COLOR_FLOW,
    ports: [
        { name: 'list', label: 'List', role: 'input', wire: true, type: 'json', required: true, helpText: 'Wire any json array (e.g. labels, files, issues)' },
        { name: 'path', label: 'Field Path', role: 'input', wire: true, config: true, control: 'text', type: 'string', helpText: 'Dot-path inside each item (e.g. priority, user.login). Empty = compare the item itself.' },
        { name: 'mode', label: 'Test', role: 'input', config: true, control: 'select', options: [
            { value: 'equals', label: 'equals value' },
            { value: 'not-equals', label: 'not equals value' },
            { value: 'truthy', label: 'is truthy (no value needed)' },
            { value: 'exists', label: 'exists / defined (no value needed)' },
            { value: 'contains', label: 'string contains value' },
        ], default: 'equals' },
        { name: 'value', label: 'Value', role: 'input', wire: true, config: true, control: 'text', type: 'string', helpText: 'Compared as string (auto-coerces numbers/booleans). Ignored for truthy/exists.' },
        { name: 'filtered', label: 'Filtered List', role: 'output', wire: true, type: 'json' },
        { name: 'count', label: 'Count', role: 'output', wire: true, type: 'number' },
        { name: 'first', label: 'First Match', role: 'output', wire: true, type: 'any' },
    ],
    execute: async (inputs) => {
        const list = Array.isArray(inputs.list) ? inputs.list : [];
        const mode = (inputs.mode as string) ?? 'equals';
        const path = typeof inputs.path === 'string' ? inputs.path : '';
        const value = inputs.value;
        const valueStr = value === undefined || value === null ? '' : String(value);

        // Validate mode once outside the loop — a typo in hand-authored
        // YAML (e.g. mode: "eqauls") used to silently filter every item
        // out, leaving downstream nodes with count: 0 and no signal that
        // the config was wrong. Throwing surfaces the typo at the first
        // execution.
        if (!FILTER_LIST_MODES.has(mode)) {
            throw new Error(
                `flow.filter-list: unknown mode "${mode}". Valid modes: ${[...FILTER_LIST_MODES].join(', ')}.`,
            );
        }
        const filtered = list.filter((item) => {
            const target = pluckPath(item, path);
            const targetStr = target === undefined || target === null ? '' : String(target);
            switch (mode) {
                case 'truthy': return Boolean(target);
                case 'exists': return target !== undefined && target !== null;
                case 'equals': return targetStr === valueStr;
                case 'not-equals': return targetStr !== valueStr;
                case 'contains': return targetStr.includes(valueStr);
                default: return false; // unreachable — guarded above
            }
        });
        return { filtered, count: filtered.length, first: filtered[0] };
    },
};

const FILTER_LIST_MODES = new Set(['truthy', 'exists', 'equals', 'not-equals', 'contains']);

const mergeNode: NodeDefinition = {
    type: 'flow.merge',
    category: 'control',
    group: 'Flow',
    title: 'Merge Branches',
    description: 'Wait for multiple inputs and pass through the first defined value',
    icon: '🔗',
    color: COLOR_FLOW,
    ports: [
        { name: 'a', label: 'Input A', role: 'input', wire: true, type: 'any' },
        { name: 'b', label: 'Input B', role: 'input', wire: true, type: 'any' },
        { name: 'c', label: 'Input C', role: 'input', wire: true, type: 'any' },
        { name: 'value', label: 'Merged Value', role: 'output', wire: true, type: 'any' },
    ],
    execute: async (inputs) => {
        const v = inputs.a !== undefined ? inputs.a
              : inputs.b !== undefined ? inputs.b
              : inputs.c;
        return { value: v };
    },
};

// ─── Data nodes ─────────────────────────────────────────────────────────────
//
// Closed structural types (pr, issue, review, commits, event, json) carry
// a lot of useful sub-fields, but no action node accepts them as input —
// the actions all want flat scalars (pr_number, repo, branch, …). The
// nodes below bridge that gap: each takes a structured value and emits
// the named scalars downstream nodes need.
//
// Shape of payload.pull_request and payload.issue mirrors the GitHub
// webhook schema, which is what the runtime synthesizes the `pr`/`issue`
// trigger outputs from (see runtime.defaultTriggerOutputs).

const COLOR_DATA = '#06b6d4';

/** Walk a dot-path through nested objects / arrays. Empty path returns the
 *  source unchanged. Numeric segments index arrays. */
function pluckPath(source: unknown, path: string): unknown {
    if (path === '' || path === undefined || path === null) return source;
    const parts = String(path).split('.').filter((p) => p.length > 0);
    let cur: unknown = source;
    for (const part of parts) {
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur)) {
            const idx = Number(part);
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
        } else if (typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }
    return cur;
}

function asString(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

const jsonPluckNode: NodeDefinition = {
    type: 'data.json-pluck',
    category: 'action',
    group: 'Data',
    title: 'JSON Pluck',
    description: 'Read a value out of any object or JSON via dot-path (e.g. head.ref, items.0.name)',
    icon: '🔍',
    color: COLOR_DATA,
    ports: [
        { name: 'from', label: 'From', role: 'input', wire: true, type: 'any', required: true, helpText: 'Wire any object, payload, or JSON output' },
        { name: 'path', label: 'Path', role: 'input', wire: true, config: true, control: 'text', type: 'string', required: true, placeholder: 'pull_request.head.ref' },
        { name: 'value', label: 'Value', role: 'output', wire: true, type: 'any' },
        { name: 'valueText', label: 'Value (as text)', role: 'output', wire: true, type: 'string' },
        { name: 'exists', label: 'Exists?', role: 'output', wire: true, type: 'boolean' },
    ],
    execute: async (inputs) => {
        const from = inputs.from;
        const path = typeof inputs.path === 'string' ? inputs.path : '';
        const value = pluckPath(from, path);
        return {
            value,
            valueText: asString(value),
            exists: value !== undefined && value !== null,
        };
    },
};

/** Coerce GitHub label objects (or strings) into a plain `["bug", …]` list. */
function normalizeLabels(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
            out.push((item as { name: string }).name);
        }
    }
    return out;
}

/** Extract `owner/repo` from a GitHub-style html_url. Matches on the
 *  path shape `/<owner>/<repo>/(pull|issues)/<n>` rather than the host
 *  so GitHub Enterprise installs (arbitrary domains like
 *  github.mycorp.com, code.example.org, git.acme.io) round-trip
 *  identically. Returns '' for unrecognised shapes — callers treat
 *  empty as "couldn't resolve" and fall back to other sources. */
function deriveRepoFromUrl(url: string): string {
    const m = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\//);
    return m ? m[1] : '';
}

/** "host/owner/repo/pull/123" or {full_name:"owner/repo"} → "owner/repo".
 *  base.repo.full_name is the primary path; the URL fallback handles
 *  odd responses where the nested object is missing. */
function deriveRepoFromPr(pr: Record<string, unknown>): string {
    const base = pr.base as Record<string, unknown> | undefined;
    const baseRepo = base?.repo as Record<string, unknown> | undefined;
    if (typeof baseRepo?.full_name === 'string') return baseRepo.full_name;
    return deriveRepoFromUrl(typeof pr.html_url === 'string' ? pr.html_url : '');
}

const prFieldsNode: NodeDefinition = {
    type: 'data.pr-fields',
    category: 'action',
    group: 'Data',
    title: 'Decompose Pull Request',
    description: 'Split a PR object into its scalar fields so action nodes can wire to them',
    icon: '🧩',
    color: COLOR_DATA,
    ports: [
        { name: 'pr', label: 'Pull Request', role: 'input', wire: true, type: 'pr', required: true },
        { name: 'number', label: 'Number', role: 'output', wire: true, type: 'number' },
        // `repo` is the base (target) repo. For fork PRs the head lives
        // elsewhere — see `headRepo` below.
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
        { name: 'headRepo', label: 'Head Repository', role: 'output', wire: true, type: 'string', helpText: 'Same as repo for in-repo PRs; the fork "owner/name" for fork PRs. Empty when the fork has been deleted.' },
        { name: 'isCrossRepo', label: 'Cross-Repo / Fork PR?', role: 'output', wire: true, type: 'boolean' },
        { name: 'headRepoDeleted', label: 'Head Repo Deleted?', role: 'output', wire: true, type: 'boolean', helpText: 'True when the head fork has been removed — clone/checkout from headRepo will fail.' },
        { name: 'branch', label: 'Head Branch', role: 'output', wire: true, type: 'string' },
        // `headFullRef` is the GitHub-canonical "owner:branch" form needed
        // for create-pr from a fork; identical to branch for in-repo PRs.
        { name: 'headFullRef', label: 'Head Ref (owner:branch)', role: 'output', wire: true, type: 'string' },
        { name: 'baseBranch', label: 'Base Branch', role: 'output', wire: true, type: 'string' },
        { name: 'headSha', label: 'Head SHA', role: 'output', wire: true, type: 'string' },
        { name: 'baseSha', label: 'Base SHA', role: 'output', wire: true, type: 'string' },
        { name: 'author', label: 'Author', role: 'output', wire: true, type: 'string' },
        { name: 'title', label: 'Title', role: 'output', wire: true, type: 'string' },
        { name: 'body', label: 'Body', role: 'output', wire: true, type: 'string' },
        { name: 'state', label: 'State', role: 'output', wire: true, type: 'string' },
        { name: 'draft', label: 'Draft?', role: 'output', wire: true, type: 'boolean' },
        { name: 'url', label: 'URL', role: 'output', wire: true, type: 'string' },
        { name: 'labels', label: 'Labels', role: 'output', wire: true, type: 'json' },
    ],
    execute: async (inputs) => {
        const pr = (inputs.pr ?? {}) as Record<string, unknown>;
        const head = (pr.head as Record<string, unknown>) ?? {};
        const base = (pr.base as Record<string, unknown>) ?? {};
        const user = (pr.user as Record<string, unknown>) ?? {};
        const baseRepo = deriveRepoFromPr(pr);
        // GitHub returns head.repo === null when the fork has been deleted.
        // Detect that explicitly so we can distinguish "in-repo PR" (head ===
        // base) from "deleted-fork PR" (head was different but is now gone).
        const headRepoRaw = head.repo as Record<string, unknown> | null | undefined;
        const headRepoDeleted = headRepoRaw === null;
        const headRepoFromPayload = typeof headRepoRaw === 'object' && headRepoRaw !== null && typeof headRepoRaw.full_name === 'string'
            ? headRepoRaw.full_name
            : '';
        // For in-repo PRs head.repo.full_name === base.repo.full_name; users
        // wiring downstream clone-repo expect a non-empty headRepo, so for
        // deleted forks we expose the empty string (NOT a fallback to base —
        // that would silently misclassify the PR as same-repo).
        const headRepo = headRepoFromPayload;
        const branch = typeof head.ref === 'string' ? head.ref : '';
        // isCrossRepo is true whenever the head was different from base —
        // including the deleted-fork case, since downstream nodes need to
        // know the PR isn't safe to clone from the local repo.
        const isCrossRepo = headRepoDeleted || (headRepo !== '' && baseRepo !== '' && headRepo !== baseRepo);
        // headFullRef ("owner:branch") is only meaningful when we know the
        // owner — falls back to bare branch otherwise.
        const headOwner = headRepo.includes('/') ? headRepo.split('/')[0] : '';
        const headFullRef = isCrossRepo && branch && headOwner ? `${headOwner}:${branch}` : branch;
        return {
            number: typeof pr.number === 'number' ? pr.number : undefined,
            repo: baseRepo,
            headRepo,
            isCrossRepo,
            headRepoDeleted,
            branch,
            headFullRef,
            baseBranch: typeof base.ref === 'string' ? base.ref : '',
            headSha: typeof head.sha === 'string' ? head.sha : '',
            baseSha: typeof base.sha === 'string' ? base.sha : '',
            author: typeof user.login === 'string' ? user.login : '',
            title: typeof pr.title === 'string' ? pr.title : '',
            body: typeof pr.body === 'string' ? pr.body : '',
            state: typeof pr.state === 'string' ? pr.state : '',
            draft: pr.draft === true,
            url: typeof pr.html_url === 'string' ? pr.html_url : '',
            labels: normalizeLabels(pr.labels),
        };
    },
};

const issueFieldsNode: NodeDefinition = {
    type: 'data.issue-fields',
    category: 'action',
    group: 'Data',
    title: 'Decompose Issue',
    description: 'Split an Issue object into its scalar fields',
    icon: '🧩',
    color: COLOR_DATA,
    ports: [
        { name: 'issue', label: 'Issue', role: 'input', wire: true, type: 'issue', required: true },
        { name: 'number', label: 'Number', role: 'output', wire: true, type: 'number' },
        { name: 'repo', label: 'Repository', role: 'output', wire: true, type: 'string' },
        { name: 'author', label: 'Author', role: 'output', wire: true, type: 'string' },
        { name: 'title', label: 'Title', role: 'output', wire: true, type: 'string' },
        { name: 'body', label: 'Body', role: 'output', wire: true, type: 'string' },
        { name: 'state', label: 'State', role: 'output', wire: true, type: 'string' },
        { name: 'url', label: 'URL', role: 'output', wire: true, type: 'string' },
        { name: 'labels', label: 'Labels', role: 'output', wire: true, type: 'json' },
    ],
    execute: async (inputs) => {
        const issue = (inputs.issue ?? {}) as Record<string, unknown>;
        const user = (issue.user as Record<string, unknown>) ?? {};
        const url = typeof issue.html_url === 'string' ? issue.html_url : '';
        return {
            number: typeof issue.number === 'number' ? issue.number : undefined,
            repo: deriveRepoFromUrl(url),
            author: typeof user.login === 'string' ? user.login : '',
            title: typeof issue.title === 'string' ? issue.title : '',
            body: typeof issue.body === 'string' ? issue.body : '',
            state: typeof issue.state === 'string' ? issue.state : '',
            url,
            labels: normalizeLabels(issue.labels),
        };
    },
};

const reviewFieldsNode: NodeDefinition = {
    type: 'data.review-fields',
    category: 'action',
    group: 'Data',
    title: 'Decompose Structured Review',
    description: 'Read summary, issue list, and counts out of an AI Code Review result',
    icon: '🧩',
    color: COLOR_DATA,
    ports: [
        { name: 'review', label: 'Structured Review', role: 'input', wire: true, type: 'review', required: true },
        { name: 'summary', label: 'Summary', role: 'output', wire: true, type: 'string' },
        { name: 'issues', label: 'Issues', role: 'output', wire: true, type: 'json' },
        { name: 'mergeReady', label: 'Merge Ready?', role: 'output', wire: true, type: 'boolean' },
        { name: 'blockingCount', label: 'Blocking Count', role: 'output', wire: true, type: 'number' },
        { name: 'nonBlockingCount', label: 'Non-Blocking Count', role: 'output', wire: true, type: 'number' },
        { name: 'totalCount', label: 'Total Issues', role: 'output', wire: true, type: 'number' },
    ],
    execute: async (inputs) => {
        const r = (inputs.review ?? {}) as Record<string, unknown>;
        const issues = Array.isArray(r.issues) ? r.issues : [];
        const blocking = issues.filter((i) => {
            if (!i || typeof i !== 'object') return false;
            const p = (i as { priority?: unknown }).priority;
            // P0/P1 are typically blocking; everything else isn't.
            return p === 'P0' || p === 'P1';
        });
        return {
            summary: typeof r.summary === 'string' ? r.summary : '',
            issues,
            mergeReady: r.mergeReady === true,
            blockingCount: blocking.length,
            nonBlockingCount: issues.length - blocking.length,
            totalCount: issues.length,
        };
    },
};

const commitsFieldsNode: NodeDefinition = {
    type: 'data.commits-fields',
    category: 'action',
    group: 'Data',
    title: 'Decompose Commits',
    description: 'Read latest SHA, count, and message list out of a push event\'s commits',
    icon: '🧩',
    color: COLOR_DATA,
    ports: [
        { name: 'commits', label: 'Commits', role: 'input', wire: true, type: 'commits', required: true },
        { name: 'count', label: 'Count', role: 'output', wire: true, type: 'number' },
        { name: 'latestSha', label: 'Latest SHA', role: 'output', wire: true, type: 'string' },
        { name: 'latestMessage', label: 'Latest Message', role: 'output', wire: true, type: 'string' },
        { name: 'latestAuthor', label: 'Latest Author', role: 'output', wire: true, type: 'string' },
        { name: 'messages', label: 'All Messages', role: 'output', wire: true, type: 'json' },
        { name: 'shas', label: 'All SHAs', role: 'output', wire: true, type: 'json' },
    ],
    execute: async (inputs) => {
        const list = Array.isArray(inputs.commits) ? inputs.commits as Array<Record<string, unknown>> : [];
        const latest = list.length > 0 ? list[list.length - 1] : undefined;
        const author = latest?.author as Record<string, unknown> | undefined;
        return {
            count: list.length,
            latestSha: typeof latest?.id === 'string'
                ? latest.id
                : (typeof latest?.sha === 'string' ? latest.sha : ''),
            latestMessage: typeof latest?.message === 'string' ? latest.message : '',
            latestAuthor: typeof author?.username === 'string'
                ? author.username
                : (typeof author?.name === 'string' ? author.name : ''),
            messages: list.map((c) => (typeof c.message === 'string' ? c.message : '')),
            shas: list.map((c) => (typeof c.id === 'string' ? c.id : (typeof c.sha === 'string' ? c.sha : ''))),
        };
    },
};

const eventFieldsNode: NodeDefinition = {
    type: 'data.event-fields',
    category: 'action',
    group: 'Data',
    title: 'Decompose Event',
    description: 'Split the canonical event envelope into source/eventName/payload/metadata',
    icon: '🧩',
    color: COLOR_DATA,
    ports: [
        { name: 'event', label: 'Event', role: 'input', wire: true, type: 'event', required: true },
        { name: 'source', label: 'Source', role: 'output', wire: true, type: 'string' },
        { name: 'eventName', label: 'Event Name', role: 'output', wire: true, type: 'string' },
        { name: 'timestamp', label: 'Timestamp', role: 'output', wire: true, type: 'string' },
        { name: 'payload', label: 'Payload', role: 'output', wire: true, type: 'json' },
        { name: 'metadata', label: 'Metadata', role: 'output', wire: true, type: 'json' },
    ],
    execute: async (inputs) => {
        const e = (inputs.event ?? {}) as Record<string, unknown>;
        return {
            source: typeof e.source === 'string' ? e.source : '',
            eventName: typeof e.event === 'string' ? e.event : '',
            timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
            payload: e.payload ?? {},
            metadata: e.metadata ?? {},
        };
    },
};

const templateNode: NodeDefinition = {
    type: 'data.template',
    category: 'action',
    group: 'Data',
    title: 'Format String',
    description: 'Compose a string with {{nodes.x.y}} placeholders — interpolation happens at runtime',
    icon: '✏️',
    color: COLOR_DATA,
    ports: [
        // The template body is interpolated by the engine before reaching
        // execute(), so we can just hand the result through. Showing this
        // as its own node makes the composition visible on the canvas
        // instead of hiding inside another node's body field.
        { name: 'template', label: 'Template', role: 'input', wire: true, config: true, control: 'textarea', type: 'string', required: true, placeholder: 'PR #{{nodes.fields.number}} by {{nodes.fields.author}}' },
        { name: 'text', label: 'Text', role: 'output', wire: true, type: 'string' },
    ],
    execute: async (inputs) => ({ text: typeof inputs.template === 'string' ? inputs.template : asString(inputs.template) }),
};

// ─── Registration entrypoint ────────────────────────────────────────────────

const ALL_BUILTINS: NodeDefinition[] = [
    // Triggers
    githubTrigger, githubPollTrigger, ghCliTrigger,
    slackTrigger, webhookTrigger, cronTrigger, manualTrigger,
    // AI
    aiReviewNode, aiAgentNode, addressReviewNode,
    // GitHub
    githubFetchDiff, githubComment, githubCloneRepo, githubCreatePr,
    githubCreateReview, githubFetchReviews, githubAddLabel, githubRemoveLabel,
    githubFetchPr, githubFetchIssue, githubMergePr, githubUpdatePr, githubWaitForChecks,
    // Git (provider-agnostic)
    gitCommitAndPush,
    // Notify
    slackSend, slackReact,
    // Utility
    logNode, webhookNode,
    // Flow
    ifNode, setNode, mergeNode, filterListNode,
    // Data
    jsonPluckNode,
    prFieldsNode, issueFieldsNode, reviewFieldsNode, commitsFieldsNode, eventFieldsNode,
    templateNode,
];

export function registerBuiltinNodes(registry: NodeRegistry): void {
    for (const def of ALL_BUILTINS) {
        if (!registry.has(def.type)) registry.register(def);
    }
}

export function builtinNodes(): NodeDefinition[] {
    return [...ALL_BUILTINS];
}
