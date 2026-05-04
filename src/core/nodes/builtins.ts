import type { NodeDefinition, NodePort, DynamicOutputSpec } from './types.js';
import type { NodeRegistry } from './registry.js';

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

function wrapResult(result: unknown): Record<string, unknown> {
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
        { name: 'prompt', label: 'System Prompt (optional override)', role: 'input', config: true, control: 'textarea' },
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
        { name: 'repo', label: 'Repository', role: 'input', wire: true, config: true, control: 'text', type: 'string' },
        { name: 'token', label: 'GitHub Token (optional override)', role: 'input', config: true, control: 'text' },
        { name: 'commentId', label: 'Comment Id', role: 'output', wire: true, type: 'string' },
        { name: 'url', label: 'Comment URL', role: 'output', wire: true, type: 'string' },
    ],
});

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
        // Re-emit so downstream nodes don't have to re-wire from the trigger.
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
        { name: 'message', label: 'Message', role: 'input', wire: true, config: true, control: 'textarea', required: true },
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
        const truthy = cond !== '' && cond !== 'false' && cond !== '0' && cond !== 'undefined' && cond !== 'null';
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
        { name: 'input', label: 'Value', role: 'input', wire: true, config: true, control: 'textarea', required: true },
        { name: 'value', label: 'Value', role: 'output', wire: true, type: 'any' },
    ],
    execute: async (inputs) => ({ value: inputs.input }),
};

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
    // Notify
    slackSend, slackReact,
    // Utility
    logNode, webhookNode,
    // Flow
    ifNode, setNode, mergeNode,
];

export function registerBuiltinNodes(registry: NodeRegistry): void {
    for (const def of ALL_BUILTINS) {
        if (!registry.has(def.type)) registry.register(def);
    }
}

export function builtinNodes(): NodeDefinition[] {
    return [...ALL_BUILTINS];
}
