// ─── Sokuza Dashboard v3 ────────────────────────────────────────────────────
// Comprehensive management UI — structured editors, live events + history, stats

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ─── State ──────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let workflows = [];
let templates = [];
let integrations = {};
let availableActions = [];
let events = [];
let eventStats = {};
let eventSource = null;
let dashRefreshTimer = null;
let deck = [];
let libraryTemplates = [];
let librarySearchQuery = '';
let libraryActiveCategory = 'all';

// graph-editor.js needs to flip the library badge when a user saves a
// workflow that was staged from a library card. Expose a small helper on
// window so the editor can update the deck without reaching into app.js
// internals.
window.notifyLibraryItemInstalled = async function (itemId) {
    if (!itemId) return;
    if (!deck.includes(itemId)) {
        deck.push(itemId);
        try { await api.post('/api/deck/add', { id: itemId }); }
        catch { /* deck endpoint optional */ }
    }
};

// ─── Event Catalog (source → events with friendly names) ───────────────────
const eventCatalog = {
    github: [
        { value: 'pull_request.opened', label: 'Pull Request Opened', desc: 'A new pull request is created' },
        { value: 'pull_request.closed', label: 'Pull Request Closed / Merged', desc: 'A pull request is closed or merged' },
        { value: 'pull_request.synchronize', label: 'Pull Request Updated', desc: 'New commits pushed to a pull request' },
        { value: 'pull_request.review_requested', label: 'Review Requested', desc: 'A review is requested on a pull request' },
        { value: 'pull_request_review.submitted', label: 'Review Submitted', desc: 'A pull request review is submitted' },
        { value: 'issues.opened', label: 'Issue Opened', desc: 'A new issue is created' },
        { value: 'issues.closed', label: 'Issue Closed', desc: 'An issue is closed' },
        { value: 'issues.labeled', label: 'Issue Labeled', desc: 'A label is added to an issue' },
        { value: 'issues.assigned', label: 'Issue Assigned', desc: 'An issue is assigned to someone' },
        { value: 'issue_comment.created', label: 'Comment Created', desc: 'A new comment on an issue or pull request' },
        { value: 'push', label: 'Push', desc: 'Commits are pushed to a branch' },
    ],
    'github-poll': [
        { value: 'pull_request.opened', label: 'Pull Request Opened', desc: 'Detected via polling' },
        { value: 'pull_request.closed', label: 'Pull Request Closed', desc: 'Detected via polling' },
        { value: 'pull_request.synchronize', label: 'Pull Request Updated', desc: 'Detected via polling' },
        { value: 'push', label: 'Push', desc: 'Detected via polling' },
        { value: 'issues.opened', label: 'Issue Opened', desc: 'Detected via polling' },
        { value: 'issues.closed', label: 'Issue Closed', desc: 'Detected via polling' },
        { value: 'issue_comment.created', label: 'Comment Created', desc: 'Detected via polling' },
    ],
    'gh-cli': [
        { value: 'pull_request.opened', label: 'Pull Request Opened', desc: 'Detected via gh CLI polling' },
        { value: 'pull_request.closed', label: 'Pull Request Closed', desc: 'Detected via gh CLI polling' },
        { value: 'pull_request.synchronize', label: 'Pull Request Updated', desc: 'Detected via gh CLI polling' },
        { value: 'pull_request_review.submitted', label: 'Review Submitted', desc: 'Detected via gh CLI polling' },
        { value: 'issue_comment.created', label: 'Comment Created', desc: 'Detected via gh CLI polling' },
    ],
    slack: [
        { value: 'message', label: 'Message Received', desc: 'A message is posted in a channel' },
        { value: 'app_mention', label: 'App Mentioned', desc: 'Your app is @mentioned' },
        { value: 'reaction_added', label: 'Reaction Added', desc: 'An emoji reaction is added to a message' },
        { value: 'reaction_removed', label: 'Reaction Removed', desc: 'An emoji reaction is removed' },
        { value: 'channel_created', label: 'Channel Created', desc: 'A new channel is created' },
        { value: 'member_joined_channel', label: 'Member Joined Channel', desc: 'Someone joins a channel' },
        { value: 'slash_command', label: 'Slash Command', desc: 'A slash command is invoked' },
    ],
    cron: [
        { value: 'every-1m', label: 'Every Minute', desc: 'Fires once per minute' },
        { value: 'every-5m', label: 'Every 5 Minutes', desc: 'Fires every 5 minutes' },
        { value: 'every-15m', label: 'Every 15 Minutes', desc: 'Fires every 15 minutes' },
        { value: 'every-30m', label: 'Every 30 Minutes', desc: 'Fires every 30 minutes' },
        { value: 'hourly', label: 'Hourly', desc: 'Fires once per hour' },
        { value: 'daily', label: 'Daily', desc: 'Fires once per day' },
    ],
    webhook: [
        { value: 'incoming', label: 'Incoming Webhook', desc: 'Any webhook payload received' },
    ],
    manual: [
        { value: 'manual', label: 'Manual Trigger', desc: 'Triggered manually from the dashboard' },
    ],
};

// Build reverse lookup: event value → friendly label
const eventLabelMap = {};
for (const [source, events] of Object.entries(eventCatalog)) {
    for (const evt of events) {
        if (!eventLabelMap[evt.value]) eventLabelMap[evt.value] = evt.label;
    }
}

// ─── Action Param Reference ─────────────────────────────────────────────────
const actionDocs = {
    'log': {
        desc: 'Log a message with event context',
        params: [
            { name: 'message', type: 'string', desc: 'Message to log (supports {{template}} expressions)', required: true },
            { name: 'level', type: 'string', desc: 'Log level: info, warn, error, debug', default: 'info' },
        ]
    },
    'webhook': {
        desc: 'POST a JSON payload to an external URL',
        params: [
            { name: 'url', type: 'string', desc: 'Target URL to send the request to', required: true },
            { name: 'method', type: 'string', desc: 'HTTP method', default: 'POST' },
            { name: 'body', type: 'object', desc: 'Custom body (default: event payload)' },
            { name: 'headers', type: 'object', desc: 'Additional HTTP headers' },
        ]
    },
    'ai-review': {
        desc: 'Send a code diff to Claude for AI review',
        params: [
            { name: 'prompt', type: 'string', desc: 'Review instructions for the AI' },
            { name: 'model', type: 'string', desc: 'Claude model to use', default: 'sonnet' },
            { name: 'provider', type: 'string', desc: '"api" (Anthropic SDK) or "claude-code" (CLI)', default: 'auto' },
            { name: 'system_prompt', type: 'string', desc: 'Override the system prompt' },
            { name: 'max_diff_chars', type: 'number', desc: 'Max diff size before truncation', default: '100000' },
            { name: 'api_key', type: 'string', desc: 'Anthropic API key (API provider only)' },
        ]
    },
    'ai-agent': {
        desc: 'Run Claude Code CLI with tool access inside a repo',
        params: [
            { name: 'workdir', type: 'string', desc: 'Working directory (usually from github-clone-repo)', required: true },
            { name: 'prompt', type: 'string', desc: 'What to ask Claude to do', required: true },
            { name: 'model', type: 'string', desc: 'Claude model', default: 'sonnet' },
            { name: 'allowed_tools', type: 'array', desc: 'CLI tools to allow', default: 'Read, Grep, Glob, LS' },
            { name: 'max_turns', type: 'number', desc: 'Max conversation turns', default: '10' },
            { name: 'output_format', type: 'string', desc: '"text" or "json"', default: 'text' },
        ]
    },
    'github-fetch-diff': {
        desc: 'Fetch the PR diff from GitHub',
        params: [
            { name: '(none)', type: '', desc: 'Uses event context automatically — no params needed' },
        ]
    },
    'github-comment': {
        desc: 'Post a comment on the PR/issue',
        params: [
            { name: 'body', type: 'string', desc: 'Comment body (Markdown, supports {{template}} expressions)', required: true },
        ]
    },
    'github-clone-repo': {
        desc: 'Clone the repository to a temp directory',
        params: [
            { name: '(none)', type: '', desc: 'Uses event context — returns { path } for use in later steps' },
        ]
    },
    'github-create-pr': {
        desc: 'Create a pull request from changes made in a cloned repo',
        params: [
            { name: 'workdir', type: 'string', desc: 'Cloned repo path (from github-clone-repo)', required: true },
            { name: 'title', type: 'string', desc: 'PR title', required: true },
            { name: 'body', type: 'string', desc: 'PR description (Markdown)' },
        ]
    },
    'slack-send-message': {
        desc: 'Send a message to a Slack channel',
        params: [
            { name: 'channel', type: 'string', desc: 'Slack channel (e.g. #code-reviews)', required: true },
            { name: 'text', type: 'string', desc: 'Message text (supports {{template}} expressions)', required: true },
        ]
    },
    'slack-react': {
        desc: 'Add a reaction emoji to a Slack message',
        params: [
            { name: 'emoji', type: 'string', desc: 'Emoji name (without colons)', required: true },
        ]
    },
};

// ─── Library Catalog ────────────────────────────────────────────────────────
const libraryCategories = [
    { key: 'all', label: 'All', icon: '📋' },
    { key: 'code-quality', label: 'Code Quality', icon: '🔍' },
    { key: 'issue-management', label: 'Issue Management', icon: '🐛' },
    { key: 'docs-release', label: 'Docs & Release', icon: '📝' },
    { key: 'notifications', label: 'Notifications', icon: '🔔' },
    { key: 'security', label: 'Security', icon: '🔒' },
    { key: 'diagnostics', label: 'Diagnostics', icon: '🩺' },
    { key: 'research', label: 'Research & Experimentation', icon: '🧪' },
    { key: 'productivity', label: 'Productivity', icon: '⚡' },
    { key: 'custom', label: 'Custom', icon: '🛠️' },
];

// Expose libraryItems so graph-editor.js can map template names to the
// human-readable card titles when rendering recipes. Without this the
// recipe picker shows prettified filenames ("Auto Label Pr") instead of
// the curated display names ("Auto-Label PRs").
const libraryItems = window.libraryItems = [
    // ── Code Quality ──
    { id: 'ai-pr-review', name: 'AI PR Review', description: 'Claude reviews every PR for bugs, security issues, and code quality — posts a detailed comment with approve/reject decision.', category: 'code-quality', icon: '🔍', tags: ['ai', 'review', 'pr', 'automated'], template: 'ai-pr-review', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['pull_request.opened'] } },
    { id: 'review-on-update', name: 'Review on Update', description: 'Re-run AI review whenever new commits are pushed to an open PR.', category: 'code-quality', icon: '🔄', tags: ['ai', 'review', 'pr', 'synchronize'], template: 'ai-pr-review', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github', 'gh-cli'], event: ['pull_request.synchronize'] } },
    { id: 'respond-to-reviews', name: 'Respond to Reviews', description: 'AI reads reviewer feedback, implements fixes, runs quality checks, and pushes — then posts a structured response.', category: 'code-quality', icon: '💬', tags: ['ai', 'review', 'response', 'agent'], template: 'respond-to-reviews', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['issue_comment.created', 'pull_request_review.submitted'] } },
    { id: 'enforce-rules', name: 'Enforce Repo Rules', description: 'Claude reads your project rules (CONTRIBUTING.md, RULES.md) and checks PRs for compliance — auto-creates fix PRs.', category: 'code-quality', icon: '📏', tags: ['ai', 'rules', 'compliance', 'agent'], template: 'enforce-rules', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'security-audit', name: 'Security Audit', description: 'Comprehensive security scan: secrets, dependency vulns, XSS, SQL injection, SSRF, and more.', category: 'code-quality', icon: '🛡️', tags: ['security', 'audit', 'vulnerabilities'], template: 'security-audit', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'dependency-review', name: 'Dependency Review', description: 'Analyzes dependency changes for vulnerabilities, breaking versions, and deprecated packages.', category: 'code-quality', icon: '📦', tags: ['dependencies', 'npm', 'security'], template: 'dependency-review', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'pr-summary', name: 'PR Summary Generator', description: 'Auto-generates a structured summary of PR changes: what changed, impact, testing status.', category: 'code-quality', icon: '📋', tags: ['summary', 'pr', 'documentation'], template: 'pr-summary', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['pull_request.opened'] } },

    // ── Issue Management ──
    { id: 'fix-github-issue', name: 'Fix GitHub Issue', description: 'AI clones the repo, reads the issue, implements a fix, runs tests, and creates a PR — fully automated.', category: 'issue-management', icon: '🔧', tags: ['ai', 'agent', 'fix', 'pr'], template: 'fix-github-issue', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'issue-triage', name: 'Issue Triage Bot', description: 'Analyzes new issues, categorizes as bug/feature/question, assigns priority, and applies labels via gh CLI.', category: 'issue-management', icon: '🏷️', tags: ['ai', 'triage', 'labels', 'issues'], template: 'issue-triage', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['issues.opened'] } },
    { id: 'bug-report-validator', name: 'Bug Report Checklist', description: 'On every new issue, post a friendly checklist of what to include — repro steps, expected/actual behavior, environment, error output.', category: 'issue-management', icon: '📝', tags: ['checklist', 'bug', 'quality'], template: 'bug-report-validator', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['issues.opened'] } },
    { id: 'stale-issue-cleanup', name: 'Stale Issue Cleanup', description: 'Daily scan for issues with no activity in 30+ days — posts reminders and optionally closes very stale ones.', category: 'issue-management', icon: '🧹', tags: ['maintenance', 'stale', 'cleanup', 'cron'], template: 'stale-issue-cleanup', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['cron'], event: ['daily'] } },
    { id: 'issue-to-pr', name: 'Issue → Auto-Fix PR', description: 'When an issue is labeled "autofix", AI clones the repo and creates a fix PR automatically.', category: 'issue-management', icon: '🚀', tags: ['ai', 'autofix', 'agent'], template: 'fix-github-issue', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['issues.labeled'] } },

    // ── Documentation & Release ──
    { id: 'generate-docs', name: 'Auto-Generate Docs', description: 'Claude analyzes the codebase and generates/updates README, API docs, and architecture documentation.', category: 'docs-release', icon: '📚', tags: ['docs', 'readme', 'api', 'agent'], template: 'generate-docs', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'release-notes', name: 'Release Notes Generator', description: 'Analyzes commits since last release, categorizes changes, and generates formatted release notes.', category: 'docs-release', icon: '🎉', tags: ['release', 'changelog', 'notes'], template: 'release-notes', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'changelog-entry', name: 'Changelog Builder', description: 'When a PR is merged, auto-generates a user-friendly changelog entry.', category: 'docs-release', icon: '📋', tags: ['changelog', 'pr', 'merge'], template: 'changelog-entry', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.closed'] } },
    { id: 'update-readme', name: 'README Updater', description: 'Reads the codebase and updates README.md to reflect actual structure, setup steps, and APIs.', category: 'docs-release', icon: '📖', tags: ['readme', 'docs', 'agent'], template: 'update-readme', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'api-docs-sync', name: 'API Docs Sync', description: 'Compares API route definitions with documentation and creates a PR to fix discrepancies.', category: 'docs-release', icon: '🔗', tags: ['api', 'docs', 'sync', 'agent'], template: 'api-docs-sync', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['push'] } },

    // ── Notifications ──
    { id: 'review-notify-slack', name: 'PR Review → Slack', description: 'Reviews a PR with AI and sends the result to both GitHub and a Slack channel.', category: 'notifications', icon: '💬', tags: ['slack', 'review', 'notification'], template: 'review-notify-slack', requiredIntegrations: ['github', 'slack'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'deploy-notify-slack', name: 'Deploy Alert → Slack', description: 'Sends a Slack notification when code is pushed to the main branch.', category: 'notifications', icon: '🚀', tags: ['slack', 'deploy', 'push'], template: 'deploy-notify-slack', requiredIntegrations: ['github', 'slack'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github'], event: ['push'] } },
    { id: 'ci-failure-slack', name: 'CI Failure → Slack', description: 'Receives CI failure webhooks and sends formatted alerts to Slack.', category: 'notifications', icon: '❌', tags: ['slack', 'ci', 'failure', 'webhook'], template: 'ci-failure-slack', requiredIntegrations: ['slack'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['webhook'], event: ['incoming'] } },
    { id: 'issue-notify-slack', name: 'Issue Alert → Slack', description: 'Posts to Slack when a new issue is opened with title, author, and labels.', category: 'notifications', icon: '🐛', tags: ['slack', 'issues', 'notification'], template: 'issue-notify-slack', requiredIntegrations: ['github', 'slack'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['issues.opened'] } },
    { id: 'daily-digest-slack', name: 'Daily Digest → Slack', description: 'AI-powered daily summary of repo activity: PRs, issues, commits. Sent to Slack each morning.', category: 'notifications', icon: '📊', tags: ['slack', 'digest', 'cron', 'ai'], template: 'daily-digest-slack', requiredIntegrations: ['github', 'slack'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['cron'], event: ['daily'] } },

    // ── Security ──
    { id: 'secret-scan', name: 'Secret Scanner', description: 'Scans for accidentally committed secrets: API keys, passwords, tokens, private keys, .env files.', category: 'security', icon: '🔐', tags: ['security', 'secrets', 'scan'], template: 'secret-scan', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github'], event: ['push'] } },
    { id: 'license-check', name: 'License Checker', description: 'Reviews dependency licenses for compatibility issues: flags copyleft, unknown, and risky licenses.', category: 'security', icon: '📜', tags: ['license', 'compliance', 'dependencies'], template: 'license-check', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'owasp-review', name: 'OWASP Top 10 Review', description: 'Checks code against OWASP Top 10 security vulnerabilities with detailed findings.', category: 'security', icon: '🛡️', tags: ['owasp', 'security', 'vulnerabilities'], template: 'security-audit', requiredIntegrations: ['github'], difficulty: 'medium', status: 'coming-soon', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'compliance-report', name: 'Compliance Report', description: 'Weekly automated compliance report covering security, licensing, and code quality metrics.', category: 'security', icon: '📊', tags: ['compliance', 'report', 'cron'], template: 'enforce-rules', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'coming-soon', popular: false, defaultTrigger: { source: ['cron'], event: ['daily'] } },

    // ── Productivity ──
    { id: 'auto-label-pr', name: 'Auto-Label PRs', description: 'Analyzes PR diff and applies relevant labels (bug, feature, docs, refactor, tests, etc.) via gh CLI.', category: 'productivity', icon: '🏷️', tags: ['labels', 'pr', 'automation'], template: 'auto-label-pr', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['pull_request.opened'] } },
    { id: 'standup-generator', name: 'Standup Generator', description: 'AI-powered daily standup report summarizing recent activity across PRs, issues, and commits.', category: 'productivity', icon: '☀️', tags: ['standup', 'daily', 'cron', 'ai'], template: 'daily-digest-slack', requiredIntegrations: ['github', 'slack'], difficulty: 'medium', status: 'coming-soon', popular: false, defaultTrigger: { source: ['cron'], event: ['daily'] } },
    { id: 'log-everything', name: 'Log Everything', description: 'Simple event logger — logs a message whenever any event fires. Great for debugging.', category: 'productivity', icon: '📝', tags: ['log', 'debug', 'events'], template: 'log-events', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['push'] } },
    { id: 'webhook-forwarder', name: 'Webhook Forwarder', description: 'Forward events to an external HTTP endpoint. Connect Sokuza to any external service.', category: 'productivity', icon: '🔗', tags: ['webhook', 'forward', 'integration'], template: 'log-events', requiredIntegrations: [], difficulty: 'easy', status: 'coming-soon', popular: false, defaultTrigger: { source: ['webhook'], event: ['incoming'] } },
    { id: 'test-impact', name: 'Test Impact Analyzer', description: 'Analyzes which tests are affected by PR changes and suggests which test suites to run.', category: 'productivity', icon: '🧪', tags: ['tests', 'ci', 'analysis'], template: 'ai-pr-review', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'coming-soon', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },

    // ── Advanced Code Quality (Skills-inspired) ──
    { id: 'pr-inspector', name: 'PR Inspector', description: 'Senior-level PR review with P1/P2/P3 severity prioritization, AI slop detection, full-context analysis, and mandatory approve/reject decision.', category: 'code-quality', icon: '🔎', tags: ['ai', 'review', 'pr', 'structured', 'severity'], template: 'pr-inspector', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['github', 'gh-cli'], event: ['pull_request.opened'] } },
    { id: 'deep-audit', name: 'Deep Audit', description: 'Staff-engineer-level codebase audit across correctness, architecture, and standards — auto-detects project type and scores code X/10.', category: 'code-quality', icon: '🔬', tags: ['audit', 'quality', 'scoring', 'architecture'], template: 'deep-audit', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'quality-loop', name: 'Quality Loop', description: 'Iterative improvement engine: audit → fix → test → re-rate across 5 dimensions — repeats until target score met (default 9/10).', category: 'code-quality', icon: '🔄', tags: ['quality', 'iterative', 'improvement', 'scoring'], template: 'quality-loop', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'ship-check', name: 'Ship Check', description: 'Pre-merge verification: runs tests, scans for debug artifacts and secrets, checks build — posts pass/fail table with SHIP IT or HOLD verdict.', category: 'code-quality', icon: '✅', tags: ['verification', 'pre-merge', 'checklist'], template: 'ship-check', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },

    // ── Diagnostics ──
    { id: 'failure-tracer', name: 'Failure Tracer', description: '5-phase failure analysis: extracts failures, classifies root causes, clusters related issues, ranks by impact, and proposes specific fixes.', category: 'diagnostics', icon: '🔍', tags: ['debugging', 'failure', 'analysis', 'clustering'], template: 'failure-tracer', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'progress-pulse', name: 'Progress Pulse', description: 'Quick project health check: git status, test results, TODOs, open PRs/issues — compact report with next recommended action.', category: 'diagnostics', icon: '📊', tags: ['status', 'health', 'overview'], template: 'progress-pulse', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'static-scan', name: 'Static Scan', description: 'Language-agnostic static analysis: auto-detects project languages, runs available linters/scanners, groups findings by severity.', category: 'security', icon: '🔬', tags: ['static-analysis', 'linting', 'scanning', 'security'], template: 'static-scan', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: true, defaultTrigger: { source: ['github'], event: ['push'] } },

    // ── Research & Experimentation ──
    { id: 'goal-pursuit', name: 'Goal Pursuit', description: 'Iterative goal engine: decompose → measure baseline → diagnose → hypothesize → execute → verify — repeats until measurable target met.', category: 'research', icon: '🎯', tags: ['iterative', 'goals', 'measurement', 'experiments'], template: 'goal-pursuit', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'experiment-runner', name: 'Experiment Runner', description: 'Data-driven improvement: audits internal metrics, generates hypotheses, runs controlled experiments, reports with before/after data.', category: 'research', icon: '🧪', tags: ['experiments', 'metrics', 'improvement', 'data-driven'], template: 'experiment-runner', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'repo-scout', name: 'Repo Scout', description: '4-phase codebase exploration: reads docs, explores structure, fills gaps, synthesizes a complete project briefing with architecture and dev guide.', category: 'productivity', icon: '🗺️', tags: ['onboarding', 'exploration', 'architecture', 'overview'], template: 'repo-scout', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: true, defaultTrigger: { source: ['manual'], event: ['manual'] } },

    // ── Node Coverage Templates ──
    // Each entry below is a graph-form workflow that exercises specific
    // dark-surface nodes (round-trip GitHub, data extractors, flow control,
    // alternate triggers) so the visual editor + runtime get end-to-end
    // proof for every node type. Open each in the editor to see how the
    // node it covers is wired in practice.
    { id: 'pr-merge-on-green', name: 'Auto-Merge on Green CI', description: 'On approving review, fetch PR, wait for CI checks, then squash-merge automatically. Notifies a Slack channel.', category: 'code-quality', icon: '🟣', tags: ['merge', 'ci', 'auto-merge', 'flow.if'], template: 'pr-merge-on-green', requiredIntegrations: ['github', 'slack'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request_review.submitted'] } },
    { id: 'pr-rename-title', name: 'Rewrite PR Titles', description: 'Decompose new PR fields and PATCH the title into "feat(branch): subject" via github.update-pr.', category: 'code-quality', icon: '✏️', tags: ['title', 'conventional-commits', 'data.template'], template: 'pr-rename-title', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'issue-autofix-pr', name: 'Issue → Autofix PR', description: 'When an issue gets the "autofix" label, fetch it, clone the repo, agent writes a fix, commit + push, open a PR.', category: 'issue-management', icon: '🔧', tags: ['autofix', 'agent', 'git.commit-and-push'], template: 'issue-autofix-pr', requiredIntegrations: ['github'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['issues.labeled'] } },
    { id: 'pr-size-labeler', name: 'PR Size Labeler', description: 'Read PR additions count via data.json-pluck and add/remove a "size:large" label based on a threshold.', category: 'productivity', icon: '🏷️', tags: ['labels', 'size', 'flow.if', 'data.json-pluck'], template: 'pr-size-labeler', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened'] } },
    { id: 'slack-mention-react', name: 'Slack Mention React', description: 'React 👀 to every Slack @-mention so users see their message landed before the bot responds.', category: 'notifications', icon: '👀', tags: ['slack', 'react', 'trigger.slack'], template: 'slack-mention-react', requiredIntegrations: ['slack'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['slack'], event: ['app_mention'] } },
    { id: 'cron-stale-pr-bump', name: 'Cron — Stale PR Bump', description: 'Daily cron trigger — agent uses the local gh CLI to nudge PRs that have been idle for 7+ days.', category: 'productivity', icon: '⏰', tags: ['cron', 'stale', 'gh-cli'], template: 'cron-stale-pr-bump', requiredIntegrations: [], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['cron'], event: ['daily'] } },
    { id: 'webhook-forwarder', name: 'Webhook Forwarder', description: 'Inbound webhook → outbound webhook. Decompose the event, build a payload via data.template, POST it onward. Requires a configured webhook endpoint.', category: 'productivity', icon: '🪝', tags: ['webhook', 'forwarder', 'utility.webhook'], template: 'webhook-forwarder', requiredIntegrations: [], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['webhook'], event: ['deploy-hook'] } },
    { id: 'event-debug-tap', name: 'Event Debug Tap', description: 'Wires data.event-fields → utility.log to dump every incoming event\'s source/name/payload to the log.', category: 'diagnostics', icon: '🩺', tags: ['debug', 'data.event-fields', 'tap'], template: 'event-debug-tap', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request.opened', 'push', 'issues.opened'] } },
    { id: 'gh-cli-quick-review', name: 'gh-CLI Quick Review', description: 'Local gh-CLI poll — review each new PR and post a real GitHub Review (not just a comment).', category: 'code-quality', icon: '⚡', tags: ['gh-cli', 'review', 'local-only'], template: 'gh-cli-quick-review', requiredIntegrations: ['gh-cli'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['gh-cli'], event: ['pull_request.opened'] } },
    { id: 'address-review-on-changes', name: 'Auto-Address Review Feedback', description: 'When a reviewer requests changes, run ai.address-review in suggest-mode and post inline fix suggestions.', category: 'code-quality', icon: '🩹', tags: ['address-review', 'auto-fix', 'data.review-fields'], template: 'address-review-on-changes', requiredIntegrations: ['github', 'slack'], difficulty: 'advanced', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['pull_request_review.submitted'] } },
    { id: 'push-changelog-pr', name: 'Push Changelog Draft', description: 'On push to main, decompose commits, pluck the latest SHA, log a changelog header derived from the message list.', category: 'docs-release', icon: '📜', tags: ['push', 'commits', 'data.commits-fields'], template: 'push-changelog-pr', requiredIntegrations: ['github'], difficulty: 'medium', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['push'] } },
    { id: 'flow-merge-demo', name: 'Flow.merge Demo', description: 'Two flow.set values feed into flow.merge — the first defined wins. Demonstrates fan-in.', category: 'productivity', icon: '🔗', tags: ['flow.merge', 'flow.set', 'demo'], template: 'flow-merge-demo', requiredIntegrations: [], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'flow-filter-demo', name: 'Flow.filter-list Demo', description: 'Filter a JSON array by a per-item field test — count + first-match outputs flow downstream.', category: 'productivity', icon: '⚗️', tags: ['flow.filter-list', 'demo'], template: 'flow-filter-demo', requiredIntegrations: [], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['manual'], event: ['manual'] } },
    { id: 'github-poll-watch', name: 'GitHub Poll Watch', description: 'No-webhook setup — Sokuza polls the GitHub REST API for events and logs each one.', category: 'productivity', icon: '🔄', tags: ['github-poll', 'log', 'no-webhook'], template: 'github-poll-watch', requiredIntegrations: ['github-poll'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github-poll'], event: ['pull_request.opened'] } },
];

// ─── Array helpers ──────────────────────────────────────────────────────────
function ensureArray(val) {
    if (val === undefined || val === null) return [];
    if (Array.isArray(val)) return val.filter(v => v !== '' && v !== undefined);
    return val === '' ? [] : [val];
}

// ─── Auth ───────────────────────────────────────────────────────────────────
// Bearer token gate for /api/*. Server generates the token and prints it on
// first run (`sokuza token` reveals it again). We seed localStorage from the
// ?t=<token> URL param when the user lands from the startup log, then strip
// the param so the token isn't sitting in the tab title / history.
const TOKEN_STORAGE_KEY = 'sokuza:dashboardToken';

function tokenFromUrl() {
    const qp = new URLSearchParams(window.location.search);
    return qp.get('t');
}

function loadToken() {
    const fromUrl = tokenFromUrl();
    if (fromUrl) {
        try { localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch {}
        const url = new URL(window.location.href);
        url.searchParams.delete('t');
        window.history.replaceState({}, '', url.pathname + url.hash);
        return fromUrl;
    }
    try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch { return null; }
}

function saveToken(token) {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch {}
}

function clearToken() {
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
}

let dashboardToken = loadToken();

function authedFetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (dashboardToken) headers.set('Authorization', `Bearer ${dashboardToken}`);
    return fetch(url, { ...init, headers });
}

async function handleAuthFailure(response) {
    if (response.status !== 401) return false;
    clearToken();
    dashboardToken = null;
    promptForToken();
    return true;
}

function promptForToken() {
    if (document.getElementById('sokuza-token-prompt')) return;
    const overlay = document.createElement('div');
    overlay.id = 'sokuza-token-prompt';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,9,.92);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="max-width:28rem;background:#1a1a18;border:1px solid #333;padding:1.75rem;">
            <h2 style="margin:0 0 .5rem;font-size:1.2rem;color:#f5f5f0;">Dashboard token required</h2>
            <p style="color:#b0b0a8;font-size:.9rem;margin-bottom:1rem;line-height:1.5;">
                Paste the bearer token for this sokuza instance. Run
                <code style="color:#e07b43;background:#222;padding:1px 4px;">sokuza token</code>
                in a terminal to reveal it.
            </p>
            <input id="sokuza-token-input" type="password" placeholder="64-char hex token" autocomplete="off" autofocus
                   style="width:100%;padding:.55rem .65rem;background:#0f0f0d;color:#f5f5f0;border:1px solid #333;font-family:ui-monospace,monospace;font-size:.85rem;margin-bottom:.75rem;" />
            <div style="display:flex;gap:.5rem;justify-content:flex-end;">
                <button id="sokuza-token-submit" style="padding:.5rem 1rem;background:#e07b43;color:#0a0a09;border:none;font-weight:500;cursor:pointer;">Unlock</button>
            </div>
            <p id="sokuza-token-error" style="color:#e0746a;font-size:.8rem;margin-top:.75rem;display:none;">Token rejected. Double-check and try again.</p>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#sokuza-token-input');
    const submit = overlay.querySelector('#sokuza-token-submit');
    const error = overlay.querySelector('#sokuza-token-error');

    const attempt = async () => {
        const val = input.value.trim();
        if (!val) return;
        const probe = await fetch('/api/config', { headers: { Authorization: `Bearer ${val}` } });
        if (probe.ok) {
            saveToken(val);
            // Reload so every initial-data fetch re-runs cleanly with the
            // token attached, rather than patching the partially-initialised
            // app state in place.
            window.location.reload();
        } else {
            error.style.display = 'block';
            input.select();
        }
    };
    submit.addEventListener('click', attempt);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
}

// If we landed without a token, surface the prompt immediately so the
// dashboard never renders a confused "everything is failing" state.
if (!dashboardToken) promptForToken();

// ─── API Layer ──────────────────────────────────────────────────────────────
async function readErrorMessage(r) {
    // Server endpoints return JSON `{ error: "..." }` on failure. Surface
    // it to the caller's toast/log instead of leaving them with a bare
    // status code; debugging through `tsx watch` logs is rough otherwise.
    try {
        const body = await r.clone().json();
        if (body && typeof body.error === 'string') return body.error;
    } catch { /* not JSON */ }
    try {
        const text = await r.text();
        if (text) return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch { /* */ }
    return `HTTP ${r.status}`;
}

const api = {
    async get(p) {
        const r = await authedFetch(p);
        if (r.status === 401) { await handleAuthFailure(r); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error(await readErrorMessage(r));
        return r.json();
    },
    async post(p, b) {
        const init = { method: 'POST' };
        if (b !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(b);
        }
        const r = await authedFetch(p, init);
        if (r.status === 401) { await handleAuthFailure(r); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error(await readErrorMessage(r));
        return r.json();
    },
    async put(p, b) {
        const init = { method: 'PUT' };
        if (b !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(b);
        }
        const r = await authedFetch(p, init);
        if (r.status === 401) { await handleAuthFailure(r); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error(await readErrorMessage(r));
        return r.json();
    },
    async del(p) {
        const r = await authedFetch(p, { method: 'DELETE' });
        if (r.status === 401) { await handleAuthFailure(r); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error(await readErrorMessage(r));
        return r.json();
    },
};

// ─── Toast Notifications ────────────────────────────────────────────────────
function toast(message, type = 'success') {
    const container = document.getElementById('toast-container') || (() => {
        const c = document.createElement('div');
        c.id = 'toast-container';
        c.className = 'toast-container';
        document.body.appendChild(c);
        return c;
    })();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────────
function confirm(msg) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `<div class="confirm-box"><p>${msg}</p><div class="btn-group"><button class="btn btn-ghost" data-action="no">Cancel</button><button class="btn btn-danger-outline" data-action="yes">Confirm</button></div></div>`;
        document.body.appendChild(overlay);
        const cleanup = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('[data-action="yes"]').onclick = () => cleanup(true);
        overlay.querySelector('[data-action="no"]').onclick = () => cleanup(false);
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
    });
}

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(page) {
    // Give the visual editor (or any other surface with unsaved state)
    // a chance to prompt before we tear it down. The editor registers
    // `window.__beforeNavigate` while it's open and dirty; a `false`
    // return means the user cancelled and we should stay where we are.
    if (typeof window.__beforeNavigate === 'function' && !window.__beforeNavigate()) {
        return;
    }
    if (page === 'templates') page = 'library';
    if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
    if (logSource) { logSource.close(); logSource = null; }
    expandedEvents.clear();
    currentPage = page;
    window.location.hash = page;
    $$('.nav-link').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
    // Close sidebar on mobile
    $('#sidebar')?.classList.remove('open');
    $('#sidebar-backdrop')?.classList.remove('open');
    renderPage();
}

// ─── Sidebar Toggle ─────────────────────────────────────────────────────────
window.toggleSidebar = function () {
    $('#sidebar').classList.toggle('open');
    $('#sidebar-backdrop').classList.toggle('open');
};

async function renderPage() {
    const el = $('#content');
    // Skeleton loading state
    el.innerHTML = `<div style="padding:8px 0">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="card-grid" style="margin-top:20px">
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
        </div>
    </div>`;
    try {
        switch (currentPage) {
            case 'dashboard': await renderDashboard(el); break;
            case 'my-prs': await renderMyPrs(el); break;
            case 'issues': await renderIssues(el); break;
            case 'workflows': await renderWorkflows(el); break;
            case 'chat': await renderChat(el); break;

            case 'library': await renderLibrary(el); break;
            case 'integrations': await renderIntegrations(el); break;
            case 'events': await renderEvents(el); break;
            case 'queue': await renderQueue(el); break;
            case 'auto-fix': await renderAutoFix(el); break;
            case 'ai-reviews': await renderAiReviews(el); break;
            case 'logs': await renderLogs(el); break;
            case 'system': await renderSystem(el); break;
            case 'settings': await renderSettings(el); break;
        }
        el.classList.remove('page-enter');
        void el.offsetWidth;
        el.classList.add('page-enter');
    } catch (err) {
        el.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">Error loading page: ${err.message}</p><button class="btn btn-ghost" onclick="renderPage()">Retry</button></div>`;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
async function renderDashboard(el) {
    await loadAll();
    const activeInt = Object.values(integrations).filter((v) => v.enabled).length;
    const recent = events.slice(0, 8);

    el.innerHTML = `
        <div class="page-header"><div class="page-header-left">
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Overview of your Sokuza instance</p>
        </div></div>

        <div class="card-grid">
            <div class="card card-stat card-clickable" onclick="navigate('workflows')">
                <div class="stat-value">${workflows.length}</div>
                <div class="stat-label">Workflows</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('integrations')">
                <div class="stat-value">${activeInt}</div>
                <div class="stat-label">Integrations</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('templates')">
                <div class="stat-value">${templates.length}</div>
                <div class="stat-label">Templates</div>
            </div>
            <div class="card card-stat card-clickable" onclick="navigate('events')">
                <div class="stat-value">${eventStats.total ?? events.length}</div>
                <div class="stat-label">Total Events</div>
            </div>
        </div>

        ${eventStats.hourlyBuckets ? `
        <div class="card" style="margin-bottom:24px;padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">EVENT ACTIVITY (24h)</span>
                <span style="font-size:12px;color:var(--text-muted)">${eventStats.lastHour ?? 0} in last hour</span>
            </div>
            ${renderBarChart(eventStats.hourlyBuckets)}
        </div>` : ''}

        <div class="table-wrap">
            <div class="table-top">
                <span class="table-top-title">Recent Events</span>
                <button class="btn btn-ghost btn-sm" onclick="navigate('events')">View All →</button>
            </div>
            ${recent.length > 0 ? `<table><thead><tr><th>Time</th><th>Source</th><th>Event</th><th>Workflows</th></tr></thead><tbody>
                ${recent.map((e) => `<tr>
                    <td style="font-family:var(--mono);font-size:12px;color:var(--text-muted)">${fmtDateTime(e.timestamp)}</td>
                    <td>${sourceBadge(e.event?.source)}</td>
                    <td><code style="font-size:12px;color:var(--accent-hover)">${esc(e.event?.event ?? '?')}</code></td>
                    <td>${(e.matchedWorkflows?.length ? e.matchedWorkflows.map(w => `<span class="badge badge-action">${esc(w)}</span>`).join(' ') : '<span style="color:var(--text-muted);font-size:12px">—</span>')}</td>
                </tr>`).join('')}
            </tbody></table>` : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events yet — send a webhook to get started</p></div>'}
        </div>

        <div class="card" style="padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">ACTIVE WORKFLOWS</span>
            </div>
            ${workflows.length > 0 ? workflows.map(wf => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(99,102,241,0.06)">
                    <span style="font-weight:600;font-size:13px;flex:1">${esc(wf.name)}</span>
                    ${sourceBadge(wf.trigger?.source || 'github')}
                    <code style="font-size:11px;color:var(--text-muted)">${esc(wf.trigger?.event ?? '')}</code>
                    ${wf.template ? `<span class="badge badge-action" style="font-size:10px">${esc(wf.template)}</span>` : ''}
                </div>
            `).join('') : '<div style="font-size:12px;color:var(--text-muted)">No workflows</div>'}
        </div>

        ${deck.length > 0 ? `
        <div class="card" style="padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">⚡ QUICK ACTIONS</span>
                <button class="btn btn-ghost btn-sm" onclick="navigate('library')" style="font-size:11px">Browse Library →</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
                ${deck.map(id => {
                    const item = libraryItems.find(i => i.id === id);
                    if (!item) return '';
                    const wfName = getInstalledWorkflowName(item.id);
                    const isManual = ensureArray(item.defaultTrigger?.event).includes('manual');
                    return `<div class="quick-action-card" style="display:flex;align-items:center;gap:10px;padding:12px;border-radius:8px;background:var(--bg-secondary);border:1px solid var(--border-color);cursor:pointer;transition:all 0.15s" onmouseover="this.style.borderColor='var(--border-active)'" onmouseout="this.style.borderColor='var(--border-color)'">
                        <span style="font-size:20px">${item.icon}</span>
                        <div style="flex:1;min-width:0">
                            <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
                            <div style="font-size:10px;color:var(--text-muted)">${isManual ? 'Manual' : 'Auto: ' + esc(ensureArray(item.defaultTrigger?.event).join(', '))}</div>
                        </div>
                        ${wfName && isManual ? `<button class="btn btn-primary btn-sm" style="padding:4px 8px;font-size:11px" onclick="event.stopPropagation();openRunModal('${esc(wfName)}')">▶</button>` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>
        ` : `
        <div class="card" style="padding:18px 20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">⚡ QUICK ACTIONS</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6">
                Install recipes from the <a href="#library" onclick="event.preventDefault();navigate('library')" style="color:var(--accent)">Library</a> to get quick-launch actions here.
            </div>
        </div>
        `}
    `;
}

// ═════════════════════════════════════════════════════════════════════════════
// MY PRS (gh CLI powered)
// ═════════════════════════════════════════════════════════════════════════════
async function renderMyPrs(el) {
    let prsData;
    try {
        prsData = await api.get('/api/my-prs');
    } catch {
        el.innerHTML = `
            <div class="page-header">
                <div class="page-header-left">
                    <h1 class="page-title">My Pull Requests</h1>
                    <p class="page-subtitle">Powered by gh CLI</p>
                </div>
            </div>
            <div class="empty-state">
                <div class="empty-icon">🔗</div>
                <p class="empty-text">GitHub CLI not available</p>
                <p style="color:var(--text-secondary);font-size:13px;margin-top:8px">
                    Install <a href="https://cli.github.com/" target="_blank" style="color:var(--accent)">gh CLI</a> and run <code>gh auth login</code> to enable this feature.
                </p>
            </div>`;
        return;
    }

    const prs = prsData.prs || [];
    const wfData = await api.get('/api/workflows');
    const allWorkflows = wfData.workflows || [];

    // Build deck-sourced PR action buttons
    const deckPrItems = getDeckPrItems();
    // Fallback: still show review/respond if user has those workflows but hasn't used library
    const reviewWf = deckPrItems.length === 0 ? (allWorkflows.find(w => w.template === 'ai-pr-review') ?? allWorkflows.find(w => w.name.toLowerCase().includes('review'))) : null;
    const respondWf = deckPrItems.length === 0 ? (allWorkflows.find(w => w.template === 'respond-to-reviews') ?? allWorkflows.find(w => w.name.toLowerCase().includes('respond'))) : null;

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">My Pull Requests</h1>
                <p class="page-subtitle">${prs.length} open PR${prs.length !== 1 ? 's' : ''} across all repositories</p>
            </div>
            <button class="btn btn-ghost" onclick="navigate('my-prs')" title="Refresh">↻ Refresh</button>
        </div>

        ${prs.length > 0 ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px">
                ${prs.map(pr => {
                    const repoName = pr.repository?.nameWithOwner ?? 'unknown';
                    const [owner, repo] = repoName.split('/');
                    const labels = (pr.labels ?? []).map(l => `<span class="badge badge-action" style="font-size:10px;margin-right:4px">${esc(l.name)}</span>`).join('');
                    const ago = timeAgo(pr.updatedAt);

                    return `<div class="card" style="padding:20px;border-radius:12px;background:var(--card-bg);border:1px solid var(--border)">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
                            <div style="flex:1;min-width:0">
                                <a href="${esc(pr.url)}" target="_blank" style="font-size:15px;font-weight:600;color:var(--accent-hover);text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(pr.title)}">
                                    #${pr.number} ${esc(pr.title)}
                                </a>
                                <div style="font-size:12px;color:var(--text-muted);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                    <span title="Repository">${esc(repoName)}</span>
                                    <span>·</span>
                                    <span title="Last updated">${ago}</span>
                                    ${pr.isDraft ? '<span class="badge" style="background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.3);font-size:10px">Draft</span>' : ''}
                                </div>
                            </div>
                        </div>

                        ${labels ? `<div style="margin-bottom:12px">${labels}</div>` : ''}

                        <div class="btn-group" style="flex-wrap:wrap">
                            ${deckPrItems.map(di => {
                                const wfName = getInstalledWorkflowName(di.id);
                                return wfName ? `<button class="btn btn-primary btn-sm" onclick="runWorkflowForPr('${esc(wfName)}', '${esc(owner)}', '${esc(repo)}', ${pr.number})" title="${esc(di.description)}">${di.icon} ${esc(di.name)}</button>` : '';
                            }).join('')}
                            ${reviewWf ? `<button class="btn btn-primary btn-sm" onclick="runWorkflowForPr('${esc(reviewWf.name)}', '${esc(owner)}', '${esc(repo)}', ${pr.number})" title="Run AI code review on this PR">🔍 Review</button>` : ''}
                            ${respondWf ? `<button class="btn btn-ghost btn-sm" onclick="runWorkflowForPr('${esc(respondWf.name)}', '${esc(owner)}', '${esc(repo)}', ${pr.number})" title="Respond to review comments">💬 Respond</button>` : ''}
                            <button class="btn btn-ghost btn-sm" onclick="openRunModalForPr('${esc(owner)}', '${esc(repo)}', ${pr.number})" title="Run any workflow against this PR">▶ Run Workflow</button>
                            <a href="${esc(pr.url)}" target="_blank" class="btn btn-ghost btn-sm" title="Open on GitHub">↗ GitHub</a>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        ` : `
            <div class="empty-state">
                <div class="empty-icon">🎉</div>
                <p class="empty-text">No open pull requests</p>
                <p style="color:var(--text-secondary);font-size:13px">You have no open PRs. Create one on GitHub to see it here.</p>
            </div>
        `}
    `;
}

// Run a specific workflow against a PR
window.runWorkflowForPr = async function (workflowName, owner, repo, prNumber) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        // The engine's input-enrichment (engine.ts runWorkflowByName) looks
        // up `inputs[<def.name>]` where <def.name> comes from the workflow's
        // own `inputs:` block, then synthesizes payload.pull_request and
        // metadata.repo from the selection. So we need to figure out what
        // that input is actually called for this specific workflow —
        // hardcoding "pull_request" (like this button used to) didn't
        // match the typical "pr" input name and enrichment silently
        // skipped, leaving github-clone-repo with no repo to clone.
        const wf = workflows.find(w => w.name === workflowName);
        const prInputName = wf?.inputs?.find(i => i.type === 'github-pr')?.name;
        const selection = {
            number: prNumber,
            repo: `${owner}/${repo}`,
        };
        const inputs = prInputName
            ? { [prInputName]: selection }
            // No github-pr input defined — fall back to the flat shape so
            // legacy/custom workflows that read event.payload.inputs.* keep
            // working.
            : { pull_request: { number: prNumber }, owner, repo: `${owner}/${repo}`, repoName: repo, prNumber };

        const result = await api.post(`/api/workflows/${encodeURIComponent(workflowName)}/run`, { inputs });
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast(`Workflow "${workflowName}" started for PR #${prNumber}`);
        }
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        if (btn) { btn.disabled = false; }
        setTimeout(() => navigate('my-prs'), 1000);
    }
};

// Open the generic run modal pre-filled with PR context
window.openRunModalForPr = function (owner, repo, prNumber) {
    // Find all workflows that could run against a PR
    const prWorkflows = workflows.filter(wf => {
        const events = Array.isArray(wf.trigger?.event) ? wf.trigger.event : [wf.trigger?.event];
        return events.some(e => e?.startsWith('pull_request'));
    });

    if (prWorkflows.length === 0) {
        toast('No PR workflows configured. Create one from the Workflows page.', 'error');
        return;
    }

    const options = prWorkflows.map(wf => `<option value="${esc(wf.name)}">${esc(wf.name)}${wf.template ? ` (${esc(wf.template)})` : ''}</option>`).join('');

    openModal('Run Workflow on PR #' + prNumber, `
        <div style="margin-bottom:16px">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:var(--text-secondary)">Select Workflow</label>
            <select id="pr-wf-select" style="width:100%;padding:10px 12px;border-radius:8px;background:var(--input-bg);border:1px solid var(--border);color:var(--text-primary);font-size:14px">
                ${options}
            </select>
        </div>
        <div style="padding:12px;border-radius:8px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);margin-bottom:16px">
            <div style="font-size:12px;color:var(--text-secondary)">
                <strong>Target:</strong> ${esc(owner)}/${esc(repo)} #${prNumber}
            </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="runSelectedPrWorkflow('${esc(owner)}', '${esc(repo)}', ${prNumber})">▶ Run</button>
        </div>
    `);
};

window.runSelectedPrWorkflow = function (owner, repo, prNumber) {
    const select = document.getElementById('pr-wf-select');
    if (!select) return;
    closeModal();
    window.runWorkflowForPr(select.value, owner, repo, prNumber);
};

// ═════════════════════════════════════════════════════════════════════════════
// ISSUES
// ═════════════════════════════════════════════════════════════════════════════

let issueActions = [];
let issueRepoFilter = 'all';

async function renderIssues(el) {
    let issuesData;
    try {
        [issuesData] = await Promise.all([
            api.get('/api/my-issues'),
        ]);
    } catch {
        el.innerHTML = `
            <div class="page-header">
                <div class="page-header-left">
                    <h1 class="page-title">Issues</h1>
                    <p class="page-subtitle">Manage and act on GitHub issues</p>
                </div>
            </div>
            <div class="empty-state">
                <div class="empty-icon">🔗</div>
                <p class="empty-text">GitHub CLI not available</p>
                <p style="color:var(--text-secondary);font-size:13px;margin-top:8px">
                    Install <a href="https://cli.github.com/" target="_blank" style="color:var(--accent)">gh CLI</a> and run <code>gh auth login</code> to enable this feature.
                </p>
            </div>`;
        return;
    }

    const issues = issuesData.issues || [];

    // Load issue actions and workflows
    let actionsData, wfData;
    try { actionsData = await api.get('/api/issue-actions'); } catch { actionsData = { actions: [] }; }
    try { wfData = await api.get('/api/workflows'); } catch { wfData = { workflows: [] }; }
    issueActions = actionsData.actions || [];
    workflows = wfData.workflows || [];

    // Build repo list for filter tabs
    const repos = [...new Set(issues.map(i => i.repository?.nameWithOwner).filter(Boolean))];

    // Filter issues by selected repo
    const filtered = issueRepoFilter === 'all' ? issues : issues.filter(i => i.repository?.nameWithOwner === issueRepoFilter);

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Issues</h1>
                <p class="page-subtitle">${issues.length} open issue${issues.length !== 1 ? 's' : ''} assigned to you</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost" onclick="navigate('issues')" title="Refresh">↻ Refresh</button>
                <button class="btn btn-primary" onclick="openIssueActionEditor()" title="Configure issue actions">⚙ Actions</button>
            </div>
        </div>

        ${repos.length > 1 ? `
        <div class="issue-repo-tabs" style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
            <button class="btn btn-sm ${issueRepoFilter === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick="setIssueRepoFilter('all')">All (${issues.length})</button>
            ${repos.map(r => {
                const count = issues.filter(i => i.repository?.nameWithOwner === r).length;
                return `<button class="btn btn-sm ${issueRepoFilter === r ? 'btn-primary' : 'btn-ghost'}" onclick="setIssueRepoFilter('${esc(r)}')">${esc(r.split('/')[1] || r)} (${count})</button>`;
            }).join('')}
        </div>` : ''}

        ${issueActions.length > 0 ? `
        <div class="card" style="padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text-muted);font-weight:600">CONFIGURED ACTIONS:</span>
            ${issueActions.map(a => `
                <span class="badge badge-action" style="font-size:11px;display:flex;align-items:center;gap:4px">
                    ${a.icon ? `<span>${esc(a.icon)}</span>` : ''}${esc(a.name)}
                    ${a.workflow ? `<span style="font-size:9px;color:var(--text-muted)">→ ${esc(a.workflow)}</span>` : ''}
                </span>
            `).join('')}
            <button class="btn btn-ghost btn-sm" onclick="openIssueActionEditor()" style="margin-left:auto;font-size:11px">Edit</button>
        </div>` : ''}

        ${filtered.length > 0 ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px">
                ${filtered.map(issue => {
                    const repoName = issue.repository?.nameWithOwner ?? 'unknown';
                    const [owner, repo] = repoName.split('/');
                    const labels = (issue.labels ?? []).map(l => {
                        const bg = l.color ? `#${l.color}` : 'rgba(99,102,241,0.15)';
                        const textColor = l.color ? getContrastColor(l.color) : 'var(--accent)';
                        return `<span class="badge" style="background:${bg};color:${textColor};border:1px solid ${l.color ? `#${l.color}40` : 'rgba(99,102,241,0.3)'};font-size:10px;margin-right:4px">${esc(l.name)}</span>`;
                    }).join('');
                    const assignees = (issue.assignees ?? []).map(a => a.login).join(', ');
                    const ago = timeAgo(issue.updatedAt);

                    return `<div class="card" style="padding:20px;border-radius:12px;background:var(--card-bg);border:1px solid var(--border)">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
                            <div style="flex:1;min-width:0">
                                <a href="${esc(issue.url)}" target="_blank" style="font-size:15px;font-weight:600;color:var(--accent-hover);text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(issue.title)}">
                                    #${issue.number} ${esc(issue.title)}
                                </a>
                                <div style="font-size:12px;color:var(--text-muted);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                    <span title="Repository">${esc(repoName)}</span>
                                    <span>·</span>
                                    <span title="Last updated">${ago}</span>
                                    ${assignees ? `<span>·</span><span title="Assignees">👤 ${esc(assignees)}</span>` : ''}
                                    <span class="badge" style="background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3);font-size:10px">${esc(issue.state)}</span>
                                </div>
                            </div>
                        </div>

                        ${labels ? `<div style="margin-bottom:12px">${labels}</div>` : ''}

                        <div class="btn-group" style="flex-wrap:wrap">
                            ${issueActions.map(a => `<button class="btn btn-primary btn-sm" onclick="runIssueAction('${esc(a.id)}', '${esc(owner)}', '${esc(repo)}', ${issue.number})" title="${esc(a.description || a.name)}">${a.icon ? esc(a.icon) + ' ' : ''}${esc(a.name)}</button>`).join('')}
                            ${getDeckIssueItems().map(di => {
                                const wfName = getInstalledWorkflowName(di.id);
                                return wfName ? `<button class="btn btn-primary btn-sm" onclick="runIssueWorkflow('${esc(wfName)}', '${esc(owner)}', '${esc(repo)}', ${issue.number})" title="${esc(di.description)}">${di.icon} ${esc(di.name)}</button>` : '';
                            }).join('')}
                            <button class="btn btn-ghost btn-sm" onclick="openIssueWorkflowModal('${esc(owner)}', '${esc(repo)}', ${issue.number})" title="Run any workflow against this issue">▶ Run Workflow</button>
                            <a href="${esc(issue.url)}" target="_blank" class="btn btn-ghost btn-sm" title="Open on GitHub">↗ GitHub</a>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        ` : `
            <div class="empty-state">
                <div class="empty-icon">${issues.length > 0 ? '🔍' : '🎉'}</div>
                <p class="empty-text">${issues.length > 0 ? 'No issues match this filter' : 'No open issues assigned to you'}</p>
                <p style="color:var(--text-secondary);font-size:13px">${issues.length > 0 ? 'Try selecting a different repository tab.' : 'Issues assigned to you on GitHub will appear here.'}</p>
            </div>
        `}
    `;
}

// Helper: get readable text color from hex background
function getContrastColor(hex) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#1a1a2e' : '#ffffff';
}

// Issue repo filter
window.setIssueRepoFilter = function (repo) {
    issueRepoFilter = repo;
    renderPage();
};

// Run a configured issue action
window.runIssueAction = async function (actionId, owner, repo, issueNumber) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; const orig = btn.textContent; btn.textContent = '⏳'; }
    try {
        const result = await api.post(`/api/issue-actions/${encodeURIComponent(actionId)}/run`, {
            owner,
            repo,
            issueNumber,
        });
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast(result.message || `Action started for issue #${issueNumber}`);
        }
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        if (btn) { btn.disabled = false; }
        setTimeout(() => navigate('issues'), 1000);
    }
};

function buildIssueInputs(workflowName, owner, repo, issueNumber) {
    // Mirror the engine's input-enrichment rules: it unpacks
    // inputs[<def.name>] of type github-issue into payload.issue +
    // metadata.repo. Look up the right field name on this specific
    // workflow — hardcoding "issue" works for most but not all configs.
    const wf = workflows.find(w => w.name === workflowName);
    const issueInputName = wf?.inputs?.find(i => i.type === 'github-issue')?.name;
    const selection = {
        number: issueNumber,
        repo: `${owner}/${repo}`,
    };
    return issueInputName
        ? { [issueInputName]: selection }
        : { issue: { number: issueNumber }, owner, repo: `${owner}/${repo}`, repoName: repo, issueNumber };
}

// Run a deck-sourced workflow against an issue
window.runIssueWorkflow = async function (workflowName, owner, repo, issueNumber) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        const result = await api.post(`/api/workflows/${encodeURIComponent(workflowName)}/run`, {
            inputs: buildIssueInputs(workflowName, owner, repo, issueNumber),
        });
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast(`Workflow "${workflowName}" started for issue #${issueNumber}`);
        }
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        if (btn) { btn.disabled = false; }
        setTimeout(() => navigate('issues'), 1000);
    }
};

// Open modal to pick and run any workflow against an issue
window.openIssueWorkflowModal = function (owner, repo, issueNumber) {
    // Find workflows that could work with issues (have issue inputs or issue events)
    const issueWorkflows = workflows.filter(wf => {
        const events = Array.isArray(wf.trigger?.event) ? wf.trigger.event : [wf.trigger?.event];
        const hasIssueInput = (wf.inputs ?? []).some(i => i.type === 'github-issue');
        return events.some(e => e?.startsWith('issues')) || hasIssueInput;
    });

    // Also include all manual workflows
    const manualWorkflows = workflows.filter(wf => {
        const sources = Array.isArray(wf.trigger?.source) ? wf.trigger.source : [wf.trigger?.source];
        return sources.includes('manual');
    });

    const allWorkflows = [...new Map([...issueWorkflows, ...manualWorkflows].map(w => [w.name, w])).values()];

    if (allWorkflows.length === 0 && workflows.length > 0) {
        // Fall back to all workflows if no issue-specific ones
        allWorkflows.push(...workflows);
    }

    if (allWorkflows.length === 0) {
        toast('No workflows configured. Create one from the Workflows page.', 'error');
        return;
    }

    const options = allWorkflows.map(wf => `<option value="${esc(wf.name)}">${esc(wf.name)}${wf.template ? ` (${esc(wf.template)})` : ''}</option>`).join('');

    openModal('Run Workflow on Issue #' + issueNumber, `
        <div style="margin-bottom:16px">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:var(--text-secondary)">Select Workflow</label>
            <select id="issue-wf-select" style="width:100%;padding:10px 12px;border-radius:8px;background:var(--input-bg);border:1px solid var(--border);color:var(--text-primary);font-size:14px">
                ${options}
            </select>
        </div>
        <div style="padding:12px;border-radius:8px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);margin-bottom:16px">
            <div style="font-size:12px;color:var(--text-secondary)">
                <strong>Target:</strong> ${esc(owner)}/${esc(repo)} #${issueNumber}
            </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="runSelectedIssueWorkflow('${esc(owner)}', '${esc(repo)}', ${issueNumber})">▶ Run</button>
        </div>
    `);
};

window.runSelectedIssueWorkflow = async function (owner, repo, issueNumber) {
    const select = document.getElementById('issue-wf-select');
    if (!select) return;
    const workflowName = select.value;
    closeModal();

    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
        const result = await api.post(`/api/workflows/${encodeURIComponent(workflowName)}/run`, {
            inputs: buildIssueInputs(workflowName, owner, repo, issueNumber),
        });
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast(`Workflow "${workflowName}" started for issue #${issueNumber}`);
        }
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ─── Issue Action Editor ────────────────────────────────────────────────────

window.openIssueActionEditor = async function (editId) {
    // Load current actions and workflows
    let actionsData, wfData;
    try { actionsData = await api.get('/api/issue-actions'); } catch { actionsData = { actions: [] }; }
    try { wfData = await api.get('/api/workflows'); } catch { wfData = { workflows: [] }; }
    const actions = actionsData.actions || [];
    const availWf = wfData.workflows || [];

    const editing = editId ? actions.find(a => a.id === editId) : null;

    openModal(editing ? `Edit Action: ${editing.name}` : 'Issue Actions', `
        ${!editing ? `
        <div style="margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">CONFIGURED ACTIONS</span>
            </div>
            ${actions.length > 0 ? actions.map(a => `
                <div class="card" style="padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px">
                    <span style="font-size:20px">${esc(a.icon || '⚡')}</span>
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;font-size:14px">${esc(a.name)}</div>
                        <div style="font-size:11px;color:var(--text-muted)">${esc(a.description || '')} ${a.workflow ? `→ ${esc(a.workflow)}` : ''}</div>
                    </div>
                    <div class="btn-group">
                        <button class="btn btn-ghost btn-sm" onclick="closeModal();openIssueActionEditor('${esc(a.id)}')">Edit</button>
                        <button class="btn btn-danger-outline btn-sm" onclick="deleteIssueAction('${esc(a.id)}')">Delete</button>
                    </div>
                </div>
            `).join('') : '<div style="font-size:13px;color:var(--text-muted);padding:12px 0">No actions configured. Add one below.</div>'}
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">Add New Action</h3>
        ` : ''}

        <div class="panel" style="margin-bottom:0">
            <div class="panel-body">
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input type="text" class="form-input" id="ia-name" value="${esc(editing?.name ?? '')}" placeholder="Fix Issue">
                </div>
                <div class="form-group">
                    <label class="form-label">Description</label>
                    <input type="text" class="form-input" id="ia-desc" value="${esc(editing?.description ?? '')}" placeholder="Use Claude Code to fix this bug">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Icon (emoji)</label>
                        <input type="text" class="form-input" id="ia-icon" value="${esc(editing?.icon ?? '🔧')}" placeholder="🔧" style="width:80px">
                    </div>
                    <div class="form-group" style="flex:1">
                        <label class="form-label">Workflow</label>
                        <select class="form-select" id="ia-workflow">
                            <option value="">— Select a workflow —</option>
                            ${availWf.map(w => `<option value="${esc(w.name)}" ${editing?.workflow === w.name ? 'selected' : ''}>${esc(w.name)}${w.template ? ` (${esc(w.template)})` : ''}</option>`).join('')}
                        </select>
                        <div class="form-hint">The workflow to run when this action is triggered on an issue</div>
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveIssueAction('${esc(editId ?? '')}')">${editing ? 'Update' : 'Add'} Action</button>
    `);
};

window.saveIssueAction = async function (editId) {
    const name = document.getElementById('ia-name')?.value?.trim();
    const desc = document.getElementById('ia-desc')?.value?.trim();
    const icon = document.getElementById('ia-icon')?.value?.trim() || '⚡';
    const workflow = document.getElementById('ia-workflow')?.value;

    if (!name) { toast('Name is required', 'error'); return; }
    if (!workflow) { toast('Select a workflow', 'error'); return; }

    const id = editId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const data = { id, name, description: desc, icon, workflow };

    try {
        if (editId) {
            await api.put(`/api/issue-actions/${encodeURIComponent(editId)}`, data);
            toast(`Action "${name}" updated`);
        } else {
            await api.post('/api/issue-actions', data);
            toast(`Action "${name}" created`);
        }
        closeModal();
        navigate('issues');
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.deleteIssueAction = async function (id) {
    const ok = await confirm(`Delete issue action "${id}"?`);
    if (!ok) return;
    try {
        await api.del(`/api/issue-actions/${encodeURIComponent(id)}`);
        toast('Action deleted');
        closeModal();
        navigate('issues');
    } catch (err) {
        toast('Failed: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// WORKFLOWS
// ═════════════════════════════════════════════════════════════════════════════
async function renderWorkflows(el) {
    const [wfData, tmplData, actData, runsData] = await Promise.all([api.get('/api/workflows'), api.get('/api/templates'), api.get('/api/actions'), api.get('/api/runs')]);
    workflows = wfData.workflows || [];
    templates = tmplData.templates || [];
    availableActions = actData.actions || [];
    const allRuns = runsData.runs || [];

    const runsByWorkflow = new Map();
    for (const r of allRuns) {
        const name = r.workflowName || r.workflow?.name;
        if (!name) continue;
        if (!runsByWorkflow.has(name)) runsByWorkflow.set(name, []);
        runsByWorkflow.get(name).push(r);
    }

    function runBadge(run) {
        const map = { completed: '#22c55e', failed: '#ef4444', running: '#3b82f6', queued: '#f59e0b' };
        const c = map[run.status] || '#6b7280';
        const dur = run.completedAt && run.startedAt ? ` — ${Math.round((new Date(run.completedAt) - new Date(run.startedAt)) / 1000)}s` : '';
        return `<span style="font-size:11px;color:${c}">${run.status}${dur}</span>`;
    }

    function renderHistory(wfName) {
        const runs = runsByWorkflow.get(wfName);
        if (!runs?.length) return '<span style="font-size:11px;color:var(--text-muted)">No runs</span>';
        const recent = runs.slice(-3).reverse();
        return recent.map(r => `<div style="font-size:11px;line-height:1.6">${runBadge(r)} <span style="color:var(--text-muted)">${timeAgo(r.enqueuedAt || r.startedAt)}</span>${r.error ? ` <span title="${esc(r.error)}" style="color:#ef4444;cursor:help">!</span>` : ''}</div>`).join('');
    }

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Workflows</h1>
                <p class="page-subtitle">${workflows.length} workflow${workflows.length !== 1 ? 's' : ''} configured</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost" onclick="navigate('library')">📚 Browse Library</button>
                <button class="btn btn-primary" onclick="openWorkflowEditor()">+ New Workflow</button>
            </div>
        </div>
        ${workflows.length > 0 ? `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Source</th><th>Trigger</th><th>Type</th><th>Steps</th><th>Last Runs</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>${workflows.map((wf) => {
                const hasInputs = wf.inputs?.length > 0;
                const sources = Array.isArray(wf.trigger?.source) ? wf.trigger.source : [wf.trigger?.source || 'github'];
                return `<tr>
                <td><strong style="cursor:pointer;color:var(--accent-hover)" onclick="openWorkflowEditor('${esc(wf.name)}')">${esc(wf.name)}</strong>${hasInputs ? '<br><span style="font-size:10px;color:var(--text-muted)">🎮 has inputs — run from dashboard</span>' : ''}</td>
                <td>${sourceBadge(sources[0])}${sources.length > 1 ? `<span style="font-size:10px;color:var(--text-muted)"> +${sources.length - 1}</span>` : ''}</td>
                <td><code style="font-size:12px;color:var(--text-secondary)">${esc((() => { const evts = Array.isArray(wf.trigger?.event) ? wf.trigger.event : [wf.trigger?.event].filter(Boolean); return evts.map(e => eventLabelMap[e] || e).join(', '); })())}</code>${wf.trigger?.repo ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(Array.isArray(wf.trigger.repo) ? wf.trigger.repo.join(', ') : wf.trigger.repo)}</span>` : ''}</td>
                <td>${wf.template ? `<span class="badge badge-action">${esc(wf.template)}</span>` : '<span style="font-size:12px;color:var(--text-muted)">custom</span>'}${wf.enabled === false ? ' <span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);font-size:10px">disabled</span>' : ''}</td>
                <td>${wf.graph?.nodes?.length ?? wf.steps?.length ?? (wf.template ? '<span style="color:var(--text-muted);font-size:11px">(from template)</span>' : '—')}</td>
                <td>${renderHistory(wf.name)}</td>
                <td style="text-align:right">
                    <div class="btn-group" style="justify-content:flex-end">
                        <button class="btn ${hasInputs ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="openRunModal('${esc(wf.name)}')" title="Run workflow manually">${hasInputs ? '▶ Run' : '▶'}</button>
                        <button class="btn btn-ghost btn-sm" onclick="openWorkflowEditor('${esc(wf.name)}')">Edit</button>
                        <button class="btn btn-ghost btn-sm" onclick="duplicateWorkflow('${esc(wf.name)}')">Duplicate</button>
                        <button class="btn btn-danger-outline btn-sm" onclick="deleteWorkflow('${esc(wf.name)}')">Delete</button>
                    </div>
                </td>
            </tr>`}).join('')}</tbody>
        </table></div>` : `<div class="empty-state"><div class="empty-icon">⚡</div><p class="empty-text">No workflows yet</p><button class="btn btn-primary" onclick="openWorkflowEditor()">Create Your First Workflow</button></div>`}
    `;
}

// ─── Workflow Editor ────────────────────────────────────────────────────────
//
// The visual node-graph editor (dashboard/graph-editor.js) is now the
// primary surface. The legacy YAML/form editor is still reachable via
// `openLegacyWorkflowEditor()` so power users can fall back to text-based
// authoring when they need it.
window.openWorkflowEditor = function (existingName) {
    if (typeof window.openGraphEditor === 'function') {
        // Switch the router to a synthetic page so navigation back works.
        currentPage = 'workflow-editor';
        return window.openGraphEditor(existingName);
    }
    return window.openLegacyWorkflowEditor(existingName);
};

window.openLegacyWorkflowEditor = function (existingName) {
    const isEdit = !!existingName;
    const wf = isEdit ? workflows.find((w) => w.name === existingName) : null;

    if (!isEdit && !wf) {
        return openQuickStart();
    }

    return openFullEditor(existingName, wf);
};

// ─── Quick Start Chooser ────────────────────────────────────────────────────
function openQuickStart() {
    openModal('Create Workflow', `
        <div style="margin-bottom:20px">
            <h3 style="font-size:18px;font-weight:600;margin-bottom:4px">How do you want to trigger this workflow?</h3>
            <p style="font-size:13px;color:var(--text-secondary)">Choose a starting point — you can always customize it later.</p>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('manual-pr')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">🔀</span>
                    <strong style="font-size:15px">Manual PR Review</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Pick a PR from a dropdown and run an AI review on demand. Perfect for reviewing specific PRs whenever you want.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('manual')}
                    <span class="badge badge-action" style="font-size:10px">ai-pr-review</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('auto-pr')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">⚡</span>
                    <strong style="font-size:15px">Auto PR Review</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Automatically review every new PR with AI when it's opened. Runs without any manual intervention.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('github')}
                    <span class="badge badge-action" style="font-size:10px">ai-pr-review</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('manual-issue')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">🐛</span>
                    <strong style="font-size:15px">Manual Issue Triage</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Select an issue and run custom analysis or triage steps on it. Great for prioritizing bugs.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    ${sourceBadge('manual')}
                    <span style="font-size:10px;color:var(--text-muted)">custom steps</span>
                </div>
            </div>

            <div class="card card-clickable" style="cursor:pointer;padding:16px" onclick="closeModal();quickStartPreset('blank')">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <span style="font-size:24px">📝</span>
                    <strong style="font-size:15px">Blank Workflow</strong>
                </div>
                <p style="font-size:12px;color:var(--text-secondary);line-height:1.5">Start from scratch with full control over triggers, inputs, and steps.</p>
                <div style="margin-top:10px;display:flex;gap:6px">
                    <span style="font-size:10px;color:var(--text-muted)">fully customizable</span>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    `);
}

window.quickStartPreset = function (preset) {
    const presets = {
        'manual-pr': {
            name: 'manual-pr-review',
            description: 'On-demand AI review for any pull request',
            template: 'ai-pr-review',
            trigger: { source: ['manual'], event: [] },
            inputs: [
                { name: 'pr', label: 'Pull Request', type: 'github-pr', required: true }
            ],
        },
        'auto-pr': {
            name: 'auto-pr-review',
            description: 'Automatically review every new PR',
            template: 'ai-pr-review',
            trigger: { source: ['github'], event: ['pull_request.opened'] },
            inputs: [],
        },
        'manual-issue': {
            name: 'manual-issue-triage',
            description: 'On-demand issue analysis and triage',
            trigger: { source: ['manual'], event: [] },
            inputs: [
                { name: 'issue', label: 'Issue', type: 'github-issue', required: true }
            ],
            steps: [
                { action: 'log', params: { message: 'Triaging issue #{{event.payload.inputs.issue.number}}: {{event.payload.inputs.issue.title}}' } }
            ],
        },
        'blank': {
            name: 'my-workflow',
            trigger: { source: ['github'], event: [] },
            inputs: [],
        },
    };

    const p = presets[preset];
    if (!p) return;

    // Build a fake workflow object for the editor
    const fakeWf = {
        name: p.name,
        description: p.description || '',
        template: p.template || '',
        trigger: {
            source: p.trigger.source,
            event: p.trigger.event,
            repo: [],
        },
        steps: p.steps || [],
        inputs: p.inputs || [],
    };

    openFullEditor(null, fakeWf);
};

function openFullEditor(existingName, wf) {
    const isEdit = !!existingName;

    // Use the global ensureArray helper

    const data = {
        name: wf?.name ?? '',
        description: wf?.description ?? '',
        enabled: wf?.enabled !== false,
        template: wf?.template ?? '',
        trigger: {
            source: ensureArray(wf?.trigger?.source ?? 'github'),
            event: ensureArray(wf?.trigger?.event ?? ''),
            repo: ensureArray(wf?.trigger?.repo ?? ''),
            branch: ensureArray(wf?.trigger?.branch ?? ''),
            author: ensureArray(wf?.trigger?.author ?? ''),
            labels: wf?.trigger?.labels ? [...wf.trigger.labels] : [],
            filters: wf?.trigger?.filters ? { ...wf.trigger.filters } : {},
        },
        steps: wf?.steps ? JSON.parse(JSON.stringify(wf.steps)) : [],
        inputs: wf?.inputs ? JSON.parse(JSON.stringify(wf.inputs)) : [],
    };

    const hasInputs = data.inputs.length > 0;

    openModal(isEdit ? `Edit: ${existingName}` : 'Create Workflow', `
        <div class="editor-layout">
            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Basics</span></div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Name</label>
                            <input type="text" class="form-input" id="ed-name" value="${esc(data.name)}" placeholder="my-workflow" ${isEdit ? 'disabled' : ''}>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Description</label>
                            <textarea class="form-textarea" id="ed-description" rows="2" placeholder="What does this workflow do?" style="font-size:13px;resize:vertical">${esc(data.description)}</textarea>
                        </div>
                        <div class="form-row">
                            <div class="form-group" style="margin-bottom:0">
                                <label class="form-label">Template (optional)</label>
                                <select class="form-select" id="ed-template" onchange="onTemplateChange()">
                                    <option value="">Custom steps</option>
                                    ${templates.map((t) => `<option value="${esc(t.name)}" ${data.template === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
                                </select>
                                <div class="form-hint">Select a template to use pre-configured steps</div>
                            </div>
                            <div class="form-group" style="margin-bottom:0">
                                <label class="form-label">Status</label>
                                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0">
                                    <input type="checkbox" id="ed-enabled" ${data.enabled ? 'checked' : ''} onchange="updateYamlPreview()">
                                    <span style="font-size:13px;color:var(--text-secondary)">${data.enabled ? 'Enabled \u2014 will process events' : 'Disabled \u2014 paused'}</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Trigger</span></div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Sources <span style="font-size:10px;color:var(--text-muted);font-weight:400">(select one or more)</span></label>
                            <div id="ed-source-checkboxes" style="display:flex;flex-wrap:wrap;gap:8px">
                                ${['github', 'github-poll', 'gh-cli', 'manual', 'slack', 'webhook', 'cron'].map(s => `
                                    <label class="source-checkbox ${data.trigger.source.includes(s) ? 'checked' : ''}" style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-subtle);cursor:pointer;font-size:12px;transition:all 0.15s">
                                        <input type="checkbox" class="ed-source-cb" value="${s}" ${data.trigger.source.includes(s) ? 'checked' : ''} onchange="onSourceCheckboxChange();updateYamlPreview()" style="display:none">
                                        ${s === 'manual' ? '🎮 manual (run from dashboard)' : s === 'gh-cli' ? '⚡ gh-cli (zero-config)' : s}
                                    </label>
                                `).join('')}
                            </div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:6px">\u{1F4A1} Tip: Select <strong>manual</strong> to run this workflow on-demand from the dashboard. You can combine it with other sources.</div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Events <span style="font-size:10px;color:var(--text-muted);font-weight:400">(match any of these events)</span></label>
                            <div id="ed-event-combobox" class="combobox-container">
                                <div class="combobox-selected" id="ed-event-selected">
                                    ${data.trigger.event.filter(e => e).map(e => `<span class="tag-pill">${esc(eventLabelMap[e] || e)} <button onclick="removeEventFromCombobox('${esc(e)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="combobox-search" id="ed-event-search" placeholder="Search events\u2026" oninput="filterEventDropdown()" onfocus="showEventDropdown()" autocomplete="off">
                                </div>
                                <div class="combobox-dropdown" id="ed-event-dropdown"></div>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Repositories <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all repos)</span></label>
                                <div id="ed-repo-tags" class="tag-input-container">
                                    ${data.trigger.repo.filter(r => r).map(r => `<span class="tag-pill">${esc(r)} <button onclick="removeTagItem('repo','${esc(r)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="tag-input" id="ed-repo-input" placeholder="org/repo" onkeydown="handleTagKeydown(event,'repo')">
                                </div>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Branches <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all branches)</span></label>
                                <div id="ed-branch-tags" class="tag-input-container">
                                    ${data.trigger.branch.filter(b => b).map(b => `<span class="tag-pill">${esc(b)} <button onclick="removeTagItem('branch','${esc(b)}')">&times;</button></span>`).join('')}
                                    <input type="text" class="tag-input" id="ed-branch-input" placeholder="main" onkeydown="handleTagKeydown(event,'branch')">
                                </div>
                            </div>
                        </div>
                        <div class="form-group" style="margin-bottom:0" id="ed-author-group">
                            <label class="form-label">Authors <span style="font-size:10px;color:var(--text-muted);font-weight:400">(leave empty for all authors)</span></label>
                            <div id="ed-author-tags" class="tag-input-container">
                                ${data.trigger.author.filter(a => a).map(a => `<span class="tag-pill">${esc(a)} <button onclick="removeTagItem('author','${esc(a)}')">&times;</button></span>`).join('')}
                                <input type="text" class="tag-input" id="ed-author-input" placeholder="username" onkeydown="handleTagKeydown(event,'author')">
                            </div>
                        </div>
                        <div class="form-group" style="margin-top:12px" id="ed-labels-group">
                            <label class="form-label">Labels <span style="font-size:10px;color:var(--text-muted);font-weight:400">(match PRs/issues with any of these labels)</span></label>
                            <div id="ed-labels-tags" class="tag-input-container">
                                ${data.trigger.labels.map(l => `<span class="tag-pill">${esc(l)} <button onclick="removeLabel('${esc(l)}')">&times;</button></span>`).join('')}
                                <input type="text" class="tag-input" id="ed-label-input" placeholder="Type label and press Enter" onkeydown="handleLabelKeydown(event)">
                            </div>
                        </div>
                        <div class="form-group" style="margin-top:12px">
                            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="toggleFiltersPanel()">
                                Advanced Filters <span style="font-size:10px;color:var(--text-muted);font-weight:400">(dot-path matching)</span>
                                <span id="filters-toggle" style="font-size:10px;transition:transform 0.2s">${Object.keys(data.trigger.filters).length > 0 ? '\u25bc' : '\u25b6'}</span>
                            </label>
                            <div id="ed-filters-panel" style="display:${Object.keys(data.trigger.filters).length > 0 ? 'block' : 'none'}">
                                <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Match against the full event payload using dot-path keys, e.g. <code>payload.pull_request.base.ref</code> = <code>main</code></div>
                                <div id="ed-filters-list"></div>
                                <button class="btn btn-ghost btn-sm" onclick="addFilter()">+ Add Filter</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="panel" style="margin-bottom:16px" id="inputs-panel">
                    <div class="panel-header">
                        <span class="panel-title">\u{1F3AE} Run Inputs</span>
                        <button class="btn btn-ghost btn-sm" onclick="addInput()">+ Add Input</button>
                    </div>
                    <div class="panel-body" id="inputs-container">
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
                            \u{1F4A1} <strong>Inputs define the form</strong> shown when you click <strong>\u25b6 Run</strong> on this workflow.
                            Use <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">github-pr</code> type to show a live PR picker,
                            or <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">github-issue</code> for issues.
                            Access values in steps via <code style="background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">{{event.payload.inputs.&lt;name&gt;}}</code>
                        </div>
                        <div id="inputs-list"></div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header"><span class="panel-title">YAML Preview</span></div>
                    <div class="panel-body" style="padding:0">
                        <pre class="yaml-preview" id="yaml-preview"></pre>
                    </div>
                </div>
            </div>

            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header">
                        <span class="panel-title">Steps</span>
                        <button class="btn btn-ghost btn-sm" onclick="addStep()" id="add-step-btn">+ Add Step</button>
                    </div>
                    <div class="panel-body" id="steps-container" style="min-height:200px">
                        <div id="steps-list"></div>
                        <div id="template-steps-msg" style="display:none"></div>
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveWorkflowFromEditor('${esc(existingName ?? '')}')">${isEdit ? 'Update' : 'Create'} Workflow</button>
    `);

    window._editorSteps = data.steps;
    window._editorInputs = data.inputs;
    window._editorLabels = data.trigger.labels;
    window._editorFilters = data.trigger.filters;
    window._editorEvents = data.trigger.event;
    window._editorRepos = data.trigger.repo;
    window._editorBranches = data.trigger.branch;
    window._editorAuthors = data.trigger.author;
    renderSteps();
    renderInputsList();
    renderFiltersList();
    onTemplateChange();
    onSourceChange();
    updateYamlPreview();
};

// ─── Source change handler ──────────────────────────────────────────────────
// ─── Source checkbox handler ────────────────────────────────────────────────
window.onSourceCheckboxChange = function () {
    $$('.source-checkbox').forEach(label => {
        const cb = label.querySelector('input');
        label.classList.toggle('checked', cb.checked);
    });
    onSourceChange();
};

window.onSourceChange = function () {
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);
    const labelsGroup = $('#ed-labels-group');

    // Show/hide GitHub-specific fields
    const isGithub = sources.some(s => s === 'github' || s === 'github-poll' || s === 'gh-cli');
    if (labelsGroup) labelsGroup.style.display = isGithub ? '' : 'none';
};

// ─── Generic tag field handlers (event, repo, branch, author) ───────────────
// State stored on window as _editorEvents, _editorRepos, _editorBranches, _editorAuthors
const tagFields = {
    event: { stateKey: '_editorEvents', containerId: 'ed-event-tags', inputId: 'ed-event-input' },
    repo: { stateKey: '_editorRepos', containerId: 'ed-repo-tags', inputId: 'ed-repo-input' },
    branch: { stateKey: '_editorBranches', containerId: 'ed-branch-tags', inputId: 'ed-branch-input' },
    author: { stateKey: '_editorAuthors', containerId: 'ed-author-tags', inputId: 'ed-author-input' },
};

window.handleTagKeydown = function (e, field) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const input = e.target;
        const value = input.value.trim().replace(/,/g, '');
        const cfg = tagFields[field];
        if (!cfg) return;
        if (value && !window[cfg.stateKey].includes(value)) {
            window[cfg.stateKey].push(value);
            renderTagField(field);
            updateYamlPreview();
        }
        input.value = '';
    }
};

window.removeTagItem = function (field, value) {
    const cfg = tagFields[field];
    if (!cfg) return;
    window[cfg.stateKey] = window[cfg.stateKey].filter(v => v !== value);
    renderTagField(field);
    updateYamlPreview();
};

function renderTagField(field) {
    const cfg = tagFields[field];
    if (!cfg) return;
    const container = $(`#${cfg.containerId}`);
    if (!container) return;
    const items = window[cfg.stateKey] || [];
    container.innerHTML = items.map(v =>
        `<span class="tag-pill">${esc(v)} <button onclick="removeTagItem('${field}','${esc(v)}')">&times;</button></span>`
    ).join('') + `<input type="text" class="tag-input" id="${cfg.inputId}" placeholder="${field === 'event' ? 'pull_request.opened' : field === 'repo' ? 'org/repo' : field === 'branch' ? 'main' : 'username'}" onkeydown="handleTagKeydown(event,'${field}')">`;
}

// ─── Event Combobox ─────────────────────────────────────────────────────────
window.showEventDropdown = function () {
    const dropdown = $('#ed-event-dropdown');
    if (!dropdown) return;
    filterEventDropdown();
    dropdown.classList.add('open');
};

window.filterEventDropdown = function () {
    const dropdown = $('#ed-event-dropdown');
    const search = $('#ed-event-search');
    if (!dropdown || !search) return;

    const query = search.value.toLowerCase().trim();
    const selected = window._editorEvents || [];
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);

    // Collect available events from selected sources (deduped)
    const seen = new Set();
    let html = '';

    for (const source of sources) {
        const events = eventCatalog[source] || [];
        const filtered = events.filter(evt => {
            if (seen.has(evt.value)) return false;
            if (selected.includes(evt.value)) return false;
            if (query && !evt.label.toLowerCase().includes(query) && !evt.value.toLowerCase().includes(query) && !evt.desc.toLowerCase().includes(query)) return false;
            seen.add(evt.value);
            return true;
        });

        if (filtered.length === 0) continue;

        html += `<div class="combobox-group-label">${esc(source)}</div>`;
        for (const evt of filtered) {
            html += `<div class="combobox-option" onclick="selectEventFromCombobox('${esc(evt.value)}')">
                <span class="combobox-option-label">${esc(evt.label)}</span>
                <span class="combobox-option-desc">${esc(evt.desc)}</span>
                <code class="combobox-option-code">${esc(evt.value)}</code>
            </div>`;
        }
    }

    if (!html) {
        html = `<div class="combobox-empty">${selected.length > 0 && !query ? 'All events selected' : 'No events match your search'}</div>`;
    }

    dropdown.innerHTML = html;
    dropdown.classList.add('open');
};

window.selectEventFromCombobox = function (value) {
    if (!window._editorEvents.includes(value)) {
        window._editorEvents.push(value);
        renderEventPills();
        updateYamlPreview();
    }
    const search = $('#ed-event-search');
    if (search) search.value = '';
    filterEventDropdown(); // Re-render dropdown to hide selected
};

window.removeEventFromCombobox = function (value) {
    window._editorEvents = window._editorEvents.filter(v => v !== value);
    renderEventPills();
    filterEventDropdown();
    updateYamlPreview();
};

function renderEventPills() {
    const container = $('#ed-event-selected');
    if (!container) return;
    const events = window._editorEvents || [];
    container.innerHTML = events.map(e =>
        `<span class="tag-pill">${esc(eventLabelMap[e] || e)} <button onclick="removeEventFromCombobox('${esc(e)}')">&times;</button></span>`
    ).join('') + `<input type="text" class="combobox-search" id="ed-event-search" placeholder="Search events\u2026" oninput="filterEventDropdown()" onfocus="showEventDropdown()" autocomplete="off">`;
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const combo = document.getElementById('ed-event-combobox');
    if (combo && !combo.contains(e.target)) {
        const dropdown = document.getElementById('ed-event-dropdown');
        if (dropdown) dropdown.classList.remove('open');
    }
});

// ─── Labels management ──────────────────────────────────────────────────────
window.handleLabelKeydown = function (e) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const input = e.target;
        const label = input.value.trim().replace(/,/g, '');
        if (label && !window._editorLabels.includes(label)) {
            window._editorLabels.push(label);
            renderLabels();
            updateYamlPreview();
        }
        input.value = '';
    }
};

window.removeLabel = function (label) {
    window._editorLabels = window._editorLabels.filter(l => l !== label);
    renderLabels();
    updateYamlPreview();
};

function renderLabels() {
    const container = $('#ed-labels-tags');
    if (!container) return;
    const labels = window._editorLabels || [];
    const input = '<input type="text" class="tag-input" id="ed-label-input" placeholder="Type label and press Enter" onkeydown="handleLabelKeydown(event)">';
    container.innerHTML = labels.map(l => `<span class="tag-pill">${esc(l)} <button onclick="removeLabel('${esc(l)}')">&times;</button></span>`).join('') + input;
}

// ─── Filters management ─────────────────────────────────────────────────────
window.toggleFiltersPanel = function () {
    const panel = $('#ed-filters-panel');
    const toggle = $('#filters-toggle');
    if (panel) {
        const show = panel.style.display === 'none';
        panel.style.display = show ? 'block' : 'none';
        if (toggle) toggle.textContent = show ? '\u25bc' : '\u25b6';
    }
};

window.addFilter = function () {
    if (!window._editorFilters) window._editorFilters = {};
    const key = `filter_${Object.keys(window._editorFilters).length}`;
    window._editorFilters[key] = '';
    renderFiltersList();
    updateYamlPreview();
};

window.removeFilter = function (key) {
    delete window._editorFilters[key];
    renderFiltersList();
    updateYamlPreview();
};

window.updateFilterKey = function (oldKey, newKey) {
    if (oldKey === newKey) return;
    const val = window._editorFilters[oldKey];
    delete window._editorFilters[oldKey];
    window._editorFilters[newKey] = val;
    updateYamlPreview();
};

window.updateFilterVal = function (key, val) {
    window._editorFilters[key] = val;
    updateYamlPreview();
};

function renderFiltersList() {
    const container = $('#ed-filters-list');
    if (!container) return;
    const filters = window._editorFilters || {};
    const entries = Object.entries(filters);
    if (entries.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic">No filters. Click + Add Filter for dot-path matching.</div>';
        return;
    }
    container.innerHTML = entries.map(([k, v]) => `
        <div class="form-kv" style="margin-bottom:6px">
            <input type="text" class="form-input" value="${esc(k)}" placeholder="payload.path.to.field" style="flex:1" onchange="updateFilterKey('${esc(k)}',this.value)">
            <input type="text" class="form-input" value="${esc(v)}" placeholder="expected value" style="flex:1" oninput="updateFilterVal('${esc(k)}',this.value);updateYamlPreview()">
            <button class="btn btn-danger-outline btn-sm btn-icon" onclick="removeFilter('${esc(k)}')" title="Remove" style="align-self:center">&times;</button>
        </div>
    `).join('');
}

// ─── Input field management for manual workflows ────────────────────────────
window.addInput = function () {
    if (!window._editorInputs) window._editorInputs = [];
    window._editorInputs.push({ name: '', label: '', type: 'text', required: false });
    renderInputsList();
    updateYamlPreview();
};

window.removeInput = function (idx) {
    window._editorInputs.splice(idx, 1);
    renderInputsList();
    updateYamlPreview();
};

function renderInputsList() {
    const container = $('#inputs-list');
    if (!container) return;
    const inputs = window._editorInputs || [];
    if (inputs.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic">No inputs defined. Click "+ Add Input" to add fields to the run form.</div>';
        return;
    }
    container.innerHTML = inputs.map((inp, i) => `
        <div class="step-card" style="margin-bottom:8px">
            <div class="step-card-header" style="padding:8px 10px">
                <div class="step-num" style="width:20px;height:20px;font-size:10px">${i + 1}</div>
                <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <input type="text" class="form-input" style="flex:1;min-width:100px;padding:4px 8px;font-size:12px" 
                        value="${esc(inp.name)}" placeholder="field_name" 
                        oninput="window._editorInputs[${i}].name=this.value;updateYamlPreview()">
                    <input type="text" class="form-input" style="flex:1;min-width:100px;padding:4px 8px;font-size:12px" 
                        value="${esc(inp.label)}" placeholder="Field Label" 
                        oninput="window._editorInputs[${i}].label=this.value;updateYamlPreview()">
                    <select class="form-select" style="width:130px;padding:4px 6px;font-size:12px" 
                        onchange="window._editorInputs[${i}].type=this.value;updateYamlPreview()">
                        ${['text', 'textarea', 'select', 'number', 'boolean', 'github-pr', 'github-issue', 'github-branch', 'github-repo'].map(t => `<option value="${t}" ${inp.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);cursor:pointer">
                        <input type="checkbox" ${inp.required ? 'checked' : ''} 
                            onchange="window._editorInputs[${i}].required=this.checked;updateYamlPreview()">
                        Required
                    </label>
                </div>
                <button class="btn btn-danger-outline btn-sm" style="padding:2px 8px;font-size:11px" onclick="removeInput(${i})">×</button>
            </div>
        </div>
    `).join('');
}

// ─── YAML Preview ───────────────────────────────────────────────────────────
window.updateYamlPreview = function () {
    const pre = $('#yaml-preview');
    if (!pre) return;
    const wf = buildWorkflowFromEditor();
    if (!wf) return;

    // Helper: render a OneOrMany value in YAML
    function yamlOneOrMany(key, val, indent = '  ') {
        if (!val) return '';
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) return '';
        if (arr.length === 1) return `${indent}${key}: ${arr[0]}\n`;
        return `${indent}${key}:\n${arr.map(v => `${indent}  - ${v}\n`).join('')}`;
    }

    let yaml = `name: ${wf.name || '(unnamed)'}\n`;
    if (wf.description) yaml += `description: "${wf.description}"\n`;
    if (wf.enabled === false) yaml += `enabled: false\n`;
    if (wf.template) yaml += `template: ${wf.template}\n`;
    yaml += `trigger:\n`;
    yaml += yamlOneOrMany('source', wf.trigger?.source);
    yaml += yamlOneOrMany('event', wf.trigger?.event);
    yaml += yamlOneOrMany('repo', wf.trigger?.repo);
    yaml += yamlOneOrMany('branch', wf.trigger?.branch);
    yaml += yamlOneOrMany('author', wf.trigger?.author);
    if (wf.trigger?.labels?.length) {
        yaml += `  labels:\n`;
        for (const l of wf.trigger.labels) yaml += `    - ${l}\n`;
    }
    if (wf.trigger?.filters && Object.keys(wf.trigger.filters).length > 0) {
        yaml += `  filters:\n`;
        for (const [k, v] of Object.entries(wf.trigger.filters)) {
            yaml += `    ${k}: "${v}"\n`;
        }
    }
    if (wf.inputs?.length) {
        yaml += `inputs:\n`;
        for (const inp of wf.inputs) {
            yaml += `  - name: ${inp.name || '(unnamed)'}\n`;
            if (inp.label) yaml += `    label: "${inp.label}"\n`;
            yaml += `    type: ${inp.type || 'text'}\n`;
            if (inp.required) yaml += `    required: true\n`;
        }
    }
    if (wf.steps?.length) {
        yaml += `steps:\n`;
        for (const s of wf.steps) {
            yaml += `  - action: ${s.action}\n`;
            if (s.id) yaml += `    id: ${s.id}\n`;
            if (s.condition) yaml += `    condition: "${s.condition}"\n`;
            if (s.on_error === 'continue') yaml += `    on_error: continue\n`;
            if (s.params && Object.keys(s.params).length > 0) {
                yaml += `    params:\n`;
                for (const [k, v] of Object.entries(s.params)) {
                    const val = String(v);
                    if (val.includes('\n')) {
                        yaml += `      ${k}: |\n${val.split('\n').map(l => `        ${l}`).join('\n')}\n`;
                    } else {
                        yaml += `      ${k}: ${val}\n`;
                    }
                }
            }
        }
    }
    pre.textContent = yaml;
};

function buildWorkflowFromEditor() {
    const nameEl = $('#ed-name');
    if (!nameEl) return null;
    const name = nameEl.value.trim();
    const description = $('#ed-description')?.value?.trim() || '';
    const enabled = $('#ed-enabled')?.checked !== false;
    const template = $('#ed-template')?.value || '';

    // Sources from checkboxes
    const sources = [...document.querySelectorAll('.ed-source-cb:checked')].map(cb => cb.value);

    // Events, repos, branches, authors from tag state
    const events = window._editorEvents || [];
    const repos = window._editorRepos || [];
    const branches = window._editorBranches || [];
    const authors = window._editorAuthors || [];

    const workflow = { name };
    if (description) workflow.description = description;
    if (!enabled) workflow.enabled = false;
    if (template) workflow.template = template;

    const trigger = {};
    // Emit single string when only one value, array when multiple
    trigger.source = sources.length === 1 ? sources[0] : sources;
    if (events.length > 0) trigger.event = events.length === 1 ? events[0] : events;
    if (repos.length > 0) trigger.repo = repos.length === 1 ? repos[0] : repos;
    if (branches.length > 0) trigger.branch = branches.length === 1 ? branches[0] : branches;
    if (authors.length > 0) trigger.author = authors.length === 1 ? authors[0] : authors;

    if (window._editorLabels?.length > 0) trigger.labels = [...window._editorLabels];
    const filters = window._editorFilters || {};
    const cleanFilters = {};
    for (const [k, v] of Object.entries(filters)) {
        if (k && !k.startsWith('filter_')) cleanFilters[k] = v;
        else if (v) cleanFilters[k] = v;
    }
    if (Object.keys(cleanFilters).length > 0) trigger.filters = cleanFilters;
    workflow.trigger = trigger;

    if (!template && window._editorSteps?.length > 0) {
        workflow.steps = window._editorSteps.filter((s) => s.action).map((s) => {
            const step = { action: s.action };
            if (s.id) step.id = s.id;
            if (s.condition) step.condition = s.condition;
            if (s.on_error === 'continue') step.on_error = 'continue';
            if (s.params && Object.keys(s.params).length > 0) step.params = { ...s.params };
            return step;
        });
    }

    // Include inputs for manual workflows
    if (window._editorInputs?.length > 0) {
        workflow.inputs = window._editorInputs.filter(inp => inp.name).map(inp => {
            const input = { name: inp.name, label: inp.label || inp.name, type: inp.type || 'text' };
            if (inp.required) input.required = true;
            if (inp.default) input.default = inp.default;
            if (inp.options) input.options = inp.options;
            if (inp.placeholder) input.placeholder = inp.placeholder;
            return input;
        });
    }

    return workflow;
}

window.onTemplateChange = function () {
    const tmpl = $('#ed-template').value;
    const stepsContainer = $('#steps-list');
    const tmplMsg = $('#template-steps-msg');
    const addBtn = $('#add-step-btn');
    if (tmpl) {
        stepsContainer.style.display = 'none';
        tmplMsg.style.display = 'block';
        if (addBtn) addBtn.style.display = 'none';
        const t = templates.find(t => t.name === tmpl);
        if (t?.steps) {
            tmplMsg.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Template provides ${t.steps.length} step${t.steps.length !== 1 ? 's' : ''}:</p>` +
                t.steps.map((s, i) => `<div class="step-card" style="margin-bottom:6px"><div class="step-card-header"><div class="step-num">${i + 1}</div><span class="step-action-name">${esc(s.action)}</span>${s.condition ? '<span class="badge badge-warning" style="font-size:10px">conditional</span>' : ''}</div></div>`).join('');
        }
    } else {
        stepsContainer.style.display = 'block';
        tmplMsg.style.display = 'none';
        if (addBtn) addBtn.style.display = '';
    }
    updateYamlPreview();
};

function renderSteps() {
    const list = $('#steps-list');
    if (!list) return;
    const steps = window._editorSteps;
    if (steps.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-icon">📦</div><p class="empty-text">No steps yet — add one above</p></div>';
        return;
    }
    list.innerHTML = steps.map((s, i) => `
        <div class="step-card" id="step-${i}">
            <div class="step-card-header" onclick="toggleStep(${i})">
                <div class="step-num">${i + 1}</div>
                <span class="step-action-name">${esc(s.action || '(choose action)')}</span>
                ${s.id ? `<span class="badge badge-action" style="font-size:10px">#${esc(s.id)}</span>` : ''}
                ${s.condition ? '<span class="badge badge-warning" style="font-size:10px">conditional</span>' : ''}
                <span class="step-toggle ${i === 0 ? 'open' : ''}" id="toggle-${i}">▶</span>
            </div>
            <div class="step-card-body ${i === 0 ? 'open' : ''}" id="body-${i}">
                <div class="form-row" style="margin-bottom:12px">
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">Action</label>
                        <select class="form-select" onchange="updateStep(${i},'action',this.value)">
                            <option value="">Select action...</option>
                            ${availableActions.map((a) => `<option value="${esc(a)}" ${s.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">Step ID (optional)</label>
                        <input type="text" class="form-input" value="${esc(s.id || '')}" placeholder="e.g. fetch_diff" onchange="updateStep(${i},'id',this.value)">
                    </div>
                </div>
                ${s.action && actionDocs[s.action] ? `
                <div class="action-docs" style="margin-bottom:12px;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px;border:1px solid var(--border-subtle)">
                    <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px">\u{1F4D6} ${esc(actionDocs[s.action].desc)}</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:11px">
                        ${actionDocs[s.action].params.map(p => `
                            <div style="color:var(--text-secondary);font-family:var(--font-mono)">${esc(p.name)}${p.required ? '<span style="color:var(--danger)">*</span>' : ''}</div>
                            <div style="color:var(--text-muted)">${esc(p.desc)}${p.default ? ` <span style="color:var(--text-secondary)">(default: ${esc(p.default)})</span>` : ''}</div>
                        `).join('')}
                    </div>
                </div>` : ''}
                <div class="form-group" style="margin-bottom:12px">
                    <label class="form-label">Condition (optional)</label>
                    <input type="text" class="form-input" value="${esc(s.condition || '')}" placeholder="{{steps.analysis.needs_fix}}" onchange="updateStep(${i},'condition',this.value)">
                </div>
                <div class="form-row" style="margin-bottom:12px">
                    <div class="form-group" style="margin-bottom:0">
                        <label class="form-label">On Error</label>
                        <select class="form-select" onchange="updateStep(${i},'on_error',this.value)">
                            <option value="stop" ${(s.on_error || 'stop') === 'stop' ? 'selected' : ''}>Stop workflow</option>
                            <option value="continue" ${s.on_error === 'continue' ? 'selected' : ''}>Continue to next step</option>
                        </select>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                    <label class="form-label">Parameters</label>
                    <div id="params-${i}">${renderParams(i, s.params || {})}</div>
                    <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addParam(${i})">+ Add Param</button>
                </div>
                <div class="step-card-footer">
                    ${i > 0 ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="moveStep(${i},-1)" title="Move up">↑</button>` : ''}
                    ${i < steps.length - 1 ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="moveStep(${i},1)" title="Move down">↓</button>` : ''}
                    <button class="btn btn-danger-outline btn-sm" onclick="removeStep(${i})">Remove</button>
                </div>
            </div>
        </div>
    `).join('');
    updateYamlPreview();
}

function renderParams(stepIdx, params) {
    const entries = Object.entries(params);
    if (entries.length === 0) return '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No parameters</div>';
    return entries.map(([k, v], pi) => {
        const val = String(v);
        const isMultiline = val.includes('\n') || val.length > 80;
        return `<div class="form-kv">
            <input type="text" class="form-input" value="${esc(k)}" placeholder="key" style="max-width:140px" onchange="updateParamKey(${stepIdx},${pi},this.value)">
            ${isMultiline
                ? `<textarea class="form-textarea" placeholder="value" onchange="updateParamVal(${stepIdx},'${esc(k)}',this.value)" oninput="updateYamlPreview()">${esc(val)}</textarea>`
                : `<input type="text" class="form-input" value="${esc(val)}" placeholder="value" onchange="updateParamVal(${stepIdx},'${esc(k)}',this.value)" oninput="updateYamlPreview()">`}
            <button class="btn btn-danger-outline btn-sm btn-icon" onclick="removeParam(${stepIdx},'${esc(k)}')" title="Remove" style="align-self:center">×</button>
        </div>`;
    }).join('');
}

window.toggleStep = function (i) {
    const body = $(`#body-${i}`);
    const toggle = $(`#toggle-${i}`);
    if (body) body.classList.toggle('open');
    if (toggle) toggle.classList.toggle('open');
};

window.addStep = function () {
    window._editorSteps.push({ action: '', params: {} });
    renderSteps();
};

window.removeStep = function (i) {
    window._editorSteps.splice(i, 1);
    renderSteps();
};

window.moveStep = function (i, dir) {
    const steps = window._editorSteps;
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    renderSteps();
};

window.updateStep = function (i, key, val) {
    if (val) window._editorSteps[i][key] = val;
    else delete window._editorSteps[i][key];
    const nameEl = $(`#step-${i} .step-action-name`);
    if (nameEl && key === 'action') nameEl.textContent = val || '(choose action)';
    updateYamlPreview();
};

window.addParam = function (i) {
    if (!window._editorSteps[i].params) window._editorSteps[i].params = {};
    const key = `param${Object.keys(window._editorSteps[i].params).length + 1}`;
    window._editorSteps[i].params[key] = '';
    $(`#params-${i}`).innerHTML = renderParams(i, window._editorSteps[i].params);
    updateYamlPreview();
};

window.updateParamKey = function (stepIdx, paramIdx, newKey) {
    const params = window._editorSteps[stepIdx].params;
    const entries = Object.entries(params);
    if (paramIdx < entries.length) {
        const [oldKey, val] = entries[paramIdx];
        delete params[oldKey];
        params[newKey] = val;
    }
    updateYamlPreview();
};

window.updateParamVal = function (stepIdx, key, val) {
    window._editorSteps[stepIdx].params[key] = val;
    updateYamlPreview();
};

window.removeParam = function (stepIdx, key) {
    delete window._editorSteps[stepIdx].params[key];
    $(`#params-${stepIdx}`).innerHTML = renderParams(stepIdx, window._editorSteps[stepIdx].params);
    updateYamlPreview();
};

window.saveWorkflowFromEditor = async function (existingName) {
    const workflow = buildWorkflowFromEditor();
    if (!workflow) return;
    if (!workflow.name) return toast('Name is required', 'error');
    if (!workflow.trigger?.event && !workflow.template) return toast('Event is required', 'error');

    try {
        let result;
        if (existingName) {
            result = await api.put(`/api/workflows/${encodeURIComponent(existingName)}`, workflow);
        } else {
            result = await api.post('/api/workflows', workflow);
        }
        if (result.error) return toast(result.error, 'error');
        toast(existingName ? 'Workflow updated' : 'Workflow created');
        closeModal();
        navigate('workflows');
    } catch (err) {
        toast('Failed to save workflow', 'error');
    }
};

window.deleteWorkflow = async function (name) {
    if (!(await confirm(`Delete workflow <strong>"${esc(name)}"</strong>?<br><span style="font-size:12px;color:var(--text-muted)">This removes it from sokuza.config.yaml</span>`))) return;
    try {
        const result = await api.del(`/api/workflows/${encodeURIComponent(name)}`);
        if (result.error) return toast(result.error, 'error');
        toast('Workflow deleted');
        navigate('workflows');
    } catch { toast('Failed to delete', 'error'); }
};

window.duplicateWorkflow = async function (name) {
    const original = workflows.find(w => w.name === name);
    if (!original) return;
    const copy = JSON.parse(JSON.stringify(original));
    copy.name = `${name}-copy`;
    // Keep incrementing if name already taken
    let suffix = 1;
    while (workflows.some(w => w.name === copy.name)) {
        suffix++;
        copy.name = `${name}-copy-${suffix}`;
    }
    try {
        const result = await api.post('/api/workflows', copy);
        if (result.error) return toast(result.error, 'error');
        toast(`Duplicated as "${copy.name}"`);
        navigate('workflows');
    } catch { toast('Failed to duplicate', 'error'); }
};

// ─── Run Workflow Modal ─────────────────────────────────────────────────────

/** Resolve the repo scope for a github-* picker input */
function resolvePickerRepo(inp, wfDetails) {
    if (inp.scope) return inp.scope;
    const repo = wfDetails?.trigger?.repo;
    if (Array.isArray(repo)) return repo[0] || '';
    return repo || '';
}

/** Render a github-* picker field */
function renderPickerField(inp, i, wfDetails) {
    const reqd = inp.required ? '<span style="color:#ef4444">*</span>' : '';
    const repo = resolvePickerRepo(inp, wfDetails);
    const typeLabels = { 'github-pr': '🔀 Pull Request', 'github-issue': '🐛 Issue', 'github-branch': '🌿 Branch', 'github-repo': '📦 Repository' };
    const label = esc(inp.label || inp.name);

    return `<div class="form-group">
        <label class="form-label">${label} ${reqd}
            <span style="font-size:11px;color:var(--text-muted);font-weight:400;margin-left:6px">${typeLabels[inp.type] || ''}</span>
        </label>
        <div id="picker-${i}" class="picker-container" style="position:relative">
            <div class="picker-loading" style="display:flex;align-items:center;gap:8px;padding:10px;color:var(--text-muted);font-size:13px">
                <div class="spinner" style="width:14px;height:14px"></div> Loading...
            </div>
        </div>
    </div>`;
}

/** Fetch data and populate a picker after the modal is open */
/** Show a repo selector first, then load the actual picker after repo choice */
async function initRepoChooserThenPicker(container, inp, i, wfDetails) {
    const typeLabels = { 'github-pr': 'pull requests', 'github-issue': 'issues', 'github-branch': 'branches' };
    const entityLabel = typeLabels[inp.type] || 'items';

    container.innerHTML = `
        <div style="padding:8px 0">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
                ⚠️ No repository configured. Select a repo to browse ${entityLabel}:
            </div>
            <div id="repo-chooser-${i}" style="display:flex;align-items:center;gap:8px">
                <div class="spinner" style="width:14px;height:14px"></div>
                <span style="font-size:12px;color:var(--text-muted)">Loading repos...</span>
            </div>
        </div>`;

    try {
        const data = await api.get('/api/github/repos');
        const repos = data.items || [];
        const chooser = $(`#repo-chooser-${i}`);
        if (!chooser) return;

        if (repos.length === 0) {
            chooser.innerHTML = '<span style="font-size:12px;color:#ef4444">No repos found. Add a <code>repo</code> to the workflow trigger or configure repos in your integrations.</span>';
            return;
        }

        chooser.innerHTML = `
            <select class="form-select" id="repo-select-${i}" style="flex:1;font-size:13px;font-family:var(--mono)">
                <option value="">-- Select a repository --</option>
                ${repos.map(r => `<option value="${esc(r.full_name)}">${esc(r.full_name)}${r.source === 'config' ? ' ★' : ''}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="onRepoChosen(${i})">Load</button>`;
    } catch (err) {
        const chooser = $(`#repo-chooser-${i}`);
        if (chooser) chooser.innerHTML = `<span style="font-size:12px;color:#ef4444">⚠ Could not load repos: ${esc(err.message)}</span>`;
    }

    // Store context for the callback
    if (!window._pickerPendingRepo) window._pickerPendingRepo = {};
    window._pickerPendingRepo[i] = { inp, wfDetails };
}

window.onRepoChosen = function (pickerIdx) {
    const select = $(`#repo-select-${pickerIdx}`);
    if (!select || !select.value) return toast('Select a repository first', 'error');

    const pending = window._pickerPendingRepo?.[pickerIdx];
    if (!pending) return;

    // Override the input's scope with the chosen repo and re-init the actual picker
    const overriddenInp = { ...pending.inp, scope: select.value };
    initPicker(overriddenInp, pickerIdx, pending.wfDetails);
};

async function initPicker(inp, i, wfDetails) {
    const container = $(`#picker-${i}`);
    if (!container) return;
    const repo = resolvePickerRepo(inp, wfDetails);
    const [owner, repoName] = repo ? repo.split('/') : ['', ''];

    // For repo-scoped pickers, if no repo is configured, show a repo chooser first
    const needsRepo = ['github-pr', 'github-issue', 'github-branch'].includes(inp.type);
    if (needsRepo && (!owner || !repoName)) {
        return initRepoChooserThenPicker(container, inp, i, wfDetails);
    }

    try {
        let items = [];
        let renderItem;

        switch (inp.type) {
            case 'github-pr': {
                const data = await api.get(`/api/github/${owner}/${repoName}/pulls`);
                items = data.items || [];
                renderItem = (item) => {
                    const labels = (item.labels || []).map(l => `<span class="badge badge-action" style="font-size:9px;padding:1px 5px">${esc(l)}</span>`).join('');
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-weight:600;color:var(--accent);min-width:42px">#${item.number}</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.title)}</span>
                            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(item.author || '')}</span>
                            ${item.draft ? '<span class="badge badge-warning" style="font-size:9px">draft</span>' : ''}
                            ${labels}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-issue': {
                const data = await api.get(`/api/github/${owner}/${repoName}/issues`);
                items = data.items || [];
                renderItem = (item) => {
                    const labels = (item.labels || []).map(l => `<span class="badge badge-action" style="font-size:9px;padding:1px 5px">${esc(l)}</span>`).join('');
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-weight:600;color:var(--success);min-width:42px">#${item.number}</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.title)}</span>
                            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(item.author || '')}</span>
                            ${labels}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-branch': {
                const data = await api.get(`/api/github/${owner}/${repoName}/branches`);
                items = data.items || [];
                renderItem = (item) => {
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-family:var(--font-mono);font-size:13px;color:var(--accent)">${esc(item.name)}</span>
                            <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${esc(item.sha || '')}</span>
                            ${item.protected ? '<span class="badge badge-warning" style="font-size:9px">protected</span>' : ''}
                        </div>
                    </div>`;
                };
                break;
            }
            case 'github-repo': {
                const data = await api.get('/api/github/repos');
                items = data.items || [];
                renderItem = (item) => {
                    return `<div class="picker-item" data-idx="${items.indexOf(item)}" onclick="selectPickerItem(${i}, ${items.indexOf(item)})">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            <span style="font-family:var(--font-mono);font-size:13px;font-weight:600">${esc(item.full_name)}</span>
                            ${item.source === 'config' ? '<span class="badge badge-success" style="font-size:9px">configured</span>' : ''}
                            ${item.description ? `<span style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.description)}</span>` : ''}
                        </div>
                    </div>`;
                };
                break;
            }
        }

        // Store items for selection
        if (!window._pickerData) window._pickerData = {};
        window._pickerData[i] = { items, repo };

        if (items.length === 0) {
            container.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:13px;font-style:italic">No items found${repo ? ` in ${esc(repo)}` : ''}</div>`;
            return;
        }

        // Search input + scrollable list
        container.innerHTML = `
            <input type="text" class="form-input" id="picker-search-${i}" placeholder="Search..." style="margin-bottom:6px;font-size:13px" oninput="filterPicker(${i}, this.value)">
            <div id="picker-selected-${i}" style="display:none;padding:8px 12px;background:rgba(99,102,241,0.08);border-radius:var(--radius-sm);margin-bottom:6px;cursor:pointer" onclick="clearPickerSelection(${i})"></div>
            <div id="picker-list-${i}" class="picker-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius-sm)">
                ${items.map(renderItem).join('')}
            </div>`;

        // Store renderItem for filtering
        window._pickerData[i].renderItem = renderItem;

    } catch (err) {
        container.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:13px">⚠ Failed to load: ${esc(err.message || 'Unknown error')}</div>`;
    }
}

window.selectPickerItem = function (pickerIdx, itemIdx) {
    const data = window._pickerData?.[pickerIdx];
    if (!data) return;
    const item = data.items[itemIdx];
    if (!item) return;

    // Store selection
    if (!window._pickerSelections) window._pickerSelections = {};
    // Attach repo context to the selection
    const selection = { ...item, repo: data.repo };
    window._pickerSelections[pickerIdx] = selection;

    // Show selected item, hide list
    const selectedEl = $(`#picker-selected-${pickerIdx}`);
    const listEl = $(`#picker-list-${pickerIdx}`);
    const searchEl = $(`#picker-search-${pickerIdx}`);

    if (selectedEl) {
        let display = '';
        if (item.number !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-weight:600;color:var(--accent)">#${item.number}</span>
                <span>${esc(item.title || '')}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        } else if (item.name !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-family:var(--font-mono);font-weight:600;color:var(--accent)">${esc(item.name)}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        } else if (item.full_name !== undefined) {
            display = `<div style="display:flex;align-items:center;gap:8px">
                <span style="font-family:var(--font-mono);font-weight:600">${esc(item.full_name)}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">✕ click to change</span>
            </div>`;
        }
        selectedEl.innerHTML = display;
        selectedEl.style.display = 'block';
    }
    if (listEl) listEl.style.display = 'none';
    if (searchEl) searchEl.style.display = 'none';
};

window.clearPickerSelection = function (pickerIdx) {
    if (window._pickerSelections) delete window._pickerSelections[pickerIdx];
    const selectedEl = $(`#picker-selected-${pickerIdx}`);
    const listEl = $(`#picker-list-${pickerIdx}`);
    const searchEl = $(`#picker-search-${pickerIdx}`);
    if (selectedEl) selectedEl.style.display = 'none';
    if (listEl) listEl.style.display = '';
    if (searchEl) { searchEl.style.display = ''; searchEl.value = ''; }
    filterPicker(pickerIdx, '');
};

window.filterPicker = function (pickerIdx, query) {
    const data = window._pickerData?.[pickerIdx];
    const listEl = $(`#picker-list-${pickerIdx}`);
    if (!data || !listEl) return;
    const q = query.toLowerCase();
    const filtered = q ? data.items.filter(item => {
        const text = JSON.stringify(item).toLowerCase();
        return text.includes(q);
    }) : data.items;
    listEl.innerHTML = filtered.length > 0
        ? filtered.map(data.renderItem).join('')
        : '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center">No matches</div>';
};

window.openRunModal = async function (name) {
    // Reset picker state
    window._pickerData = {};
    window._pickerSelections = {};

    // Fetch workflow details to get input definitions
    let wfDetails;
    try {
        const data = await api.get(`/api/workflows/${encodeURIComponent(name)}/details`);
        wfDetails = data.workflow;
    } catch {
        // Fallback to local data
        wfDetails = workflows.find(w => w.name === name);
    }

    if (!wfDetails) return toast('Workflow not found', 'error');

    const inputs = wfDetails.inputs || [];
    const hasInputs = inputs.length > 0;

    let formHtml = '';
    if (hasInputs) {
        formHtml = inputs.map((inp, i) => {
            // GitHub picker types
            if (inp.type?.startsWith('github-')) {
                return renderPickerField(inp, i, wfDetails);
            }
            const reqd = inp.required ? '<span style="color:#ef4444">*</span>' : '';
            switch (inp.type) {
                case 'textarea':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <textarea class="form-input" id="run-input-${i}" rows="3" placeholder="${esc(inp.placeholder || '')}">${esc(inp.default || '')}</textarea>
                    </div>`;
                case 'select':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <select class="form-select" id="run-input-${i}">
                            ${(inp.options || []).map(o => `<option value="${esc(o)}" ${o === inp.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}
                        </select>
                    </div>`;
                case 'number':
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <input type="number" class="form-input" id="run-input-${i}" value="${esc(inp.default || '')}" placeholder="${esc(inp.placeholder || '')}">
                    </div>`;
                case 'boolean':
                    return `<div class="form-group" style="display:flex;align-items:center;gap:8px">
                        <input type="checkbox" id="run-input-${i}" ${inp.default ? 'checked' : ''} style="width:16px;height:16px">
                        <label for="run-input-${i}" class="form-label" style="margin:0">${esc(inp.label || inp.name)}</label>
                    </div>`;
                default: // text
                    return `<div class="form-group">
                        <label class="form-label">${esc(inp.label || inp.name)} ${reqd}</label>
                        <input type="text" class="form-input" id="run-input-${i}" value="${esc(inp.default || '')}" placeholder="${esc(inp.placeholder || '')}">
                    </div>`;
            }
        }).join('');
    } else {
        formHtml = `<div style="padding:12px 0;color:var(--text-secondary);font-size:13px">
            <p>This workflow has no defined inputs. It will run with the trigger event: <code style="color:var(--accent)">${esc(wfDetails.trigger?.event || 'unknown')}</code></p>
            <p style="margin-top:8px;color:var(--text-muted);font-size:12px">💡 Add <code>inputs:</code> to the workflow definition to enable a form here.</p>
        </div>`;
    }

    // Store input metadata for executeRun
    window._runInputs = inputs;
    window._runWorkflowName = name;

    openModal(`▶ Run: ${esc(name)}`, `
        <div style="margin-bottom:12px">
            <div style="display:flex;gap:8px;margin-bottom:12px">
                ${sourceBadge(wfDetails.trigger?.source || 'github')}
                <code style="font-size:12px;color:var(--text-secondary)">${esc(wfDetails.trigger?.event || '')}</code>
                ${wfDetails.template ? `<span class="badge badge-action">${esc(wfDetails.template)}</span>` : ''}
            </div>
        </div>
        <div id="run-form">${formHtml}</div>
        <div id="run-status" style="display:none;padding:12px;margin-top:8px;border-radius:var(--radius-sm);background:rgba(99,102,241,0.06);font-size:13px;color:var(--text-secondary)"></div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="run-exec-btn" onclick="executeRun()">▶ Execute</button>
    `);

    // Initialize pickers after modal is open
    for (let i = 0; i < inputs.length; i++) {
        if (inputs[i].type?.startsWith('github-')) {
            initPicker(inputs[i], i, wfDetails);
        }
    }
};

window.executeRun = async function () {
    const name = window._runWorkflowName;
    const inputDefs = window._runInputs || [];
    const btn = $('#run-exec-btn');
    const statusEl = $('#run-status');

    // Collect values
    const inputs = {};
    for (let i = 0; i < inputDefs.length; i++) {
        const inp = inputDefs[i];

        // Handle github-* picker types
        if (inp.type?.startsWith('github-')) {
            const selection = window._pickerSelections?.[i];
            if (inp.required && !selection) {
                toast(`"${inp.label || inp.name}" is required — select an item`, 'error');
                return;
            }
            if (selection) inputs[inp.name] = selection;
            continue;
        }

        const el = $(`#run-input-${i}`);
        if (!el) continue;
        let val;
        if (inp.type === 'boolean') {
            val = el.checked;
        } else if (inp.type === 'number') {
            val = Number(el.value) || 0;
        } else {
            val = el.value;
        }
        // Validate required
        if (inp.required && (val === '' || val === null || val === undefined)) {
            toast(`"${inp.label || inp.name}" is required`, 'error');
            el.focus();
            return;
        }
        inputs[inp.name] = val;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Running...';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></div> Executing workflow...';

    try {
        const result = await api.post(`/api/workflows/${encodeURIComponent(name)}/run`, { inputs });
        if (result.error) {
            statusEl.innerHTML = `<span style="color:#ef4444">✗ ${esc(result.error)}</span>`;
            toast(result.error, 'error');
        } else {
            statusEl.innerHTML = '<span style="color:#22c55e">✓ Workflow executed successfully</span>';
            toast(`Workflow "${name}" executed`);
            setTimeout(closeModal, 1500);
        }
    } catch (err) {
        statusEl.innerHTML = `<span style="color:#ef4444">✗ ${esc(err.message || 'Execution failed')}</span>`;
        toast('Workflow execution failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '▶ Execute';
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// VISUAL TEMPLATE BUILDER
// ═════════════════════════════════════════════════════════════════════════════

let customTemplates = []; // loaded from /api/templates
let builderState = null; // current builder form state

const CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'LS', 'Bash', 'TodoRead', 'TodoWrite', 'MultiTool'];

function newBuilderState(existing) {
    if (existing) {
        // Parse existing template YAML content
        const parsed = typeof existing.parsed === 'object' ? existing.parsed : {};
        const trigger = parsed.trigger || {};
        const steps = (parsed.steps || []).map((s, i) => ({
            id: s.id || '',
            action: s.action || 'log',
            condition: s.condition || '',
            params: s.params || {},
        }));
        return {
            name: existing.name || '',
            description: existing.description || '',
            isEdit: true,
            trigger: {
                source: Array.isArray(trigger.source) ? trigger.source[0] : (trigger.source || 'github'),
                event: Array.isArray(trigger.event) ? trigger.event.join(', ') : (trigger.event || ''),
                repo: trigger.repo || '',
                branch: trigger.branch || '',
                author: trigger.author || '',
                labels: trigger.labels ? trigger.labels.join(', ') : '',
            },
            steps,
            inputs: parsed.inputs || [],
        };
    }
    return {
        name: '',
        description: '',
        isEdit: false,
        trigger: { source: 'github', event: '', repo: '', branch: '', author: '', labels: '' },
        steps: [{ id: '', action: 'log', condition: '', params: { message: 'Event received' } }],
        inputs: [],
    };
}

function builderGenerateYaml() {
    const s = builderState;
    if (!s) return '';
    let y = '';
    if (s.description) y += `# ${s.name}\n#\n# ${s.description}\n\n`;

    // Trigger
    y += 'trigger:\n';
    y += `  source: ${s.trigger.source}\n`;
    if (s.trigger.event) {
        const events = s.trigger.event.split(',').map(e => e.trim()).filter(Boolean);
        if (events.length === 1) {
            y += `  event: ${events[0]}\n`;
        } else if (events.length > 1) {
            y += '  event:\n';
            for (const e of events) y += `    - ${e}\n`;
        }
    }
    if (s.trigger.repo) y += `  repo: "${s.trigger.repo}"\n`;
    if (s.trigger.branch) y += `  branch: "${s.trigger.branch}"\n`;
    if (s.trigger.author) y += `  author: "${s.trigger.author}"\n`;
    if (s.trigger.labels) {
        const labels = s.trigger.labels.split(',').map(l => l.trim()).filter(Boolean);
        if (labels.length) {
            y += '  labels:\n';
            for (const l of labels) y += `    - "${l}"\n`;
        }
    }

    // Inputs
    if (s.inputs.length > 0) {
        y += '\ninputs:\n';
        for (const inp of s.inputs) {
            y += `  - name: ${inp.name}\n`;
            if (inp.label) y += `    label: "${inp.label}"\n`;
            if (inp.type) y += `    type: ${inp.type}\n`;
            if (inp.required) y += `    required: true\n`;
            if (inp.default) y += `    default: "${inp.default}"\n`;
        }
    }

    // Steps
    y += '\nsteps:\n';
    for (const step of s.steps) {
        if (step.id) y += `  - id: ${step.id}\n    action: ${step.action}\n`;
        else y += `  - action: ${step.action}\n`;
        if (step.condition) y += `    condition: "${step.condition}"\n`;
        const params = step.params || {};
        const paramKeys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '');
        if (paramKeys.length > 0) {
            y += '    params:\n';
            for (const key of paramKeys) {
                const val = params[key];
                if (Array.isArray(val)) {
                    y += `      ${key}:\n`;
                    for (const v of val) y += `        - ${v}\n`;
                } else if (typeof val === 'string' && val.includes('\n')) {
                    y += `      ${key}: |\n`;
                    for (const line of val.split('\n')) y += `        ${line}\n`;
                } else if (typeof val === 'object') {
                    y += `      ${key}: {}\n`;
                } else {
                    const needsQuote = typeof val === 'string' && (val.includes('{{') || val.includes(':') || val.includes('#'));
                    y += `      ${key}: ${needsQuote ? `"${val}"` : val}\n`;
                }
            }
        } else {
            y += '    params: {}\n';
        }
    }

    return y;
}

function getActionGroups() {
    return [
        { label: '🤖 AI', actions: ['ai-review', 'ai-agent'] },
        { label: '🐙 GitHub', actions: ['github-clone-repo', 'github-fetch-diff', 'github-comment', 'github-fetch-reviews', 'github-create-pr', 'github-review'] },
        { label: '💬 Slack', actions: ['slack-send-message', 'slack-react'] },
        { label: '🔧 Utility', actions: ['log', 'webhook'] },
    ];
}

function renderActionSelect(stepIdx, currentAction) {
    const groups = getActionGroups();
    let html = `<select class="form-input builder-action-select" id="step-action-${stepIdx}" onchange="builderChangeAction(${stepIdx}, this.value)" style="font-weight:600;color:var(--accent)">`;
    for (const g of groups) {
        html += `<optgroup label="${g.label}">`;
        for (const a of g.actions) {
            const doc = actionDocs[a];
            html += `<option value="${esc(a)}" ${a === currentAction ? 'selected' : ''}>${esc(a)}${doc ? ' — ' + esc(doc.desc).substring(0, 40) : ''}</option>`;
        }
        html += '</optgroup>';
    }
    html += '</select>';
    return html;
}

function renderParamField(stepIdx, paramDef, value) {
    const id = `step-${stepIdx}-param-${paramDef.name}`;
    const val = value !== undefined && value !== null ? value : (paramDef.default || '');

    if (paramDef.name === '(none)') {
        return `<div style="padding:8px 12px;background:rgba(34,197,94,0.06);border-radius:6px;font-size:12px;color:var(--text-muted);font-style:italic">
            ✓ ${esc(paramDef.desc)}
        </div>`;
    }

    // Special: allowed_tools for ai-agent
    if (paramDef.name === 'allowed_tools') {
        const selectedTools = Array.isArray(val) ? val : (typeof val === 'string' ? val.split(',').map(t => t.trim()) : ['Read', 'Grep', 'Glob', 'LS']);
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)} ${paramDef.required ? '<span style="color:#ef4444">*</span>' : ''}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${esc(paramDef.desc)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px" id="${id}">
                ${CLAUDE_TOOLS.map(tool => `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;background:${selectedTools.includes(tool) ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)'};border:1px solid ${selectedTools.includes(tool) ? 'rgba(99,102,241,0.3)' : 'var(--border-color)'};transition:all 0.15s">
                    <input type="checkbox" value="${tool}" ${selectedTools.includes(tool) ? 'checked' : ''} onchange="builderUpdateToolParam(${stepIdx})" style="width:14px;height:14px">
                    ${esc(tool)}
                </label>`).join('')}
            </div>
        </div>`;
    }

    // Special: level dropdown for log action
    if (paramDef.name === 'level') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <select class="form-input" id="${id}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)">
                ${['info', 'warn', 'error', 'debug'].map(l => `<option value="${l}" ${val === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
        </div>`;
    }

    // Special: provider dropdown for ai-review
    if (paramDef.name === 'provider') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <select class="form-input" id="${id}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)">
                ${['auto', 'api', 'claude-code'].map(p => `<option value="${p}" ${val === p ? 'selected' : ''}>${p === 'auto' ? 'Auto-detect' : p}</option>`).join('')}
            </select>
        </div>`;
    }

    // Special: output_format dropdown for ai-agent
    if (paramDef.name === 'output_format') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <select class="form-input" id="${id}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)">
                ${['text', 'json'].map(f => `<option value="${f}" ${val === f ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
        </div>`;
    }

    // Special: method dropdown for webhook
    if (paramDef.name === 'method') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <select class="form-input" id="${id}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)">
                ${['POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option value="${m}" ${val === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
        </div>`;
    }

    // Prompt / body = large textarea
    if (paramDef.name === 'prompt' || paramDef.name === 'body' || paramDef.name === 'text' || paramDef.name === 'system_prompt') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)} ${paramDef.required ? '<span style="color:#ef4444">*</span>' : ''}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <textarea class="form-input" id="${id}" rows="8" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)" style="font-family:var(--font-mono);font-size:12px;min-height:120px;resize:vertical">${esc(String(val))}</textarea>
        </div>`;
    }

    // Number fields
    if (paramDef.type === 'number') {
        return `<div class="form-group" style="margin-bottom:10px">
            <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)} ${paramDef.required ? '<span style="color:#ef4444">*</span>' : ''}</label>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
            <input type="number" class="form-input" id="${id}" value="${esc(String(val))}" placeholder="${esc(paramDef.default || '')}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', Number(this.value))" style="width:120px">
        </div>`;
    }

    // Default: text input
    return `<div class="form-group" style="margin-bottom:10px">
        <label class="form-label" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${esc(paramDef.name)} ${paramDef.required ? '<span style="color:#ef4444">*</span>' : ''}</label>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(paramDef.desc)}</div>
        <input type="text" class="form-input" id="${id}" value="${esc(String(val))}" placeholder="${esc(paramDef.default || '')}" onchange="builderUpdateParam(${stepIdx}, '${paramDef.name}', this.value)">
    </div>`;
}

function renderStepCard(step, idx, total) {
    const doc = actionDocs[step.action];
    const paramDefs = doc?.params || [];

    // Get interpolation hints from prior steps
    const priorVars = [];
    for (let i = 0; i < idx; i++) {
        const ps = builderState.steps[i];
        const sid = ps.id || `step_${i}`;
        if (ps.action === 'github-clone-repo') priorVars.push({ path: `steps.${sid}.path`, desc: 'Cloned repo directory' });
        if (ps.action === 'github-fetch-diff') priorVars.push({ path: `steps.${sid}.diff`, desc: 'PR diff content' });
        if (ps.action === 'ai-review' || ps.action === 'ai-agent') {
            priorVars.push({ path: `steps.${sid}.review`, desc: 'AI response text' });
            priorVars.push({ path: `steps.${sid}.model`, desc: 'Model used' });
            priorVars.push({ path: `steps.${sid}.provider`, desc: 'Provider used' });
        }
        if (ps.action === 'github-create-pr') {
            priorVars.push({ path: `steps.${sid}.url`, desc: 'PR URL' });
            priorVars.push({ path: `steps.${sid}.branch`, desc: 'Branch name' });
        }
        if (ps.action === 'github-fetch-reviews') priorVars.push({ path: `steps.${sid}.summary`, desc: 'Reviews summary' });
    }

    const varsHtml = priorVars.length > 0 ? `
        <div style="margin-top:10px;padding:8px 10px;background:rgba(99,102,241,0.04);border-radius:6px;border:1px solid rgba(99,102,241,0.1)">
            <div style="font-size:10px;font-weight:700;color:var(--accent);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Available Variables</div>
            ${priorVars.map(v => `<div style="font-size:11px;margin-bottom:2px"><code style="color:var(--accent);background:rgba(99,102,241,0.1);padding:1px 4px;border-radius:3px">{{${v.path}}}</code> <span style="color:var(--text-muted)">${esc(v.desc)}</span></div>`).join('')}
        </div>
    ` : '';

    return `
    <div class="builder-step-card" id="builder-step-${idx}">
        <div class="builder-step-header">
            <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
                <div class="step-num" style="width:28px;height:28px;font-size:12px;flex-shrink:0">${idx + 1}</div>
                ${renderActionSelect(idx, step.action)}
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
                <button class="btn btn-ghost btn-sm" onclick="builderMoveStep(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
                <button class="btn btn-ghost btn-sm" onclick="builderMoveStep(${idx}, 1)" ${idx === total - 1 ? 'disabled' : ''} title="Move down">↓</button>
                <button class="btn btn-ghost btn-sm" onclick="builderDuplicateStep(${idx})" title="Duplicate">⧉</button>
                <button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="builderRemoveStep(${idx})" ${total <= 1 ? 'disabled' : ''} title="Remove">✕</button>
            </div>
        </div>
        ${doc ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;padding-left:38px">${esc(doc.desc)}</div>` : ''}
        <div class="builder-step-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div class="form-group" style="margin-bottom:0">
                    <label class="form-label" style="font-size:11px;font-weight:600;color:var(--text-muted)">STEP ID <span style="font-weight:400">(optional)</span></label>
                    <input type="text" class="form-input" value="${esc(step.id || '')}" placeholder="e.g. clone, review" onchange="builderUpdateStepId(${idx}, this.value)" style="font-family:var(--font-mono);font-size:12px">
                </div>
                <div class="form-group" style="margin-bottom:0">
                    <label class="form-label" style="font-size:11px;font-weight:600;color:var(--text-muted)">CONDITION <span style="font-weight:400">(optional)</span></label>
                    <input type="text" class="form-input" value="${esc(step.condition || '')}" placeholder="e.g. {{steps.analysis.changes_needed}}" onchange="builderUpdateStepCondition(${idx}, this.value)" style="font-family:var(--font-mono);font-size:12px">
                </div>
            </div>
            <div class="builder-params-section">
                ${paramDefs.map(pd => renderParamField(idx, pd, step.params?.[pd.name])).join('')}
            </div>
            ${varsHtml}
        </div>
    </div>`;
}

function renderInputRow(inp, idx) {
    return `<div style="display:grid;grid-template-columns:1fr 1fr 120px 60px 40px;gap:8px;align-items:end;margin-bottom:8px">
        <div>
            <label class="form-label" style="font-size:11px;color:var(--text-muted)">Name</label>
            <input type="text" class="form-input" value="${esc(inp.name || '')}" onchange="builderUpdateInput(${idx}, 'name', this.value)" placeholder="param_name" style="font-size:12px">
        </div>
        <div>
            <label class="form-label" style="font-size:11px;color:var(--text-muted)">Label</label>
            <input type="text" class="form-input" value="${esc(inp.label || '')}" onchange="builderUpdateInput(${idx}, 'label', this.value)" placeholder="Display Label" style="font-size:12px">
        </div>
        <div>
            <label class="form-label" style="font-size:11px;color:var(--text-muted)">Type</label>
            <select class="form-input" onchange="builderUpdateInput(${idx}, 'type', this.value)" style="font-size:12px">
                ${['text', 'textarea', 'number', 'boolean', 'select', 'github-pr', 'github-issue', 'github-repo'].map(t =>
                    `<option value="${t}" ${inp.type === t ? 'selected' : ''}>${t}</option>`
                ).join('')}
            </select>
        </div>
        <div style="display:flex;align-items:center;gap:4px;padding-bottom:2px">
            <input type="checkbox" ${inp.required ? 'checked' : ''} onchange="builderUpdateInput(${idx}, 'required', this.checked)" style="width:14px;height:14px">
            <span style="font-size:11px;color:var(--text-muted)">Req</span>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:#ef4444;padding:4px" onclick="builderRemoveInput(${idx})">✕</button>
    </div>`;
}

function renderTemplateBuilder(el) {
    const s = builderState;
    const isGithub = ['github', 'gh-cli', 'github-poll'].includes(s.trigger.source);

    // Get events for selected source
    const sourceEvents = eventCatalog[s.trigger.source === 'gh-cli' ? 'github' : s.trigger.source === 'github-poll' ? 'github' : s.trigger.source] || [];

    el.innerHTML = `
    <div class="builder-container">
        <div class="builder-header">
            <div>
                <h1 style="font-size:22px;font-weight:700;margin-bottom:4px">${s.isEdit ? '✏️ Edit' : '🛠️ Create'} Custom Recipe</h1>
                <p style="font-size:13px;color:var(--text-muted)">Design your automation visually — no YAML needed</p>
            </div>
            <div style="display:flex;gap:8px">
                <button class="btn btn-ghost" onclick="builderCancel()">Cancel</button>
                <button class="btn btn-ghost" onclick="builderPreviewYaml()">Preview YAML</button>
                <button class="btn btn-primary" onclick="builderSave()">💾 ${s.isEdit ? 'Update' : 'Create'} Recipe</button>
            </div>
        </div>

        <!-- NAME & DESCRIPTION -->
        <div class="builder-section">
            <div class="builder-section-title">📝 Basics</div>
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:16px">
                <div class="form-group">
                    <label class="form-label">Recipe Name</label>
                    <input type="text" class="form-input" id="builder-name" value="${esc(s.name)}" placeholder="my-custom-review" ${s.isEdit ? 'disabled style="opacity:0.6"' : ''} oninput="builderState.name=this.value" style="font-size:14px;font-weight:500">
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Lowercase with dashes. Used as the template ID.</div>
                </div>
                <div class="form-group">
                    <label class="form-label">Description</label>
                    <input type="text" class="form-input" id="builder-desc" value="${esc(s.description)}" placeholder="What does this recipe do?" oninput="builderState.description=this.value" style="font-size:14px">
                </div>
            </div>
        </div>

        <!-- TRIGGER -->
        <div class="builder-section">
            <div class="builder-section-title">⚡ Trigger</div>
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;margin-bottom:12px">
                <div class="form-group">
                    <label class="form-label">Source</label>
                    <select class="form-input" id="builder-source" onchange="builderState.trigger.source=this.value;renderTemplateBuilder($('#content'))" style="font-size:14px">
                        ${['github', 'gh-cli', 'github-poll', 'slack', 'cron', 'webhook', 'manual'].map(src =>
                            `<option value="${src}" ${s.trigger.source === src ? 'selected' : ''}>${src}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Event(s)</label>
                    ${sourceEvents.length > 0 ? `
                        <select class="form-input" id="builder-event-select" onchange="if(this.value){const curr=document.getElementById('builder-event').value;document.getElementById('builder-event').value=curr?(curr+', '+this.value):this.value;builderState.trigger.event=document.getElementById('builder-event').value;this.value='';}" style="font-size:13px;margin-bottom:6px">
                            <option value="">+ Add event from list...</option>
                            ${sourceEvents.map(e => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join('')}
                        </select>
                    ` : ''}
                    <input type="text" class="form-input" id="builder-event" value="${esc(s.trigger.event)}" placeholder="e.g. pull_request.opened, push" oninput="builderState.trigger.event=this.value" style="font-family:var(--font-mono);font-size:13px">
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Comma-separated for multiple events</div>
                </div>
            </div>
            ${isGithub ? `
            <div class="builder-filters-grid">
                <div class="form-group">
                    <label class="form-label" style="font-size:12px">Repository</label>
                    <input type="text" class="form-input" value="${esc(s.trigger.repo)}" placeholder="owner/repo" oninput="builderState.trigger.repo=this.value" style="font-size:13px">
                </div>
                <div class="form-group">
                    <label class="form-label" style="font-size:12px">Branch</label>
                    <input type="text" class="form-input" value="${esc(s.trigger.branch)}" placeholder="main" oninput="builderState.trigger.branch=this.value" style="font-size:13px">
                </div>
                <div class="form-group">
                    <label class="form-label" style="font-size:12px">Author</label>
                    <input type="text" class="form-input" value="${esc(s.trigger.author)}" placeholder="github-username" oninput="builderState.trigger.author=this.value" style="font-size:13px">
                </div>
                <div class="form-group">
                    <label class="form-label" style="font-size:12px">Labels</label>
                    <input type="text" class="form-input" value="${esc(s.trigger.labels)}" placeholder="bug, urgent" oninput="builderState.trigger.labels=this.value" style="font-size:13px">
                </div>
            </div>
            ` : ''}
        </div>

        <!-- STEPS -->
        <div class="builder-section">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <div class="builder-section-title" style="margin-bottom:0">🔗 Steps Pipeline</div>
                <span style="font-size:12px;color:var(--text-muted)">${s.steps.length} step${s.steps.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="builder-steps-pipeline">
                ${s.steps.map((step, i) => renderStepCard(step, i, s.steps.length)).join(`
                    <div class="builder-step-connector"><div class="connector-line"></div><div class="connector-arrow">▼</div></div>
                `)}
            </div>
            <button class="btn btn-ghost builder-add-step-btn" onclick="builderAddStep()">
                + Add Step
            </button>
        </div>

        <!-- INPUTS -->
        <div class="builder-section">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <div>
                    <div class="builder-section-title" style="margin-bottom:2px">📥 Inputs <span style="font-weight:400;color:var(--text-muted);font-size:12px">(optional)</span></div>
                    <div style="font-size:12px;color:var(--text-muted)">Define inputs for manual-trigger workflows. Users fill these before running.</div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="builderAddInput()">+ Add Input</button>
            </div>
            ${s.inputs.length > 0 ? `
                <div class="builder-inputs-list">
                    ${s.inputs.map((inp, i) => renderInputRow(inp, i)).join('')}
                </div>
            ` : `
                <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;border:1px dashed var(--border-color);border-radius:8px">
                    No inputs defined. Click "+ Add Input" to add form fields for manual runs.
                </div>
            `}
        </div>
    </div>`;
}

// ─── Builder Actions ────────────────────────────────────────────────────────

window.builderChangeAction = function (stepIdx, action) {
    builderState.steps[stepIdx].action = action;
    builderState.steps[stepIdx].params = {};
    renderTemplateBuilder($('#content'));
};

window.builderUpdateParam = function (stepIdx, paramName, value) {
    if (!builderState.steps[stepIdx].params) builderState.steps[stepIdx].params = {};
    builderState.steps[stepIdx].params[paramName] = value;
};

window.builderUpdateToolParam = function (stepIdx) {
    const container = document.getElementById(`step-${stepIdx}-param-allowed_tools`);
    if (!container) return;
    const tools = [...container.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
    builderState.steps[stepIdx].params.allowed_tools = tools;
};

window.builderUpdateStepId = function (stepIdx, value) {
    builderState.steps[stepIdx].id = value;
};

window.builderUpdateStepCondition = function (stepIdx, value) {
    builderState.steps[stepIdx].condition = value;
};

window.builderMoveStep = function (idx, dir) {
    const steps = builderState.steps;
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    [steps[idx], steps[target]] = [steps[target], steps[idx]];
    renderTemplateBuilder($('#content'));
};

window.builderDuplicateStep = function (idx) {
    const step = builderState.steps[idx];
    builderState.steps.splice(idx + 1, 0, {
        id: step.id ? step.id + '_copy' : '',
        action: step.action,
        condition: step.condition,
        params: JSON.parse(JSON.stringify(step.params || {})),
    });
    renderTemplateBuilder($('#content'));
};

window.builderRemoveStep = function (idx) {
    if (builderState.steps.length <= 1) return;
    builderState.steps.splice(idx, 1);
    renderTemplateBuilder($('#content'));
};

window.builderAddStep = function () {
    builderState.steps.push({ id: '', action: 'log', condition: '', params: { message: '' } });
    renderTemplateBuilder($('#content'));
    // Scroll to the new step
    setTimeout(() => {
        const el = document.getElementById(`builder-step-${builderState.steps.length - 1}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
};

window.builderAddInput = function () {
    builderState.inputs.push({ name: '', label: '', type: 'text', required: false, default: '' });
    renderTemplateBuilder($('#content'));
};

window.builderRemoveInput = function (idx) {
    builderState.inputs.splice(idx, 1);
    renderTemplateBuilder($('#content'));
};

window.builderUpdateInput = function (idx, field, value) {
    builderState.inputs[idx][field] = value;
};

window.builderPreviewYaml = function () {
    const yaml = builderGenerateYaml();
    openModal('Generated YAML Preview', `
        <pre style="background:var(--bg-secondary);padding:16px;border-radius:8px;font-size:12px;overflow:auto;max-height:500px;border:1px solid var(--border-color);white-space:pre-wrap;font-family:var(--font-mono)">${esc(yaml)}</pre>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText(document.querySelector('#modal-body pre').innerText);toast('Copied to clipboard')">Copy</button>
    `);
};

window.builderCancel = function () {
    builderState = null;
    navigate('library');
};

window.builderSave = async function () {
    const s = builderState;
    if (!s.name?.trim()) { toast('Recipe name is required', 'error'); document.getElementById('builder-name')?.focus(); return; }
    if (!s.trigger.event?.trim() && s.trigger.source !== 'manual') { toast('At least one trigger event is required', 'error'); return; }
    if (s.steps.length === 0) { toast('At least one step is required', 'error'); return; }

    const yaml = builderGenerateYaml();
    const name = s.name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');

    try {
        if (s.isEdit) {
            await api.put(`/api/templates/${encodeURIComponent(name)}`, { content: yaml });
            toast(`Recipe "${name}" updated`);
        } else {
            await api.post('/api/templates', { name, content: yaml });
            toast(`Recipe "${name}" created`);
        }
        builderState = null;
        libraryActiveCategory = 'custom';
        navigate('library');
    } catch (err) {
        toast('Failed to save recipe: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.openTemplateBuilder = function (existingName) {
    if (existingName) {
        const tmpl = customTemplates.find(t => t.name === existingName);
        if (!tmpl) { toast('Template not found', 'error'); return; }
        // Parse the raw YAML
        let parsed = {};
        try {
            // Simple YAML -> object (we'll use the raw content for editing)
            parsed = tmpl.parsed || {};
        } catch { }
        builderState = newBuilderState({ name: tmpl.name, parsed: { trigger: tmpl.trigger, steps: tmpl.steps, inputs: tmpl.inputs }, description: '' });
    } else {
        builderState = newBuilderState();
    }
    // Render builder instead of library
    renderTemplateBuilder($('#content'));
};

window.deleteCustomTemplate = async function (name) {
    if (!(await confirm(`Delete custom recipe <strong>"${esc(name)}"</strong>?<br><span style="font-size:12px;color:var(--text-muted)">This cannot be undone.</span>`))) return;
    try {
        await api.del(`/api/templates/${encodeURIComponent(name)}`);
        toast(`Recipe "${name}" deleted`);
        navigate('library');
    } catch (err) {
        toast('Failed to delete recipe: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// LIBRARY + DECK
// ═════════════════════════════════════════════════════════════════════════════

function getFilteredLibraryItems() {
    let items = libraryItems;
    if (libraryActiveCategory !== 'all') {
        items = items.filter(i => i.category === libraryActiveCategory);
    }
    if (librarySearchQuery.trim()) {
        const q = librarySearchQuery.toLowerCase().trim();
        items = items.filter(i =>
            i.name.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q) ||
            i.tags.some(t => t.includes(q)) ||
            i.category.replace('-', ' ').includes(q)
        );
    }
    // Sort: installed first, then popular, then available before coming-soon.
    // "Installed" derives from actual workflow existence so the sort
    // matches the visual badge — deck-only would float orphaned cards
    // to the top after a manual workflow delete.
    items.sort((a, b) => {
        const aInstalled = getInstalledWorkflowName(a.id) ? 1 : 0;
        const bInstalled = getInstalledWorkflowName(b.id) ? 1 : 0;
        if (aInstalled !== bInstalled) return bInstalled - aInstalled;
        if (a.popular !== b.popular) return b.popular - a.popular;
        if (a.status !== b.status) return a.status === 'available' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return items;
}

// Find the installed workflow name for a library item
function getInstalledWorkflowName(itemId) {
    // Check if any workflow's name matches a known pattern for this item
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return null;
    return workflows.find(w =>
        w.template === item.template && (
            w.name === `my-${item.id}` ||
            w.name === item.id ||
            w._libraryItem === item.id
        )
    )?.name || null;
}

// Get all deck items that have PR triggers
function getDeckPrItems() {
    return deck.map(id => libraryItems.find(i => i.id === id)).filter(Boolean).filter(item => {
        const events = ensureArray(item.defaultTrigger?.event);
        return events.some(e => e?.startsWith('pull_request'));
    });
}

// Get all deck items that have issue triggers
function getDeckIssueItems() {
    return deck.map(id => libraryItems.find(i => i.id === id)).filter(Boolean).filter(item => {
        const events = ensureArray(item.defaultTrigger?.event);
        return item.category === 'issue-management' || events.some(e => e?.startsWith('issues'));
    });
}

function renderLibraryCard(item) {
    // Source of truth: does a workflow that originated from this
    // library item actually exist? `deck` can desync (e.g. user
    // deletes the workflow via the workflows page) — using deck
    // membership alone makes the card lie about state and strands
    // the user with no install button. See getInstalledWorkflowName
    // for the matching rules.
    const isInstalled = getInstalledWorkflowName(item.id) !== null;
    const isComingSoon = item.status === 'coming-soon';
    const diffColors = { easy: '#22c55e', medium: '#f59e0b', advanced: '#a855f7' };
    const diffColor = diffColors[item.difficulty] || '#6b7280';
    const integBadges = item.requiredIntegrations.map(i =>
        `<span class="badge badge-${i}" style="font-size:10px;padding:2px 6px">${esc(i)}</span>`
    ).join(' ');

    return `
    <div class="library-card ${isInstalled ? 'in-deck' : ''} ${isComingSoon ? 'coming-soon' : ''}">
        <div class="library-card-header">
            <span class="library-card-icon">${item.icon}</span>
            <div class="library-card-title-area">
                <span class="library-card-name">${esc(item.name)}</span>
                <span class="difficulty-badge" style="--diff-color:${diffColor}">${item.difficulty}</span>
                ${isComingSoon ? '<span class="badge" style="background:rgba(107,114,128,0.3);color:#9ca3af;font-size:10px;padding:2px 6px">Coming Soon</span>' : ''}
                ${isInstalled ? '<span class="badge" style="background:rgba(34,197,94,0.2);color:#22c55e;font-size:10px;padding:2px 6px">✓ Installed</span>' : ''}
            </div>
        </div>
        <p class="library-card-desc">${esc(item.description)}</p>
        <div class="library-card-meta">
            <div class="library-card-integrations">${integBadges}</div>
            <div class="library-card-tags">${item.tags.slice(0, 3).map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>
        </div>
        <div class="library-card-actions">
            ${isComingSoon ? `
                <button class="btn btn-ghost btn-sm" disabled>Not Available</button>
            ` : isInstalled ? `
                <button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="uninstallLibraryItem('${item.id}')">Uninstall</button>
                <button class="btn btn-ghost btn-sm" onclick="openLibraryItemInEditor('${item.id}')">✏️ Edit</button>
                <button class="btn btn-ghost btn-sm" onclick="previewLibraryItem('${item.id}')">Preview</button>
            ` : `
                <button class="btn btn-primary btn-sm" onclick="installLibraryItem('${item.id}')">⚡ Install</button>
                <button class="btn btn-ghost btn-sm" onclick="openLibraryItemInEditor('${item.id}')">✏️ Open in Editor</button>
                <button class="btn btn-ghost btn-sm" onclick="previewLibraryItem('${item.id}')">Preview</button>
            `}
        </div>
    </div>`;
}

// Library card → Visual Editor. For not-installed items: stage the
// template's graph in the editor so the user can tweak before saving;
// Save in the editor creates the workflow + flips the library badge.
// For installed items: open the actual workflow that backs the card.
window.openLibraryItemInEditor = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) { toast('Library item not found', 'error'); return; }

    // Already installed → open the existing workflow.
    const installedName = getInstalledWorkflowName(itemId);
    if (installedName && typeof window.openGraphEditor === 'function') {
        return window.openGraphEditor(installedName);
    }

    // Stage from the template. Prefer the graph form when the YAML has
    // one; fall back to the legacy steps form (the editor's
    // ensureGraphShape will linearize it).
    try {
        const res = await api.get(`/api/templates/library/${encodeURIComponent(item.template)}/graph`);
        const stagedName = `my-${item.id}`;
        const stagedShape = {
            name: stagedName,
            description: res.description || item.description,
            enabled: true,
            graph: res.graph,
            steps: res.graph ? undefined : res.steps,
            trigger: res.trigger,
        };
        return window.openGraphEditor(null, { staged: stagedShape, libraryItemId: item.id });
    } catch (err) {
        // Template not in library/ — fall back to root templates dir.
        try {
            const all = await api.get('/api/templates');
            const tmpl = (all.templates || []).find(t => t.name === item.template);
            if (!tmpl) throw new Error(`Template "${item.template}" not found`);
            const stagedName = `my-${item.id}`;
            const stagedShape = {
                name: stagedName,
                description: tmpl.description || item.description,
                enabled: true,
                graph: tmpl.graph,
                steps: tmpl.graph ? undefined : tmpl.steps,
                trigger: tmpl.trigger,
            };
            return window.openGraphEditor(null, { staged: stagedShape, libraryItemId: item.id });
        } catch (err2) {
            toast(`Could not load template: ${err2.message}`, 'error');
        }
    }
};

async function renderLibrary(el) {
    // If builder is active, render it instead
    if (builderState) { renderTemplateBuilder(el); return; }

    // Refresh the workflows list before rendering: the library card's
    // "Installed" badge derives from actual workflow existence (via
    // `getInstalledWorkflowName`), so a stale module-scoped `workflows`
    // would make the badge lie after a deletion that happened in
    // another tab / via the API / via a workflow uninstall that
    // navigated us elsewhere before refreshing.
    try {
        const wfData = await api.get('/api/workflows');
        workflows = wfData.workflows || [];
    } catch { /* keep stale data; rendering still completes */ }

    // Load custom templates
    try {
        const tmplData = await api.get('/api/templates');
        customTemplates = tmplData.templates || [];
    } catch { customTemplates = []; }

    const filtered = getFilteredLibraryItems();
    const catCounts = {};
    for (const cat of libraryCategories) {
        if (cat.key === 'all') catCounts[cat.key] = libraryItems.length + customTemplates.length;
        else if (cat.key === 'custom') catCounts[cat.key] = customTemplates.length;
        else catCounts[cat.key] = libraryItems.filter(i => i.category === cat.key).length;
    }
    const installedCount = deck.length;

    // Custom template cards
    const customCards = (libraryActiveCategory === 'custom' || libraryActiveCategory === 'all')
        ? customTemplates.filter(t => {
            if (!librarySearchQuery.trim()) return true;
            const q = librarySearchQuery.toLowerCase().trim();
            return t.name.toLowerCase().includes(q);
        }).map(t => `
            <div class="library-card custom-template-card">
                <div class="library-card-header">
                    <div class="library-card-icon">🛠️</div>
                    <div class="library-card-meta">
                        <h3 class="library-card-title">${esc(t.name)}</h3>
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px">
                            <span class="badge" style="background:rgba(168,85,247,0.15);color:#a855f7;border:1px solid rgba(168,85,247,0.3);font-size:10px">custom</span>
                            ${sourceBadge(t.trigger?.source ?? 'github')}
                            ${t.trigger?.event ? `<code style="font-size:10px;color:var(--text-muted)">${esc(Array.isArray(t.trigger.event) ? t.trigger.event.join(', ') : t.trigger.event)}</code>` : ''}
                        </div>
                    </div>
                </div>
                <div class="library-card-steps">
                    ${(t.steps || []).map((s, i) => `<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 0">
                        <span class="step-num" style="width:18px;height:18px;font-size:9px">${i + 1}</span>
                        <span style="color:var(--text-secondary)">${esc(s.action)}</span>
                        ${s.condition ? '<span class="badge badge-warning" style="font-size:8px;padding:1px 4px">if</span>' : ''}
                    </div>`).join('')}
                </div>
                <div class="library-card-footer" style="margin-top:auto;padding-top:12px;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:6px">
                    <button class="btn btn-ghost btn-sm" onclick="openTemplateBuilder('${esc(t.name)}')">✏️ Edit</button>
                    <button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="deleteCustomTemplate('${esc(t.name)}')">🗑 Delete</button>
                </div>
            </div>
        `).join('')
        : '';

    el.innerHTML = `
    <div class="page-header">
        <div>
            <h1>Library</h1>
            <p class="page-subtitle">Browse AI workflow recipes — install to activate and get quick actions everywhere</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
            <span class="badge" style="background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3);font-size:12px;padding:4px 10px">${installedCount} installed</span>
            <button class="btn btn-primary" onclick="openTemplateBuilder()" id="create-custom-btn">🛠️ Create Custom Recipe</button>
        </div>
    </div>

    <div class="library-search-bar">
        <input type="text" class="form-input library-search" id="library-search"
            placeholder="Search workflows... (e.g. review, slack, security)"
            value="${esc(librarySearchQuery)}"
            oninput="librarySearchQuery=this.value;renderLibrary($('#content'))">
        <div class="library-tabs">
            ${libraryCategories.map(cat => `
                <button class="library-tab ${libraryActiveCategory === cat.key ? 'active' : ''}"
                    onclick="libraryActiveCategory='${cat.key}';renderLibrary($('#content'))">
                    <span class="library-tab-icon">${cat.icon}</span>
                    <span class="library-tab-label">${cat.label}</span>
                    <span class="library-tab-count">${catCounts[cat.key]}</span>
                </button>
            `).join('')}
        </div>
    </div>

    <div class="library-grid">
        ${libraryActiveCategory === 'custom' ? '' : (filtered.length > 0 ? filtered.map(renderLibraryCard).join('') : '')}
        ${customCards}
        ${filtered.length === 0 && !customCards ? `
            <div class="empty-state" style="grid-column:1/-1">
                <div class="empty-icon">🔍</div>
                <p class="empty-text">No workflows match "${esc(librarySearchQuery)}"</p>
                <button class="btn btn-ghost" onclick="librarySearchQuery='';libraryActiveCategory='all';renderLibrary($('#content'))">Clear Filters</button>
            </div>` : ''}
        ${libraryActiveCategory === 'custom' && customTemplates.length === 0 ? `
            <div class="empty-state" style="grid-column:1/-1">
                <div class="empty-icon">🛠️</div>
                <p class="empty-text">No custom recipes yet</p>
                <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Create your own automation from scratch using the visual builder</p>
                <button class="btn btn-primary" onclick="openTemplateBuilder()">🛠️ Create Custom Recipe</button>
            </div>` : ''}
    </div>`;

    // Focus search if user was typing
    if (librarySearchQuery) {
        const searchEl = $('#library-search');
        if (searchEl) { searchEl.focus(); searchEl.selectionStart = searchEl.selectionEnd = searchEl.value.length; }
    }
}

// Install = Create workflow + Add to deck (single action)
window.installLibraryItem = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return;

    const defaultName = `my-${item.id}`;
    const sources = ensureArray(item.defaultTrigger?.source || 'github');
    const events = ensureArray(item.defaultTrigger?.event || '');

    // Build source & event options for the config modal
    const sourceOptions = [...new Set(['github', 'gh-cli', 'github-poll', 'slack', 'cron', 'webhook', 'manual', ...sources])];
    const triggerSource = sources[0] || 'github';
    const triggerEvent = events.join(', ');

    openModal(`⚡ Install: ${item.name}`, `
        <p style="color:var(--text-secondary);margin-bottom:16px;line-height:1.5">${esc(item.description)}</p>

        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
            <span class="difficulty-badge" style="--diff-color:${item.difficulty === 'easy' ? '#22c55e' : item.difficulty === 'medium' ? '#f59e0b' : '#a855f7'}">${item.difficulty}</span>
            ${item.requiredIntegrations.map(i => `<span class="badge badge-${i}">${esc(i)}</span>`).join(' ')}
        </div>

        <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">WORKFLOW NAME</label>
            <input type="text" id="install-wf-name" class="form-input" value="${esc(defaultName)}"
                style="width:100%;padding:10px 12px;font-size:14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary)">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div>
                <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">TRIGGER SOURCE</label>
                <select id="install-wf-source" class="form-input"
                    style="width:100%;padding:10px 12px;font-size:14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary)">
                    ${sourceOptions.map(s => `<option value="${esc(s)}" ${s === triggerSource ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                </select>
            </div>
            <div>
                <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">TRIGGER EVENT</label>
                <input type="text" id="install-wf-event" class="form-input" value="${esc(triggerEvent)}"
                    style="width:100%;padding:10px 12px;font-size:14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary)">
            </div>
        </div>

        <div style="padding:12px;border-radius:8px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.15);margin-bottom:8px">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">
                <strong>Template:</strong> <code>${esc(item.template)}</code><br>
                <strong>What happens:</strong> A workflow will be created that runs automatically on matching events. It will appear as a quick action on your Dashboard, PRs, and Issues pages.
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="confirmInstallLibraryItem('${item.id}')">Create Workflow</button>
    `);
};

window.confirmInstallLibraryItem = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return;

    const nameEl = document.getElementById('install-wf-name');
    const sourceEl = document.getElementById('install-wf-source');
    const eventEl = document.getElementById('install-wf-event');
    if (!nameEl || !sourceEl || !eventEl) return;

    const wfName = nameEl.value.trim();
    const wfSource = sourceEl.value;
    const wfEvents = eventEl.value.split(',').map(e => e.trim()).filter(Boolean);

    if (!wfName) { toast('Please enter a workflow name', 'error'); return; }

    closeModal();

    try {
        // 1. Create workflow
        const workflow = {
            name: wfName,
            template: item.template,
            _libraryItem: item.id,
            trigger: {
                source: wfSource,
                event: wfEvents.length === 1 ? wfEvents[0] : wfEvents,
            },
        };
        await api.post('/api/workflows', workflow);

        // 2. Add to deck
        if (!deck.includes(item.id)) {
            deck.push(item.id);
            await api.post('/api/deck/add', { id: item.id });
        }

        // 3. Refresh workflows list
        const wfData = await api.get('/api/workflows');
        workflows = wfData.workflows || [];

        toast(`"${item.name}" installed! Workflow "${wfName}" created.`);
    } catch (err) {
        toast('Install failed: ' + (err.message || 'Unknown error'), 'error');
    }

    if (currentPage === 'library') renderLibrary($('#content'));
};

window.uninstallLibraryItem = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return;

    // Find the associated workflow(s)
    const matchingWfs = workflows.filter(w =>
        w._libraryItem === item.id ||
        (w.template === item.template && (w.name === `my-${item.id}` || w.name === item.id))
    );

    const wfNames = matchingWfs.map(w => w.name);

    openModal(`Uninstall: ${item.name}`, `
        <p style="color:var(--text-secondary);margin-bottom:16px;line-height:1.5">
            This will remove the recipe from your deck${wfNames.length > 0 ? ` and delete ${wfNames.length === 1 ? 'the workflow' : wfNames.length + ' workflows'}: <strong>${wfNames.map(n => esc(n)).join(', ')}</strong>` : ''}.
        </p>
        <p style="color:var(--text-muted);font-size:12px">
            The recipe will remain in the Library if you want to install it again later.
        </p>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" style="background:#ef4444;border-color:#ef4444" onclick="confirmUninstallLibraryItem('${item.id}')">Uninstall</button>
    `);
};

window.confirmUninstallLibraryItem = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return;
    closeModal();

    try {
        // 1. Delete matching workflows
        const matchingWfs = workflows.filter(w =>
            w._libraryItem === item.id ||
            (w.template === item.template && (w.name === `my-${item.id}` || w.name === item.id))
        );
        for (const wf of matchingWfs) {
            try { await api.del(`/api/workflows/${encodeURIComponent(wf.name)}`); } catch { /* ignore */ }
        }

        // 2. Remove from deck
        deck = deck.filter(id => id !== item.id);
        try { await api.del(`/api/deck/${encodeURIComponent(item.id)}`); } catch { /* ignore */ }

        // 3. Refresh workflows list
        const wfData = await api.get('/api/workflows');
        workflows = wfData.workflows || [];

        toast(`"${item.name}" uninstalled`);
    } catch (err) {
        toast('Uninstall failed: ' + err.message, 'error');
    }

    if (currentPage === 'library') renderLibrary($('#content'));
};

window.previewLibraryItem = async function (itemId) {
    const item = libraryItems.find(i => i.id === itemId);
    if (!item) return;
    // Match renderLibraryCard: workflow existence is the source of truth.
    const isInstalled = getInstalledWorkflowName(item.id) !== null;
    try {
        const tmpl = templates.find(t => t.name === item.template) || libraryTemplates.find(t => t.name === item.template);
        const yamlContent = tmpl?.content || `# Template: ${item.template}\n# (Template content will be loaded on install)`;
        openModal(`Preview: ${item.name}`, `
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
                <span class="difficulty-badge" style="--diff-color:${item.difficulty === 'easy' ? '#22c55e' : item.difficulty === 'medium' ? '#f59e0b' : '#a855f7'}">${item.difficulty}</span>
                ${item.requiredIntegrations.map(i => `<span class="badge badge-${i}">${esc(i)}</span>`).join(' ')}
                ${item.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}
                ${isInstalled ? '<span class="badge" style="background:rgba(34,197,94,0.2);color:#22c55e;font-size:10px;padding:2px 6px">✓ Installed</span>' : ''}
            </div>
            <p style="color:var(--text-secondary);margin-bottom:16px;line-height:1.6">${esc(item.description)}</p>
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">TEMPLATE: ${esc(item.template)}</div>
            <pre style="background:var(--bg-secondary);padding:14px;border-radius:8px;font-size:12px;overflow:auto;max-height:400px;border:1px solid var(--border)">${esc(typeof yamlContent === 'string' ? yamlContent : JSON.stringify(yamlContent, null, 2))}</pre>
        `, `
            <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            ${isInstalled ?
                `<button class="btn btn-ghost" style="color:#ef4444" onclick="closeModal();uninstallLibraryItem('${item.id}')">Uninstall</button>` :
                `<button class="btn btn-primary" onclick="closeModal();installLibraryItem('${item.id}')">⚡ Install</button>`
            }
        `);
    } catch { /* ignore */ }
};


// ═════════════════════════════════════════════════════════════════════════════
// INTEGRATIONS
// ═════════════════════════════════════════════════════════════════════════════
async function renderIntegrations(el) {
    const [intData, cfgData, aiData, cliData] = await Promise.all([
        api.get('/api/integrations'),
        api.get('/api/config'),
        api.get('/api/ai/providers').catch(() => ({ providers: [], default_provider: null })),
        api.get('/api/ai/cli-status').catch(() => ({ claude: false, opencode: false })),
    ]);
    integrations = intData.integrations || {};
    const aiProviders = Array.isArray(aiData.providers) ? aiData.providers : [];
    const defaultProvider = aiData.default_provider || '';
    const cliStatus = cliData || { claude: false, opencode: false };

    const defs = [
        {
            key: 'github', icon: '🐙', name: 'GitHub (Webhooks)', desc: 'Real-time PRs, issues, pushes via webhooks', endpoint: '/webhooks/github',
            fields: [
                { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', env: 'GITHUB_WEBHOOK_SECRET', hint: 'Secret from GitHub webhook settings' },
                { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token or GitHub App token' },
            ]
        },
        {
            key: 'github-poll', icon: '🔄', name: 'GitHub (Polling)', desc: 'Poll repos for changes — no public URL needed', endpoint: '—',
            fields: [
                { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token' },
                { key: 'repos', label: 'Repositories', type: 'text', hint: 'Comma-separated: owner/repo, owner/repo2' },
                { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'Default: 60' },
            ]
        },
        {
            key: 'gh-cli', icon: '⚡', name: 'GitHub (gh CLI)', desc: 'Zero-config — auto-detects gh auth, polls all your PRs', endpoint: '—',
            fields: [
                { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'Default: 60' },
            ]
        },
        {
            key: 'slack', icon: '💬', name: 'Slack', desc: 'Messages, @mentions, slash commands', endpoint: '/webhooks/slack/events',
            fields: [
                { key: 'signingSecret', label: 'Signing Secret', type: 'password', hint: 'From Slack app settings' },
                { key: 'botToken', label: 'Bot Token', type: 'password', hint: 'xoxb-... token' },
            ]
        },
        {
            key: 'webhook', icon: '🔗', name: 'Generic Webhook', desc: 'Accept JSON from any source', endpoint: '/webhooks/custom/:name',
            fields: [
                { key: 'secret', label: 'Secret (optional)', type: 'password', hint: 'HMAC validation secret' },
            ]
        },
        {
            key: 'cron', icon: '⏰', name: 'Cron', desc: 'Scheduled time-based triggers', endpoint: '—',
            fields: []
        },
    ];

    el.innerHTML = `
        <div class="page-header"><div class="page-header-left">
            <h1 class="page-title">Integrations</h1>
            <p class="page-subtitle">Connect event sources to Sokuza</p>
        </div></div>
        <div class="card-grid card-grid-3">
            ${defs.map((d) => {
        const s = integrations[d.key];
        const on = !!s?.enabled;
        return `<div class="card integration-card" style="flex-direction:column;align-items:stretch">
                    <div style="display:flex;align-items:center;gap:16px">
                        <div class="integration-icon ${d.key}">${d.icon}</div>
                        <div class="integration-info">
                            <div class="integration-name">${d.name}</div>
                            <div class="integration-desc">${d.desc}</div>
                            <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                ${on ? `<span class="badge badge-success">Active</span><span style="font-size:11px;color:var(--text-muted)">${s.events.length} events</span>` : '<span class="badge badge-warning">Not configured</span>'}
                            </div>
                        </div>
                    </div>
                    ${on ? `
                        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color)">
                            ${d.endpoint !== '—' ? `
                            <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Webhook Endpoint</div>
                            <code style="font-size:12px;color:var(--accent-hover);background:rgba(99,102,241,0.08);padding:4px 8px;border-radius:4px;display:inline-block">${d.endpoint}</code>
                            ` : ''}
                            <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;text-transform:uppercase;letter-spacing:0.4px">Supported Events</div>
                            <div class="event-tags">${s.events.map(e => `<span class="event-tag">${esc(e)}</span>`).join('')}</div>
                            <div style="margin-top:10px">
                                <button class="btn btn-ghost btn-sm" onclick="openIntegrationSetup('${d.key}')">⚙ Configure</button>
                            </div>
                        </div>
                    ` : `
                        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);display:flex;align-items:center;gap:12px">
                            <button class="btn btn-primary btn-sm" onclick="openIntegrationSetup('${d.key}')">Enable ${d.name.split(' ')[0]}</button>
                            <span style="font-size:12px;color:var(--text-muted)">Setup wizard</span>
                        </div>
                    `}
                </div>`;
    }).join('')}
        </div>

        <div style="margin-top:32px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
                <div>
                    <h2 style="font-size:18px;font-weight:600">AI Providers</h2>
                    <p style="font-size:13px;color:var(--text-secondary);margin-top:4px">Pick which model powers your AI actions. Keys are stored in <code>~/.sokuza/config.yaml</code>.</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    ${aiProviders.length > 0 ? `
                    <label style="font-size:12px;color:var(--text-secondary)">Default:</label>
                    <select class="form-input" id="ai-default-select" style="width:auto;min-width:160px;padding:6px 10px;font-size:13px" onchange="setDefaultProvider(this.value)">
                        ${aiProviders.map(p => `<option value="${esc(p.name)}" ${p.name === defaultProvider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                    </select>` : ''}
                    <button class="btn btn-primary btn-sm" onclick="openAiProviderAdd()">+ Add Provider</button>
                    <button class="btn btn-ghost btn-sm" onclick="openAiTestModal()">🧪 Test</button>
                </div>
            </div>
            <div class="card-grid card-grid-3">
                ${aiProviders.length > 0 ? aiProviders.map(p => renderProviderCard(p, cliStatus)).join('') : `
                    <div class="empty-state" style="grid-column:1/-1">
                        <div class="empty-icon">🤖</div>
                        <p class="empty-text">No AI providers configured</p>
                        <p style="font-size:12px;color:var(--text-muted);margin-top:6px">Click <strong>Add Provider</strong> to set one up — ZAI GLM, Anthropic, Claude Code, Opencode, or custom.</p>
                    </div>`}
            </div>
        </div>
    `;
}

// ─── AI Provider cards & CRUD modal ────────────────────────────────────────

const PROVIDER_PRESETS = [
    {
        id: 'anthropic', label: 'Anthropic', icon: '🟣',
        desc: 'Official Anthropic API (Claude models)',
        entry: { name: 'anthropic', kind: 'anthropic-api', default_model: 'claude-sonnet-4-6' },
        needsKey: true,
    },
    {
        id: 'zai-glm', label: 'ZAI GLM (API)', icon: '🅾',
        desc: 'ZAI GLM via its Anthropic-compatible API — works with the ZAI Coding Plan.',
        entry: {
            name: 'zai-glm', kind: 'anthropic-api',
            base_url: 'https://api.z.ai/api/anthropic',
            default_model: 'glm-5.1',
        },
        needsKey: true,
    },
    {
        id: 'zai-glm-agent', label: 'ZAI GLM (via Claude Code)', icon: '🅾',
        desc: 'Route Claude Code CLI through ZAI GLM — enables agentic workflows',
        entry: {
            name: 'zai-glm-agent', kind: 'cli', command: 'claude', args_style: 'claude-code',
            default_model: 'glm-5.1',
        },
        needsKey: true, envKey: 'ANTHROPIC_AUTH_TOKEN',
        envExtra: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    },
    {
        id: 'openai', label: 'OpenAI / Compatible', icon: '🟢',
        desc: 'OpenAI, OpenRouter, Groq, Ollama, LM Studio — any /v1/chat/completions endpoint. Requires an API key for that service.',
        entry: {
            name: 'openai', kind: 'openai-compatible-api',
            base_url: 'https://api.openai.com/v1',
            default_model: 'gpt-4o-mini',
        },
        needsKey: true, editableBaseUrl: true,
    },
    {
        id: 'claude-code', label: 'Claude Code CLI', icon: '🟨',
        desc: 'Uses the `claude` CLI on your PATH (no API key needed)',
        entry: { name: 'claude-code', kind: 'cli', command: 'claude', args_style: 'claude-code', default_model: 'sonnet' },
        needsKey: false,
    },
    {
        id: 'opencode', label: 'Opencode CLI', icon: '📡',
        desc: 'Opencode binary — model must be "provider/model" (e.g. zai-coding-plan/glm-5.1). Configure credentials with `opencode providers`.',
        entry: { name: 'opencode', kind: 'cli', command: 'opencode', args_style: 'opencode', default_model: 'zai-coding-plan/glm-5.1' },
        needsKey: false,
    },
];

function providerKindLabel(kind) {
    return ({
        'anthropic-api': 'Anthropic API',
        'openai-compatible-api': 'OpenAI-compatible API',
        'cli': 'CLI',
    })[kind] || kind || '—';
}

function renderProviderCard(p, cliStatus) {
    const isDefault = false; // visual marker only; real default is on the dropdown
    const keyBadge = p.kind === 'cli' ? '' :
        p.key_status === 'plaintext' ? '<span class="badge badge-success" style="font-size:10px">Key set</span>' :
        p.key_status === 'env-var' ? '<span class="badge" style="font-size:10px;background:rgba(99,102,241,0.15);color:var(--accent-hover)">env var</span>' :
        '<span class="badge badge-warning" style="font-size:10px">No key</span>';
    const cliBadge = p.kind === 'cli'
        ? (p.cli_installed
            ? `<span class="badge badge-success" style="font-size:10px">${esc(p.command)} installed</span>`
            : `<span class="badge badge-warning" style="font-size:10px">${esc(p.command)} not found</span>`)
        : '';
    const builtinNote = p.is_builtin ? '<span class="badge" style="font-size:10px;background:rgba(148,163,184,0.15);color:var(--text-secondary)">built-in</span>' : '';

    return `<div class="card" style="flex-direction:column;gap:8px;align-items:stretch">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:14px">${esc(p.name)}</strong>
            ${builtinNote}
            ${keyBadge}
            ${cliBadge}
        </div>
        <div style="font-size:12px;color:var(--text-secondary)">
            <div>Kind: <code>${esc(providerKindLabel(p.kind))}</code></div>
            ${p.default_model ? `<div>Model: <code>${esc(p.default_model)}</code></div>` : ''}
            ${p.command ? `<div>Command: <code>${esc(p.command)}</code></div>` : ''}
            ${p.base_url ? `<div>Base URL: <code style="font-size:11px">${esc(p.base_url)}</code></div>` : ''}
            ${p.api_key_masked ? `<div>Key: <code style="font-size:11px">${esc(p.api_key_masked)}</code></div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
            <button class="btn btn-ghost btn-sm" onclick="openAiProviderEdit('${esc(p.name)}')">Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="testOneProvider('${esc(p.name)}')">Test</button>
            ${p.is_builtin ? '' : `<button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="deleteAiProvider('${esc(p.name)}')">Delete</button>`}
        </div>
    </div>`;
}

window.setDefaultProvider = async function (name) {
    try {
        await api.post('/api/ai/default', { provider: name });
        toast(`Default provider set to "${name}"`);
        if (currentPage === 'integrations') await renderIntegrations(document.getElementById('content'));
    } catch (err) {
        toast('Failed to set default: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.deleteAiProvider = async function (name) {
    if (!confirm(`Delete provider "${name}"? This cannot be undone.`)) return;
    try {
        await api.del('/api/ai/providers/' + encodeURIComponent(name));
        toast(`Provider "${name}" deleted`);
        if (currentPage === 'integrations') await renderIntegrations(document.getElementById('content'));
    } catch (err) {
        toast('Failed to delete: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.testOneProvider = async function (name) {
    openModal('Test "' + name + '"', `
        <div class="form-group">
            <label class="form-label">Prompt</label>
            <input type="text" class="form-input" id="ai-test-prompt" value="Reply with exactly: OK">
            <input type="hidden" id="ai-test-provider" value="${esc(name)}">
        </div>
        <div id="ai-test-result" style="margin-top:12px"></div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" id="ai-test-run-btn" onclick="runAiTest()">Run Test</button>
    `);
};

window.openAiProviderAdd = function () {
    openAiProviderModal(null);
};

window.openAiProviderEdit = async function (name) {
    try {
        const data = await api.get('/api/ai/providers');
        const provider = (data.providers || []).find(p => p.name === name);
        if (!provider) { toast('Provider not found', 'error'); return; }
        openAiProviderModal(provider);
    } catch (err) {
        toast('Failed to load provider: ' + (err.message || 'Unknown error'), 'error');
    }
};

function openAiProviderModal(existing) {
    const isEdit = !!existing;
    const presets = PROVIDER_PRESETS;
    const presetCards = isEdit ? '' : `
        <div class="panel" style="margin-bottom:16px">
            <div class="panel-header"><span class="panel-title">Quick start</span></div>
            <div class="panel-body">
                <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
                    ${presets.map(p => `
                        <button type="button" class="card" style="text-align:left;padding:10px;cursor:pointer;border:1px solid var(--border-color);background:var(--bg-secondary);flex-direction:column;align-items:flex-start;gap:2px" onclick="applyProviderPreset('${p.id}')">
                            <div style="display:flex;align-items:center;gap:8px">
                                <span style="font-size:18px">${p.icon}</span>
                                <strong style="font-size:13px">${esc(p.label)}</strong>
                            </div>
                            <div style="font-size:11px;color:var(--text-secondary)">${esc(p.desc)}</div>
                        </button>
                    `).join('')}
                </div>
                <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">Presets pre-fill the form — you can still tweak any field before saving.</div>
            </div>
        </div>`;

    const init = existing || { name: '', kind: 'anthropic-api' };

    const existingName = existing?.name;
    openModal(isEdit ? `Edit "${existing.name}"` : 'Add AI Provider', `
        ${presetCards}
        <div class="panel">
            <div class="panel-header"><span class="panel-title">Provider details</span></div>
            <div class="panel-body">
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input type="text" class="form-input" id="ap-name" value="${esc(init.name || '')}" placeholder="e.g. zai-glm" ${isEdit ? 'disabled' : ''}>
                    <div class="form-hint">Lowercase identifier used to reference this provider from workflows.</div>
                </div>
                <div class="form-group">
                    <label class="form-label">Kind</label>
                    <select class="form-input" id="ap-kind" onchange="onAiProviderKindChange()">
                        <option value="anthropic-api" ${init.kind === 'anthropic-api' ? 'selected' : ''}>Anthropic API (Claude / ZAI / Moonshot)</option>
                        <option value="openai-compatible-api" ${init.kind === 'openai-compatible-api' ? 'selected' : ''}>OpenAI-compatible API</option>
                        <option value="cli" ${init.kind === 'cli' ? 'selected' : ''}>CLI (claude / opencode)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Default model</label>
                    <input type="text" class="form-input" id="ap-model" list="ap-model-list" value="${esc(init.default_model || '')}" placeholder="Start typing or pick from the list…">
                    <datalist id="ap-model-list"></datalist>
                    <div class="form-hint" id="ap-model-hint">Model suggestions load when you pick a kind, command, or base URL.</div>
                </div>

                <div id="ap-api-fields" style="display:none">
                    <div class="form-group">
                        <label class="form-label">Base URL <span style="color:var(--text-muted);font-weight:400">(optional for Anthropic, required for OpenAI-compatible)</span></label>
                        <input type="text" class="form-input" id="ap-base-url" value="${esc(init.base_url || '')}" placeholder="https://api.openai.com/v1">
                    </div>
                    <div class="form-group">
                        <label class="form-label">API key</label>
                        <input type="password" class="form-input" id="ap-api-key" value="" placeholder="${isEdit && init.key_status === 'plaintext' ? '(leave blank to keep existing key)' : 'sk-…'}">
                        <div class="form-hint">Stored in <code>~/.sokuza/config.yaml</code> (chmod 0600). Prefix with <code>\${VAR}</code> to use an env var instead.</div>
                    </div>
                </div>

                <div id="ap-cli-fields" style="display:none">
                    <div class="form-group">
                        <label class="form-label">Command</label>
                        <input type="text" class="form-input" id="ap-command" value="${esc(init.command || 'claude')}" placeholder="claude">
                        <div class="form-hint">Must be on PATH. Sokuza spawns this binary per AI action.</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Args style</label>
                        <select class="form-input" id="ap-args-style">
                            <option value="claude-code" ${init.args_style === 'claude-code' ? 'selected' : ''}>claude-code (--print --model …)</option>
                            <option value="opencode" ${init.args_style === 'opencode' ? 'selected' : ''}>opencode (run --model …)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Env vars <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
                        <textarea class="form-input" id="ap-env" rows="3" placeholder="KEY=value\nANOTHER_KEY=value">${esc(serializeEnvBag(init.env))}</textarea>
                        <div class="form-hint">One per line. Useful for redirecting Claude Code to ZAI GLM (<code>ANTHROPIC_BASE_URL</code> + <code>ANTHROPIC_AUTH_TOKEN</code>).</div>
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAiProvider(${isEdit ? 'true' : 'false'})">${isEdit ? 'Save' : 'Add Provider'}</button>
    `);

    // onAiProviderKindChange() both toggles field visibility and attaches
    // the input listeners that drive `refreshModelSuggestions`.
    onAiProviderKindChange();

    // Kick off an initial model-list fetch based on whatever values the
    // modal opened with (preset defaults or the existing entry). For
    // existing providers, pass the name so the backend can use the
    // saved api_key without it bouncing through the browser.
    refreshModelSuggestions(existingName);
}

let __modelRefreshToken = 0;
async function refreshModelSuggestions(existingName) {
    const token = ++__modelRefreshToken;
    const datalist = document.getElementById('ap-model-list');
    const hint = document.getElementById('ap-model-hint');
    if (!datalist) return;

    const kind = document.getElementById('ap-kind')?.value;
    const command = document.getElementById('ap-command')?.value;
    const baseUrl = document.getElementById('ap-base-url')?.value;
    const apiKey = document.getElementById('ap-api-key')?.value;
    const env = parseEnvBag(document.getElementById('ap-env')?.value || '');

    if (!kind) return;

    if (hint) hint.textContent = 'Loading model suggestions…';

    const body = existingName
        ? { name: existingName }
        : {
            kind, command,
            base_url: baseUrl,
            api_key: apiKey || undefined,
            env: Object.keys(env).length > 0 ? env : undefined,
        };

    try {
        const res = await api.post('/api/ai/models', body);
        if (token !== __modelRefreshToken) return; // stale response
        const models = Array.isArray(res.models) ? res.models : [];
        datalist.innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
        if (hint) {
            if (res.source === 'live') {
                hint.textContent = `${models.length} models loaded live from the provider.`;
            } else if (res.source === 'hardcoded') {
                hint.textContent = res.note || `Showing ${models.length} common model IDs. You can type any value.`;
            } else {
                hint.textContent = 'No suggestions — type any model ID that your provider accepts.';
            }
        }
    } catch (err) {
        if (token !== __modelRefreshToken) return;
        if (hint) hint.textContent = 'Could not load model list — you can still type a custom value.';
    }
}

function serializeEnvBag(env) {
    if (!env || typeof env !== 'object') return '';
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

function parseEnvBag(raw) {
    const out = {};
    if (!raw) return out;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

window.onAiProviderKindChange = function () {
    const kind = document.getElementById('ap-kind')?.value;
    const apiBox = document.getElementById('ap-api-fields');
    const cliBox = document.getElementById('ap-cli-fields');
    if (!apiBox || !cliBox) return;
    if (kind === 'cli') {
        apiBox.style.display = 'none';
        cliBox.style.display = 'block';
    } else {
        apiBox.style.display = 'block';
        cliBox.style.display = 'none';
    }
    // Re-bind the inputs that just became visible so they refresh the
    // model suggestions as the user types.
    ['ap-kind', 'ap-command', 'ap-base-url', 'ap-env'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.modelHookBound === '1') return;
        const ev = el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(ev, () => refreshModelSuggestions(null));
        el.dataset.modelHookBound = '1';
    });
};

window.applyProviderPreset = function (presetId) {
    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    const e = preset.entry;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };

    set('ap-name', e.name);
    set('ap-kind', e.kind);
    set('ap-model', e.default_model || '');
    onAiProviderKindChange();

    if (e.kind === 'cli') {
        set('ap-command', e.command || 'claude');
        set('ap-args-style', e.args_style || 'claude-code');
        if (preset.envExtra) {
            set('ap-env', serializeEnvBag(preset.envExtra) +
                (preset.envKey ? `\n${preset.envKey}=` : ''));
        } else {
            set('ap-env', '');
        }
    } else {
        set('ap-base-url', e.base_url || '');
        set('ap-api-key', '');
    }

    refreshModelSuggestions(null);
    toast(`Preset "${preset.label}" applied — fill in your API key and click save.`);
};

window.submitAiProvider = async function (isEdit) {
    const name = document.getElementById('ap-name')?.value.trim();
    const kind = document.getElementById('ap-kind')?.value;
    const model = document.getElementById('ap-model')?.value.trim();
    if (!name) { toast('Name is required', 'error'); return; }
    if (!kind) { toast('Kind is required', 'error'); return; }

    const body = { name, kind };
    if (model) body.default_model = model;

    if (kind === 'cli') {
        body.command = document.getElementById('ap-command')?.value.trim() || 'claude';
        body.args_style = document.getElementById('ap-args-style')?.value || 'claude-code';
        const envBag = parseEnvBag(document.getElementById('ap-env')?.value || '');
        if (Object.keys(envBag).length > 0) body.env = envBag;
    } else {
        const baseUrl = document.getElementById('ap-base-url')?.value.trim();
        if (baseUrl) body.base_url = baseUrl;
        const apiKey = document.getElementById('ap-api-key')?.value;
        if (apiKey) body.api_key = apiKey;
    }

    try {
        if (isEdit) {
            // Server preserves the existing api_key when the body omits one,
            // so we just pass the field through only when the user actually
            // typed a new value.
            await api.put('/api/ai/providers/' + encodeURIComponent(name), body);
            toast(`Provider "${name}" updated`);
        } else {
            await api.post('/api/ai/providers', body);
            toast(`Provider "${name}" added`);
        }
        closeModal();
        if (currentPage === 'integrations') await renderIntegrations(document.getElementById('content'));
    } catch (err) {
        toast('Failed to save: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ─── Integration Setup Modal ────────────────────────────────────────────────
const integrationDefs = {
    'github': {
        name: 'GitHub (Webhooks)', fields: [
            { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', env: 'GITHUB_WEBHOOK_SECRET', hint: 'Create a webhook in GitHub → Settings → Webhooks. Set this to the secret value.' },
            { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token with repo scope (Settings → Developer → PATs).' },
        ], guide: '1. Go to your repo → Settings → Webhooks → Add webhook\n2. Set Payload URL to your Sokuza URL + /webhooks/github\n3. Set Content type to application/json\n4. Set a Secret and paste it above\n5. Select events you want to receive'
    },
    'github-poll': {
        name: 'GitHub (Polling)', fields: [
            { key: 'token', label: 'Access Token', type: 'password', env: 'GITHUB_TOKEN', hint: 'Personal access token with repo scope.' },
            { key: 'repos', label: 'Repositories to monitor', type: 'text', hint: 'Comma-separated owner/repo format. E.g: Tjemmic/my-app, org/other-repo' },
            { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'How often to check for changes. Default: 60. Min recommended: 30.' },
        ], guide: 'No webhook setup needed! Polling checks GitHub APIs on a timer.\n\n1. Create a Personal Access Token at github.com/settings/tokens\n2. Enter repos to monitor\n3. Set the check interval'
    },
    'slack': {
        name: 'Slack', fields: [
            { key: 'signingSecret', label: 'Signing Secret', type: 'password', hint: 'From api.slack.com → Your App → Basic Information → Signing Secret' },
            { key: 'botToken', label: 'Bot Token', type: 'password', hint: 'xoxb-... from OAuth & Permissions page' },
        ], guide: '1. Create a Slack App at api.slack.com/apps\n2. Enable Event Subscriptions and point to your Sokuza URL\n3. Install the app to your workspace'
    },
    'webhook': {
        name: 'Generic Webhook', fields: [
            { key: 'secret', label: 'HMAC Secret (optional)', type: 'password', hint: 'If set, incoming requests must include a valid HMAC signature.' },
        ], guide: 'POST JSON to /webhooks/custom/your-name to trigger workflows.\nThe request body becomes the event payload.'
    },
    'gh-cli': {
        name: 'GitHub (gh CLI)', fields: [
            { key: 'interval', label: 'Poll Interval (seconds)', type: 'number', hint: 'How often to check for PR updates. Default: 60. Min recommended: 30.' },
        ], guide: 'Zero-config GitHub integration using the gh CLI.\n\n1. Install gh CLI: https://cli.github.com/\n2. Run: gh auth login\n3. Enable this integration — Sokuza will auto-detect your auth and poll your PRs'
    },
    'cron': { name: 'Cron', fields: [], guide: 'Cron triggers are configured per-workflow using cron expressions.\nNo integration-level config needed — just enable it.' },
};

window.openIntegrationSetup = function (key) {
    const def = integrationDefs[key];
    if (!def) return;

    const formFields = def.fields.map(f => `
        <div class="form-group">
            <label class="form-label">${esc(f.label)} ${f.env ? `<code style="font-size:10px;color:var(--text-muted);margin-left:6px">\${${f.env}}</code>` : ''}</label>
            <input type="${f.type || 'text'}" class="form-input" id="integ-${f.key}" placeholder="${esc(f.hint || '')}">
            ${f.hint ? `<div class="form-hint">${esc(f.hint)}</div>` : ''}
        </div>
    `).join('');

    const guideSteps = def.guide.split('\n').filter(l => l.trim()).map(l => `<p style="margin:2px 0">${esc(l)}</p>`).join('');

    openModal(`Setup: ${def.name}`, `
        <div class="editor-layout">
            <div>
                ${def.fields.length > 0 ? `
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Configuration</span></div>
                    <div class="panel-body">
                        ${formFields}
                        <div style="margin-top:12px;padding:10px;background:rgba(99,102,241,0.06);border-radius:var(--radius-sm);font-size:12px;color:var(--text-secondary)">
                            💡 <strong>Tip:</strong> Use environment variables (like <code>\${GITHUB_TOKEN}</code>) for secrets. Add them to your <code>.env</code> file.
                        </div>
                    </div>
                </div>
                ` : ''}
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Generated Config</span></div>
                    <div class="panel-body" style="padding:0">
                        <pre class="yaml-preview" id="integ-preview" style="min-height:60px"></pre>
                    </div>
                </div>
            </div>
            <div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Setup Guide</span></div>
                    <div class="panel-body" style="font-size:13px;color:var(--text-secondary);line-height:1.7">
                        ${guideSteps}
                    </div>
                </div>
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-ghost" onclick="copyIntegrationConfig('${key}')">📋 Copy YAML</button>
        <button class="btn btn-primary" onclick="applyIntegrationConfig('${key}')">Apply to Config</button>
    `);

    // Generate initial preview
    updateIntegrationPreview(key);

    // Live preview on input
    def.fields.forEach(f => {
        const el = $(`#integ-${f.key}`);
        if (el) el.addEventListener('input', () => updateIntegrationPreview(key));
    });
};

function updateIntegrationPreview(key) {
    const pre = $('#integ-preview');
    if (!pre) return;
    const def = integrationDefs[key];
    let yaml = `${key}:\n`;
    for (const f of def.fields) {
        const el = $(`#integ-${f.key}`);
        const val = el?.value || (f.env ? `\${${f.env}}` : '');
        if (f.key === 'repos' && val) {
            yaml += `  repos:\n`;
            val.split(',').map(r => r.trim()).filter(Boolean).forEach(r => { yaml += `    - ${r}\n`; });
        } else if (val) {
            yaml += `  ${f.key}: ${val}\n`;
        }
    }
    pre.textContent = yaml;
}

window.copyIntegrationConfig = function (key) {
    const pre = $('#integ-preview');
    if (pre) {
        navigator.clipboard.writeText(pre.textContent);
        toast('Config YAML copied to clipboard');
    }
};

window.applyIntegrationConfig = async function (key) {
    try {
        // Get current config
        const configData = await api.get('/api/config');
        let configYaml = configData.raw || configData.yaml || '';

        // Generate the integration config text
        const pre = $('#integ-preview');
        const integConfig = pre?.textContent || '';

        // Check if integration already in config
        if (configYaml.includes(`${key}:`)) {
            toast(`"${key}" already exists in config. Edit it in Settings.`, 'error');
            return;
        }

        // Insert under integrations section
        const insertIdx = configYaml.indexOf('integrations:');
        if (insertIdx === -1) {
            configYaml += `\nintegrations:\n  ${integConfig.split('\n').join('\n  ')}`;
        } else {
            // Find the end of "integrations:" line and add after
            const lineEnd = configYaml.indexOf('\n', insertIdx);
            configYaml = configYaml.slice(0, lineEnd + 1) + `  ${integConfig.split('\n').join('\n  ')}` + configYaml.slice(lineEnd + 1);
        }

        await api.put('/api/config', { __raw_yaml: configYaml });
        toast(`${integrationDefs[key]?.name || key} added to config! Restart Sokuza to activate.`);
        closeModal();
        navigate('integrations');
    } catch (err) {
        toast('Failed to apply config: ' + (err.message || 'Unknown error'), 'error');
    }
};

window.openAiTestModal = async function () {
    const cfgData = await api.get('/api/config');
    const providers = Object.keys(cfgData.config?.ai?.providers || {});
    if (providers.length === 0) {
        toast('No AI providers configured', 'error');
        return;
    }

    const options = providers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

    openModal('Test AI Provider', `
        <div class="form-group">
            <label class="form-label">Provider</label>
            <select class="form-input" id="ai-test-provider">
                <option value="">Default (${esc(cfgData.config?.ai?.default_provider || 'none')})</option>
                ${options}
            </select>
        </div>
        <div class="form-group">
            <label class="form-label">Test Prompt</label>
            <input type="text" class="form-input" id="ai-test-prompt" value="Reply with exactly: OK" placeholder="Enter a test prompt">
        </div>
        <div id="ai-test-result" style="margin-top:12px"></div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" id="ai-test-run-btn" onclick="runAiTest()">Run Test</button>
    `);
};

window.runAiTest = async function () {
    const provider = $('#ai-test-provider')?.value || undefined;
    const prompt = $('#ai-test-prompt')?.value;
    const resultEl = $('#ai-test-result');
    const btn = $('#ai-test-run-btn');
    if (!prompt || !resultEl || !btn) return;

    btn.disabled = true;
    btn.textContent = '⏳ Testing...';
    resultEl.innerHTML = '<div class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></div> Sending request...';

    try {
        const start = Date.now();
        const result = await api.post('/api/ai/test', { provider, prompt });
        const elapsed = Date.now() - start;

        if (result.ok) {
            resultEl.innerHTML = `
                <div style="padding:12px;border-radius:8px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);margin-bottom:12px">
                    <div style="font-weight:600;color:#22c55e;margin-bottom:8px">✓ Success</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
                        <div>Provider: <strong>${esc(result.provider)}</strong></div>
                        <div>Model: <strong>${esc(result.model || '—')}</strong></div>
                        <div>Duration: <strong>${result.durationMs}ms</strong> (round-trip: ${elapsed}ms)</div>
                        <div>Tokens: <strong>${result.usage ? `${result.usage.input_tokens || '?'}/${result.usage.output_tokens || '?'}` : 'N/A'}</strong></div>
                    </div>
                </div>
                <div style="padding:10px;border-radius:6px;background:var(--bg-primary);font-size:12px;font-family:var(--mono);white-space:pre-wrap;max-height:200px;overflow-y:auto">${esc(result.response || '(empty response)')}</div>
            `;
        } else {
            resultEl.innerHTML = `
                <div style="padding:12px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3)">
                    <div style="font-weight:600;color:#ef4444;margin-bottom:4px">✗ Failed</div>
                    <div style="font-size:12px">Provider: <strong>${esc(result.provider || 'unknown')}</strong></div>
                    <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${esc(result.error || 'Unknown error')}</div>
                </div>
            `;
        }
    } catch (err) {
        resultEl.innerHTML = `<div style="padding:12px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:13px">${esc(err.message || 'Request failed')}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Run Test';
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// EVENT LOG
// ═════════════════════════════════════════════════════════════════════════════
let eventFilter = { source: '', search: '' };
let eventsTab = 'events'; // 'events' | 'deliveries' | 'preview'

async function renderEvents(el) {
    const [evtData, statsData, delivData] = await Promise.all([api.get('/api/events'), api.get('/api/events/stats'), api.get('/api/webhooks/deliveries').catch(() => ({ deliveries: [] }))]);
    events = evtData.events || [];
    eventStats = statsData;
    const deliveries = delivData.deliveries || [];

    const filtered = filterEvents(events);
    const sourceEntries = Object.entries(eventStats.bySource || {}).sort((a, b) => b[1] - a[1]);
    const workflowEntries = Object.entries(eventStats.byWorkflow || {}).sort((a, b) => b[1] - a[1]);
    const eventEntries = Object.entries(eventStats.byEvent || {}).sort((a, b) => b[1] - a[1]);

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Event Log</h1>
                <p class="page-subtitle">Real-time stream with history — ${events.length} events tracked</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <button class="btn btn-ghost btn-sm" onclick="exportEvents()">📥 Export JSON</button>
                <div class="status-dot online"></div>
                <span style="font-size:12px;color:var(--text-muted)">Live</span>
            </div>
        </div>

        <div class="card-grid" style="grid-template-columns:repeat(4,1fr)">
            <div class="card card-stat">
                <div class="stat-value">${eventStats.total ?? 0}</div>
                <div class="stat-label">Total Events</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${eventStats.lastHour ?? 0}</div>
                <div class="stat-label">Last Hour</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${sourceEntries.length}</div>
                <div class="stat-label">Sources</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${workflowEntries.length}</div>
                <div class="stat-label">Triggered Workflows</div>
            </div>
        </div>

        <div class="filter-bar" style="margin-bottom:14px">
            <button class="btn ${eventsTab === 'events' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="eventsTab='events';renderPage()">Events</button>
            <button class="btn ${eventsTab === 'deliveries' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="eventsTab='deliveries';renderPage()">Webhook Deliveries (${deliveries.length})</button>
            <button class="btn ${eventsTab === 'preview' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="eventsTab='preview';renderPage()">Preview Event</button>
        </div>

        ${eventsTab === 'deliveries' ? renderDeliveriesTab(deliveries) : ''}
        ${eventsTab === 'preview' ? renderPreviewTab() : ''}
        ${eventsTab === 'events' ? `
        <div class="editor-layout" style="grid-template-columns:1fr 300px">
            <div>
                ${eventStats.hourlyBuckets ? `<div class="card" style="margin-bottom:16px;padding:16px 18px">
                    <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.4px">Activity (24h)</div>
                    ${renderBarChart(eventStats.hourlyBuckets)}
                </div>` : ''}

                <div class="filter-bar" style="margin-bottom:14px">
                    <select class="form-select" onchange="eventFilter.source=this.value;rerenderEventList()" style="width:140px">
                        <option value="">All sources</option>
                        ${sourceEntries.map(([s]) => `<option value="${esc(s)}" ${eventFilter.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                    </select>
                    <input type="text" class="form-input" placeholder="Search events..." value="${esc(eventFilter.search)}" oninput="eventFilter.search=this.value;rerenderEventList()" style="flex:1">
                    ${events.length > 0 ? `<button class="btn btn-ghost btn-sm" onclick="eventFilter={source:'',search:''};renderPage()">Clear</button>` : ''}
                </div>

                <div id="event-list" style="display:flex;flex-direction:column;gap:6px">
                    ${filtered.length > 0 ? filtered.slice(0, 50).map(renderEventCard).join('') : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events match your filter</p></div>'}
                </div>
            </div>

            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">By Source</span></div>
                    <div class="panel-body">
                        ${sourceEntries.length > 0 ? sourceEntries.map(([s, c]) => `<div class="stat-row" style="cursor:pointer" onclick="eventFilter.source='${esc(s)}';rerenderEventList()"><span class="stat-row-label">${sourceBadge(s)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Top Workflows</span></div>
                    <div class="panel-body">
                        ${workflowEntries.length > 0 ? workflowEntries.slice(0, 8).map(([w, c]) => `<div class="stat-row"><span class="stat-row-label" style="font-size:12px">${esc(w)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Top Events</span></div>
                    <div class="panel-body">
                        ${eventEntries.length > 0 ? eventEntries.slice(0, 8).map(([e, c]) => `<div class="stat-row"><span class="stat-row-label" style="font-size:12px;font-family:var(--mono)">${esc(e)}</span><span class="stat-row-value">${c}</span></div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">No data</div>'}
                    </div>
                </div>
            </div>
        </div>
        ` : ''}
    `;
}

function renderDeliveriesTab(deliveries) {
    if (deliveries.length === 0) {
        return '<div class="empty-state"><div class="empty-icon">📭</div><p class="empty-text">No outbound webhook deliveries yet</p></div>';
    }
    return `<div class="table-wrap"><table>
        <thead><tr><th>Workflow</th><th>URL</th><th>Status</th><th>Duration</th><th>Sent</th></tr></thead>
        <tbody>${deliveries.map(d => {
            const ok = d.statusCode >= 200 && d.statusCode < 300;
            return `<tr>
                <td>${esc(d.workflowName || '—')}</td>
                <td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><code>${esc(d.url || '—')}</code></td>
                <td><span class="badge" style="background:${ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${ok ? '#22c55e' : '#ef4444'};border:1px solid ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'};font-size:11px">${d.statusCode || '—'}</span></td>
                <td style="font-size:12px">${d.durationMs != null ? d.durationMs + 'ms' : '—'}</td>
                <td style="font-size:12px;color:var(--text-muted)">${d.sentAt ? timeAgo(d.sentAt) : '—'}</td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;
}

function renderPreviewTab() {
    return `
        <div class="panel" style="margin-bottom:16px">
            <div class="panel-header"><span class="panel-title">Dry-Run Event Preview</span></div>
            <div class="panel-body">
                <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">Compose a sample event to see which workflows would match and why others wouldn't.</p>
                <div class="form-group">
                    <label class="form-label">Source</label>
                    <input type="text" class="form-input" id="preview-source" value="github" placeholder="e.g. github, slack, gh-cli">
                </div>
                <div class="form-group">
                    <label class="form-label">Event</label>
                    <input type="text" class="form-input" id="preview-event" value="pull_request.opened" placeholder="e.g. pull_request.opened">
                </div>
                <div class="form-group">
                    <label class="form-label">Payload (JSON)</label>
                    <textarea class="form-input" id="preview-payload" rows="6" style="font-family:var(--mono);font-size:12px" placeholder='{"action": "opened", "pull_request": {...}}'>{}</textarea>
                </div>
                <button class="btn btn-primary" onclick="runEventPreview()">Preview Matches</button>
            </div>
        </div>
        <div id="preview-results"></div>
    `;
}

window.runEventPreview = async function () {
    const source = $('#preview-source')?.value;
    const event = $('#preview-event')?.value;
    const payloadStr = $('#preview-payload')?.value;
    const resultsEl = $('#preview-results');
    if (!source || !event || !resultsEl) return;

    let payload;
    try { payload = JSON.parse(payloadStr || '{}'); } catch (e) { toast('Invalid JSON payload: ' + e.message, 'error'); return; }

    resultsEl.innerHTML = '<div class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></div> Running preview...';

    try {
        const result = await api.post('/api/events/preview', { event: { source, event, payload, metadata: {} } });
        const matched = result.matched || [];
        const unmatched = result.unmatched || [];

        resultsEl.innerHTML = `
            ${matched.length > 0 ? `
            <div class="panel" style="margin-bottom:12px;border-color:rgba(34,197,94,0.3)">
                <div class="panel-header"><span class="panel-title" style="color:#22c55e">✓ Matched (${matched.length})</span></div>
                <div class="panel-body">${matched.map(n => `<div style="padding:4px 0;font-size:13px"><strong style="color:#22c55e">${esc(n)}</strong></div>`).join('')}</div>
            </div>` : ''}
            ${unmatched.length > 0 ? `
            <div class="panel" style="border-color:rgba(239,68,68,0.3)">
                <div class="panel-header"><span class="panel-title" style="color:#ef4444">✗ Not Matched (${unmatched.length})</span></div>
                <div class="panel-body">${unmatched.map(u => `<div style="padding:4px 0;font-size:13px"><strong>${esc(u.name)}</strong> <span style="color:var(--text-muted);font-size:11px">— ${esc(u.reason || 'No match')}</span></div>`).join('')}</div>
            </div>` : ''}
            ${matched.length === 0 && unmatched.length === 0 ? '<div style="font-size:13px;color:var(--text-muted)">No workflows configured.</div>' : ''}
        `;
    } catch (err) {
        resultsEl.innerHTML = `<div style="color:#ef4444;font-size:13px">Preview failed: ${esc(err.message)}</div>`;
    }
};

function filterEvents(evts) {
    return evts.filter((e) => {
        if (eventFilter.source && e.event?.source !== eventFilter.source) return false;
        if (eventFilter.search) {
            const s = eventFilter.search.toLowerCase();
            const haystack = `${e.event?.source} ${e.event?.event} ${(e.matchedWorkflows || []).join(' ')} ${JSON.stringify(e.event?.metadata || {})}`.toLowerCase();
            if (!haystack.includes(s)) return false;
        }
        return true;
    });
}

window.rerenderEventList = function () {
    const filtered = filterEvents(events);
    const list = $('#event-list');
    if (list) list.innerHTML = filtered.length > 0
        ? filtered.slice(0, 50).map(renderEventCard).join('')
        : '<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-text">No events match your filter</p></div>';
};

let expandedEvents = new Set();

function renderEventCard(e, idx) {
    const src = e.event?.source ?? 'unknown';
    const meta = e.event?.metadata || {};
    const metaKeys = Object.entries(meta).filter(([k]) => !['deliveryId', 'hookEvent', 'eventId'].includes(k));
    const metaStr = metaKeys.map(([k, v]) => `${k}: ${v}`).join(' · ');
    const eventId = `${e.timestamp}-${src}-${e.event?.event}`;
    const isExpanded = expandedEvents.has(eventId);
    const payload = JSON.stringify(e, null, 2);

    return `<div class="event-entry" onclick="toggleEventPayload('${esc(eventId)}')">
        <span class="event-time">${fmtDateTime(e.timestamp)}</span>
        ${sourceBadge(src)}
        <div class="event-body">
            <div class="event-name">${esc(e.event?.event ?? 'unknown')}</div>
            <div class="event-detail">${e.matchedWorkflows?.length ? `→ ${e.matchedWorkflows.map(w => esc(w)).join(', ')}` : '<span style="color:var(--text-muted)">No workflows matched</span>'}</div>
            ${metaStr ? `<div class="event-detail-meta">${esc(metaStr)}</div>` : ''}
        </div>
        ${e.matchedWorkflows?.length ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px;align-self:center" onclick="event.stopPropagation();replayEvent(${idx})" title="Replay this event">🔄</button>` : ''}
        <span style="font-size:10px;color:var(--text-muted);align-self:center">${isExpanded ? '▼' : '▶'}</span>
        <div class="event-payload ${isExpanded ? 'open' : ''}" id="payload-${esc(eventId)}" onclick="event.stopPropagation()">${esc(payload)}</div>
    </div>`;
}

window.exportEvents = function () {
    const data = JSON.stringify(events, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sokuza-events-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Events exported as JSON');
};

window.replayEvent = async function (idx) {
    const e = events[idx];
    if (!e?.matchedWorkflows?.length) { toast('No workflows to replay', 'error'); return; }
    const wfName = e.matchedWorkflows[0];
    if (!(await confirm(`Replay event to workflow <strong>"${esc(wfName)}"</strong>?`))) return;
    try {
        const result = await api.post(`/api/events/${encodeURIComponent(idx)}/replay`);
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast(`Replayed event → "${wfName}" workflow started`);
        }
    } catch (err) {
        toast('Replay failed: ' + (err.message || 'Unknown'), 'error');
    }
};

window.toggleEventPayload = function (id) {
    if (expandedEvents.has(id)) expandedEvents.delete(id);
    else expandedEvents.add(id);
    const payloadEl = $(`#payload-${CSS.escape(id)}`);
    if (payloadEl) payloadEl.classList.toggle('open');
};

// ─── Bar Chart ──────────────────────────────────────────────────────────────
function renderBarChart(buckets) {
    const max = Math.max(...buckets.map((b) => b.count), 1);
    return `<div class="bar-chart">${buckets.map((b) => `<div class="bar-chart-bar" style="height:${Math.max((b.count / max) * 100, 2)}%" data-label="${b.hour}: ${b.count}"></div>`).join('')}</div>
    <div class="bar-chart-labels">${buckets.filter((_, i) => i % 4 === 0).map((b) => `<span>${b.hour}</span>`).join('')}</div>`;
}

// ─── Modal ──────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml, footerHtml) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-footer').innerHTML = footerHtml || '';
    $('#modal-overlay').classList.add('open');
}

function closeModal() {
    $('#modal-overlay').classList.remove('open');
}

// ─── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
    if (eventSource) eventSource.close();
    if (!dashboardToken) return; // Prompt is already up; connect retries when unlocked.
    // EventSource can't set Authorization headers, so the auth gate accepts
    // the token as a `?t=` query param as a second-class fallback.
    const url = `/api/events/stream?t=${encodeURIComponent(dashboardToken)}`;
    eventSource = new EventSource(url);
    eventSource.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.type === 'connected') {
                const dot = $('#status-dot');
                const txt = $('#status-text');
                if (dot) dot.classList.add('online');
                if (txt) txt.textContent = 'Connected';
                return;
            }
            if (data.type === 'ai-review-run') {
                if (currentPage === 'ai-reviews') {
                    // Coalesce bursts (e.g. label edits emit too) so we
                    // don't refetch on every keystroke.
                    if (aiReviewsRefreshTimer) clearTimeout(aiReviewsRefreshTimer);
                    aiReviewsRefreshTimer = setTimeout(() => {
                        loadAiReviewsStats();
                        loadAiReviewsTable();
                    }, 400);
                }
                return;
            }
            if (data.type === 'address-review-run') {
                if (currentPage === 'auto-fix') {
                    if (autoFixRefreshTimer) clearTimeout(autoFixRefreshTimer);
                    autoFixRefreshTimer = setTimeout(() => {
                        loadAutoFixAddressRuns();
                        loadAutoFixWorkdirs();
                    }, 400);
                }
                return;
            }
            events.unshift(data);
            if (events.length > 500) events.pop();

            // Update event badge
            if (currentPage !== 'events') {
                unseenEventCount++;
                updateEventBadge();
            }

            // Live update event log page
            if (currentPage === 'events') {
                unseenEventCount = 0;
                updateEventBadge();
                const list = $('#event-list');
                if (list) {
                    const empty = list.querySelector('.empty-state');
                    if (empty) empty.remove();
                    list.insertAdjacentHTML('afterbegin', renderEventCard(data));
                }
            }
            // Refresh dashboard stats on new event
            if (currentPage === 'dashboard') {
                if (dashRefreshTimer) clearTimeout(dashRefreshTimer);
                dashRefreshTimer = setTimeout(() => renderPage(), 3000);
            }
        } catch { /* client parse error */ }
    };
    eventSource.onerror = () => {
        const dot = $('#status-dot');
        const txt = $('#status-text');
        if (dot) dot.classList.remove('online');
        if (txt) txt.textContent = 'Reconnecting...';
        // Auto-reconnect after 5 seconds
        eventSource.close();
        setTimeout(() => connectSSE(), 5000);
    };
}

// ─── Data Loading ───────────────────────────────────────────────────────────
async function loadAll() {
    const [wf, tmpl, intg, evt, stats] = await Promise.all([
        api.get('/api/workflows'), api.get('/api/templates'), api.get('/api/integrations'),
        api.get('/api/events'), api.get('/api/events/stats'),
    ]);
    workflows = wf.workflows || [];
    templates = tmpl.templates || [];
    integrations = intg.integrations || {};
    events = evt.events || [];
    eventStats = stats;
    // Load deck and library templates (graceful fallback)
    try { const d = await api.get('/api/deck'); deck = d.deck || []; } catch { deck = []; }
    try { const lt = await api.get('/api/templates/library'); libraryTemplates = lt.templates || []; } catch { libraryTemplates = []; }
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function fmtDateTime(ts) {
    try {
        const d = new Date(ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (isToday) return time;
        return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    } catch { return ts; }
}

function sourceBadge(src) {
    const s = src || 'unknown';
    return `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
}

function esc(s) {
    return (s ?? '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

// Escape a value for a single-quoted JS string that itself sits inside a
// double-quoted HTML attribute, e.g. onclick="fn('${jsEsc(x)}')". esc() is
// wrong here: it encodes ' as &#39;, which the HTML parser decodes back to '
// before the JS engine sees it, letting a crafted value break out of the JS
// string. So escape JS-string metacharacters FIRST (\, ', line terminators),
// then HTML-encode the chars that matter in a double-quoted attribute (& and
// " plus < > defensively). The backslashes introduced by JS-escaping aren't
// HTML-special, so they survive attribute decoding intact.
function jsEsc(s) {
    return (s ?? '').toString()
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
}

window.rerunWorkflow = async function (runId) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        const result = await api.post(`/api/runs/${encodeURIComponent(runId)}/rerun`, {});
        if (result.error) {
            toast(result.error, 'error');
        } else {
            toast('Workflow rerun started');
            // Refresh the workflows page to show the new run
            setTimeout(() => navigate('workflows'), 1000);
        }
    } catch (err) {
        toast('Rerun failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Rerun'; }
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// QUEUE
// ═════════════════════════════════════════════════════════════════════════════
let queueRefreshTimer = null;
let queueStatusFilter = '';

async function renderQueue(el) {
    if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
    await loadQueueData(el);
    queueRefreshTimer = setInterval(() => { if (currentPage === 'queue') loadQueueData(el); }, 5000);
}

async function loadQueueData(el) {
    const data = await api.get('/api/queue');
    const stats = data.stats || {};
    const jobs = data.jobs || [];

    const filtered = queueStatusFilter ? jobs.filter(j => j.status === queueStatusFilter) : jobs;

    const statusCounts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const j of jobs) { if (statusCounts[j.status] !== undefined) statusCounts[j.status]++; }

    function statusBadge(s) {
        const colors = { queued: '#f59e0b', running: '#3b82f6', completed: '#22c55e', failed: '#ef4444' };
        return `<span class="badge" style="background:${colors[s] || '#6b7280'}22;color:${colors[s] || '#6b7280'};border:1px solid ${colors[s] || '#6b7280'}44;font-size:11px">${s}</span>`;
    }

    function fmtDuration(start, end) {
        if (!start) return '—';
        const e = end ? new Date(end) : new Date();
        const ms = e - new Date(start);
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    }

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Queue</h1>
                <p class="page-subtitle">Workflow execution queue</p>
            </div>
        </div>

        <div class="card-grid" style="grid-template-columns:repeat(4,1fr)">
            <div class="card card-stat">
                <div class="stat-value">${statusCounts.queued}</div>
                <div class="stat-label">Queued</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${statusCounts.running}</div>
                <div class="stat-label">Running</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${statusCounts.completed}</div>
                <div class="stat-label">Completed</div>
            </div>
            <div class="card card-stat">
                <div class="stat-value">${statusCounts.failed}</div>
                <div class="stat-label">Failed</div>
            </div>
        </div>

        <div class="filter-bar" style="margin-bottom:14px">
            <button class="btn ${!queueStatusFilter ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="queueStatusFilter='';renderPage()">All (${jobs.length})</button>
            <button class="btn ${queueStatusFilter === 'queued' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="queueStatusFilter='queued';renderPage()">Queued (${statusCounts.queued})</button>
            <button class="btn ${queueStatusFilter === 'running' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="queueStatusFilter='running';renderPage()">Running (${statusCounts.running})</button>
            <button class="btn ${queueStatusFilter === 'completed' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="queueStatusFilter='completed';renderPage()">Completed (${statusCounts.completed})</button>
            <button class="btn ${queueStatusFilter === 'failed' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="queueStatusFilter='failed';renderPage()">Failed (${statusCounts.failed})</button>
        </div>

        ${filtered.length > 0 ? `<div class="table-wrap"><table>
            <thead><tr><th>Workflow</th><th>Status</th><th>Duration</th><th>Enqueued</th><th>Error</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>${filtered.map(j => `<tr>
                <td><strong>${esc(j.workflowName || j.workflowSnapshot?.name || '—')}</strong></td>
                <td>${statusBadge(j.status)}</td>
                <td style="font-size:12px">${fmtDuration(j.startedAt, j.completedAt)}</td>
                <td style="font-size:12px;color:var(--text-muted)">${timeAgo(j.enqueuedAt)}</td>
                <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${j.error ? '#ef4444' : 'var(--text-muted)'}">${j.error ? esc(j.error) : '—'}</td>
                <td style="text-align:right">
                    <div class="btn-group" style="justify-content:flex-end">
                        ${j.status === 'queued' || j.status === 'running' ? `<button class="btn btn-danger-outline btn-sm" onclick="cancelQueueJob('${esc(j.id)}')">Cancel</button>` : ''}
                        ${j.status === 'failed' ? `<button class="btn btn-ghost btn-sm" onclick="retryQueueJob('${esc(j.id)}')">Retry</button>` : ''}
                        ${j.status === 'completed' ? `<button class="btn btn-ghost btn-sm" onclick="rerunWorkflow('${esc(j.id)}')">Rerun</button>` : ''}
                    </div>
                </td>
            </tr>`).join('')}</tbody>
        </table></div>` : `<div class="empty-state"><div class="empty-icon">📋</div><p class="empty-text">${queueStatusFilter ? 'No ' + queueStatusFilter + ' jobs' : 'Queue is empty'}</p></div>`}
    `;
}

window.cancelQueueJob = async function (jobId) {
    if (!(await confirm('Cancel this job?'))) return;
    try {
        const result = await api.post(`/api/queue/jobs/${encodeURIComponent(jobId)}/cancel`);
        if (result.error) { toast(result.error, 'error'); return; }
        toast('Job cancelled');
        renderPage();
    } catch (err) { toast('Cancel failed: ' + err.message, 'error'); }
};

window.retryQueueJob = async function (jobId) {
    try {
        const result = await api.post(`/api/queue/jobs/${encodeURIComponent(jobId)}/retry`);
        if (result.error) { toast(result.error, 'error'); return; }
        toast('Job retried');
        renderPage();
    } catch (err) { toast('Retry failed: ' + err.message, 'error'); }
};

// ═════════════════════════════════════════════════════════════════════════════
// LOGS
// ═════════════════════════════════════════════════════════════════════════════
let logSource = null;
let logLevelFilter = '';
let logPaused = false;
let logBuffer = [];

async function renderLogs(el) {
    if (logSource) { logSource.close(); logSource = null; }
    logBuffer = [];

    const data = await api.get('/api/logs');
    const initial = data.logs || [];
    logBuffer = initial;

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Logs</h1>
                <p class="page-subtitle">Real-time application log stream</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost btn-sm" id="log-pause-btn" onclick="toggleLogPause()">${logPaused ? '▶ Resume' : '⏸ Pause'}</button>
                <button class="btn btn-ghost btn-sm" onclick="clearLogBuffer()">🗑 Clear</button>
            </div>
        </div>

        <div class="filter-bar" style="margin-bottom:10px">
            <button class="btn ${!logLevelFilter ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="logLevelFilter='';renderLogsBuffer()">All</button>
            <button class="btn ${logLevelFilter === 'debug' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="logLevelFilter='debug';renderLogsBuffer()">Debug</button>
            <button class="btn ${logLevelFilter === 'info' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="logLevelFilter='info';renderLogsBuffer()">Info</button>
            <button class="btn ${logLevelFilter === 'warn' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="logLevelFilter='warn';renderLogsBuffer()">Warn</button>
            <button class="btn ${logLevelFilter === 'error' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="logLevelFilter='error';renderLogsBuffer()">Error</button>
            <div class="status-dot online" style="margin-left:8px"></div>
            <span style="font-size:12px;color:var(--text-muted)" id="log-status-text">Live</span>
        </div>

        <div id="log-viewer" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.6;max-height:70vh;overflow-y:auto;scroll-behavior:smooth">
        </div>
    `;

    renderLogsBuffer();

    logSource = new EventSource('/api/logs/stream');
    logSource.onmessage = (msg) => {
        try {
            const entry = JSON.parse(msg.data);
            if (entry.type === 'connected') return;
            if (!logPaused) {
                logBuffer.push(entry);
                if (logBuffer.length > 1000) logBuffer.shift();
                appendLogLine(entry);
            }
        } catch {}
    };
}

function logLevelNum(name) {
    return { debug: 20, info: 30, warn: 40, error: 50 }[name] || 0;
}

function renderLogsBuffer() {
    const viewer = $('#log-viewer');
    if (!viewer) return;
    const minLevel = logLevelNum(logLevelFilter);
    const filtered = logLevelFilter ? logBuffer.filter(e => (e.level ?? 30) >= minLevel) : logBuffer;
    viewer.innerHTML = filtered.map(renderLogLine).join('');
    viewer.scrollTop = viewer.scrollHeight;
}

function appendLogLine(entry) {
    const viewer = $('#log-viewer');
    if (!viewer) return;
    const minLevel = logLevelNum(logLevelFilter);
    if (logLevelFilter && (entry.level ?? 30) < minLevel) return;
    viewer.insertAdjacentHTML('beforeend', renderLogLine(entry));
    if (!logPaused) viewer.scrollTop = viewer.scrollHeight;
}

function renderLogLine(e) {
    const levelColors = { 10: '#6b7280', 20: '#6b7280', 30: '#22c55e', 40: '#f59e0b', 50: '#ef4444', 60: '#dc2626' };
    const levelNames = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
    const c = levelColors[e.level] || '#6b7280';
    const name = levelNames[e.level] || 'INFO';
    const ts = e.time ? new Date(e.time).toLocaleTimeString() : '';
    const extras = Object.entries(e).filter(([k]) => !['level','time','msg','levelName'].includes(k)).map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    return `<div style="border-bottom:1px solid var(--border);padding:3px 0"><span style="color:var(--text-muted)">${esc(ts)}</span> <span style="color:${c};font-weight:600">${name}</span> <span style="color:var(--text-primary)">${esc(e.msg || '')}</span>${extras ? `<span style="color:var(--text-muted);margin-left:8px">${esc(extras)}</span>` : ''}</div>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTO-FIX — host page for the address-review action: persistent workdirs,
// per-PR convergence timelines (later phase), address run records (later
// phase). Phase A surface is the Workdirs panel only.
// ═════════════════════════════════════════════════════════════════════════════
async function renderAutoFix(el) {
    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Auto-Fix</h1>
                <p class="page-subtitle">Address-review runs, persistent workdirs, and PR convergence telemetry</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost btn-sm" onclick="renderAutoFix($('#content'))">↻ Refresh</button>
            </div>
        </div>

        <h3 style="font-size:13px;color:var(--text-secondary);margin:18px 0 10px;letter-spacing:0.5px">ADDRESS RUNS</h3>
        <div id="auto-fix-address-runs"></div>

        <h3 style="font-size:13px;color:var(--text-secondary);margin:24px 0 10px;letter-spacing:0.5px">WORKDIRS</h3>
        <div id="auto-fix-workdirs"></div>
    `;
    await loadPricing();
    await Promise.all([loadAutoFixAddressRuns(), loadAutoFixWorkdirs()]);
}

async function loadAutoFixAddressRuns() {
    const target = $('#auto-fix-address-runs');
    if (!target) return;
    target.innerHTML = '<div class="skeleton skeleton-card"></div>';
    let data;
    try {
        data = await api.get('/api/auto-fix/address-runs?limit=200');
    } catch (err) {
        target.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">Failed to load address runs: ${esc(err.message)}</p></div>`;
        return;
    }
    const runs = data.runs || [];
    if (runs.length === 0) {
        target.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔧</div>
                <p class="empty-text">No address-review runs yet. Trigger one from an AI Review record (look for the "Address this review" button) or via the <code>/sokuza fix</code> slash command on a PR.</p>
            </div>
        `;
        return;
    }
    target.innerHTML = `
        <div class="table-wrap" style="overflow-x:auto">
            <table style="min-width:960px">
                <thead><tr>
                    <th>Time</th>
                    <th>PR</th>
                    <th>Mode</th>
                    <th>Iter</th>
                    <th>Issues</th>
                    <th>Tests</th>
                    <th style="text-align:right">Cost</th>
                    <th>Outcome</th>
                </tr></thead>
                <tbody>${runs.map(renderAddressRunRow).join('')}</tbody>
            </table>
        </div>
    `;
}

function renderAddressRunRow(r) {
    const repoCell = r.pr?.repo ? `<a onclick="event.stopPropagation();openPrTimeline('${esc(r.pr.repo)}',${r.pr.prNumber})" style="cursor:pointer;color:var(--accent-hover)">${esc(r.pr.repo)} <span style="color:var(--text-muted)">#${r.pr.prNumber}</span></a>` : '—';
    const cost = estimateCostFromUsage(r.provider, r.model, r.usage);
    const costCell = cost == null
        ? `<span style="color:var(--text-muted)">—</span>`
        : `<span style="font-family:var(--mono);color:var(--text-muted)">${esc(fmtCost(cost))}</span>`;
    const modeBadge = r.mode === 'push'
        ? `<span class="badge" style="background:#f59e0b22;color:#f59e0b">push</span>`
        : `<span class="badge" style="background:#22c55e22;color:#22c55e">suggest</span>`;
    const issueSummary = r.issues
        ? `${r.issues.addressed}✓ · ${r.issues.rejected}✗ · ${r.issues.deferred}⏸`
        : '—';
    const testsCell = r.tests
        ? (r.tests.ranTests
            ? (r.tests.passed
                ? `<span style="color:#22c55e">✓ ${esc(r.tests.command || '')}</span>`
                : `<span style="color:#ef4444">✗ ${esc(r.tests.command || '')}</span>`)
            : `<span style="color:var(--text-muted)">none</span>`)
        : '<span style="color:var(--text-muted)">—</span>';

    let outcome, outcomeColor;
    if (r.error) { outcome = 'error'; outcomeColor = '#ef4444'; }
    else if (r.haltReason) { outcome = `halted: ${r.haltReason}`; outcomeColor = '#f59e0b'; }
    else if (r.push?.commitSha) { outcome = `pushed ${r.push.commitSha.slice(0, 8)}`; outcomeColor = '#22c55e'; }
    else if (r.suggest?.reviewId) { outcome = `review ${r.suggest.commentCount} comments`; outcomeColor = '#22c55e'; }
    else { outcome = 'ok'; outcomeColor = '#22c55e'; }

    return `
        <tr style="cursor:pointer" onclick="openAddressRunDetail('${esc(r.id)}')">
            <td style="font-family:var(--mono);font-size:12px;color:var(--text-muted);white-space:nowrap">${esc(fmtDateTime(r.createdAt))}</td>
            <td style="font-size:12px;white-space:nowrap">${repoCell}</td>
            <td>${modeBadge}</td>
            <td style="font-size:12px;text-align:center">${r.iteration}/${r.iterationCap}</td>
            <td style="font-family:var(--mono);font-size:11px;white-space:nowrap">${issueSummary}</td>
            <td style="font-size:12px;white-space:nowrap">${testsCell}</td>
            <td style="text-align:right">${costCell}</td>
            <td style="font-size:12px;white-space:nowrap"><span class="badge" style="background:${outcomeColor}22;color:${outcomeColor}">${esc(outcome)}</span></td>
        </tr>
    `;
}

window.openPrTimeline = async function (repoFull, prNumber) {
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) return;
    openModal(`Convergence: ${repoFull} #${prNumber}`, '<div class="skeleton skeleton-card"></div>');
    let data;
    try {
        data = await api.get(`/api/auto-fix/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${prNumber}/timeline`);
    } catch (err) {
        $('#modal-body').innerHTML = `<p style="color:#ef4444">Failed to load timeline: ${esc(err.message)}</p>`;
        return;
    }
    $('#modal-body').innerHTML = renderPrTimelineBody(data);
};

function renderPrTimelineBody(data) {
    const entries = [];
    for (const r of data.reviews) entries.push({ kind: 'review', record: r, at: r.createdAt });
    for (const r of data.addressRuns) entries.push({ kind: 'address', record: r, at: r.createdAt });
    entries.sort((a, b) => a.at.localeCompare(b.at));

    if (entries.length === 0) {
        return '<p style="color:var(--text-muted);font-size:12px">No records yet for this PR.</p>';
    }

    let totalCost = 0;
    let costed = false;
    for (const e of entries) {
        const c = estimateCostFromUsage(e.record.provider, e.record.model, e.record.usage);
        if (c != null) { totalCost += c; costed = true; }
    }

    const summary = `${data.reviews.length} reviews · ${data.addressRuns.length} address runs${costed ? ` · est. cost ${fmtCost(totalCost)}` : ''}`;
    const parts = [];
    parts.push(`<p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">${summary}</p>`);
    parts.push('<div style="display:flex;flex-direction:column;gap:10px">');

    for (const e of entries) {
        const cost = estimateCostFromUsage(e.record.provider, e.record.model, e.record.usage);
        const costSpan = cost == null ? '' : ` <span style="color:var(--text-muted);font-size:11px">${esc(fmtCost(cost))}</span>`;
        if (e.kind === 'review') {
            const decision = e.record.output?.decision || '?';
            const issueCount = e.record.output?.issueCount ?? 0;
            const dotColor = decision === 'APPROVE' ? '#22c55e' : decision === 'CHANGES_REQUESTED' ? '#f59e0b' : '#6b7280';
            parts.push(`
                <div style="display:flex;gap:10px;padding:10px;border-left:3px solid ${dotColor};background:var(--bg-secondary,#161614);border-radius:4px;cursor:pointer" onclick="closeModal();currentPage='ai-reviews';renderPage();setTimeout(()=>openAiReviewDetail('${esc(e.record.id)}'),300)">
                    <div style="flex:1">
                        <div style="font-weight:600;font-size:12px">📋 AI Review · <code style="color:${dotColor}">${esc(decision)}</code> · ${issueCount} issue${issueCount === 1 ? '' : 's'}${costSpan}</div>
                        <div style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${esc(e.record.id)} · ${esc(fmtDateTime(e.record.createdAt))}</div>
                    </div>
                </div>
            `);
        } else {
            const r = e.record;
            const outcome = r.error ? 'error' : r.haltReason ? `halted: ${r.haltReason}` : r.push?.commitSha ? `pushed ${r.push.commitSha.slice(0, 8)}` : r.suggest?.reviewId ? `review #${r.suggest.reviewId}` : 'ok';
            const dotColor = r.error || r.haltReason ? '#f59e0b' : '#22c55e';
            const a = r.issues?.addressed ?? 0;
            const rj = r.issues?.rejected ?? 0;
            const df = r.issues?.deferred ?? 0;
            parts.push(`
                <div style="display:flex;gap:10px;padding:10px;border-left:3px solid ${dotColor};background:var(--bg-secondary,#161614);border-radius:4px;cursor:pointer" onclick="closeModal();setTimeout(()=>openAddressRunDetail('${esc(r.id)}'),300)">
                    <div style="flex:1">
                        <div style="font-weight:600;font-size:12px">🔧 Address (${esc(r.mode)}) · iter ${r.iteration}/${r.iterationCap} · ${a}✓ · ${rj}✗ · ${df}⏸ · <code>${esc(outcome)}</code>${costSpan}</div>
                        <div style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${esc(r.id)} · ${esc(fmtDateTime(r.createdAt))}</div>
                    </div>
                </div>
            `);
        }
    }

    parts.push('</div>');

    const lastReview = data.reviews[0];
    if (lastReview && lastReview.output?.decision === 'APPROVE') {
        parts.push(`<div style="margin-top:14px;padding:10px;background:#22c55e22;border-left:3px solid #22c55e;font-size:12px">Latest review approved — loop converged.</div>`);
    } else if (data.addressRuns[0]?.haltReason === 'iteration-cap') {
        parts.push(`<div style="margin-top:14px;padding:10px;background:#f59e0b22;border-left:3px solid #f59e0b;font-size:12px">Iteration cap reached — human attention required.</div>`);
    } else if (data.addressRuns[0]?.haltReason === 'merge-ready') {
        parts.push(`<div style="margin-top:14px;padding:10px;background:#22c55e22;border-left:3px solid #22c55e;font-size:12px">Merge-ready threshold satisfied — loop halted gracefully.</div>`);
    }

    return parts.join('');
}

window.openAddressRunDetail = async function (id) {
    openModal(`Address run: ${id}`, '<div class="skeleton skeleton-card"></div>');
    let record;
    try {
        record = await api.get(`/api/auto-fix/address-runs/${encodeURIComponent(id)}`);
    } catch (err) {
        $('#modal-body').innerHTML = `<p style="color:#ef4444">Failed to load: ${esc(err.message)}</p>`;
        return;
    }
    $('#modal-body').innerHTML = renderAddressRunBody(record);
};

function renderAddressRunBody(r) {
    const decisions = (label, list, color) => {
        if (!list || list.length === 0) return '';
        return `<div style="margin-bottom:14px">
            <h4 style="margin:0 0 6px;font-size:13px;color:${color}">${label}</h4>
            <ul style="font-size:12px;padding-left:18px">
                ${list.map((i) => `<li><strong>${esc(i.priority)}</strong>${i.file ? ` · <code>${esc(i.file)}</code>` : ''} — ${esc(i.title)}${i.reasoning ? `<br><span style="color:var(--text-muted)">${esc(i.reasoning)}</span>` : ''}</li>`).join('')}
            </ul>
        </div>`;
    };
    const t = r.tests;
    const testsBlock = t
        ? `<div><strong>Tests:</strong> ${t.ranTests ? `<code>${esc(t.command || '?')}</code> ${t.passed ? '<span style="color:#22c55e">✓ passed</span>' : '<span style="color:#ef4444">✗ failed</span>'}${t.durationMs ? ` <span style="color:var(--text-muted)">(${t.durationMs}ms)</span>` : ''}` : '<span style="color:var(--text-muted)">no validation discovered</span>'}</div>${t.output ? `<pre style="margin-top:6px;padding:8px;background:var(--bg-primary);border:1px solid var(--border);font-size:11px;max-height:240px;overflow:auto">${esc(t.output)}</pre>` : ''}`
        : '';
    const haltLine = r.haltReason
        ? `<div style="margin:14px 0;padding:10px;background:#f59e0b22;border-left:3px solid #f59e0b;font-size:12px">Halted: <strong>${esc(r.haltReason)}</strong>${r.error ? ` — ${esc(r.error)}` : ''}</div>`
        : '';
    const pushLine = r.push?.commitSha
        ? `<div><strong>Push:</strong> <code>${esc(r.push.commitSha.slice(0, 8))}</code> → <code>${esc(r.push.ref)}</code> at ${esc(fmtDateTime(r.push.pushedAt))}</div>`
        : '';
    const suggestLine = r.suggest?.reviewId
        ? `<div><strong>Suggest:</strong> review #${esc(r.suggest.reviewId)} with ${r.suggest.commentCount} inline comments${r.suggest.htmlUrl ? ` — <a href="${esc(r.suggest.htmlUrl)}" target="_blank">view PR</a>` : ''}</div>`
        : '';

    return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px;font-size:13px">
            <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">PR</div><div>${esc(r.pr?.repo || '—')} #${r.pr?.prNumber || '?'}${r.pr?.branch ? ` <span style="color:var(--text-muted)">(${esc(r.pr.branch)})</span>` : ''}</div></div>
            <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Iteration</div><div>${r.iteration}/${r.iterationCap} · mode <code>${esc(r.mode)}</code></div></div>
            <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Created</div><div style="font-family:var(--mono);font-size:12px">${esc(r.createdAt)} · ${r.durationMs}ms</div></div>
            <div><div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Source review</div><div style="font-family:var(--mono);font-size:11px"><code>${esc(r.sourceReviewRunId)}</code></div></div>
        </div>

        ${haltLine}

        ${decisions('Addressed', r.issues?.addressed, '#22c55e')}
        ${decisions('Rejected', r.issues?.rejected, '#ef4444')}
        ${decisions('Deferred', r.issues?.deferred, '#f59e0b')}

        <div style="font-size:13px;line-height:1.6">
            ${pushLine}
            ${suggestLine}
            ${testsBlock}
        </div>
    `;
}

async function loadAutoFixWorkdirs() {
    const target = $('#auto-fix-workdirs');
    if (!target) return;
    target.innerHTML = '<div class="skeleton skeleton-card"></div>';

    let data;
    try {
        data = await api.get('/api/auto-fix/workdirs');
    } catch (err) {
        target.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">Failed to load workdirs: ${esc(err.message)}</p></div>`;
        return;
    }

    const workdirs = data.workdirs || [];
    const totalBytes = data.totalBytes || 0;

    if (workdirs.length === 0) {
        target.innerHTML = `
            <div class="card-grid" style="margin-bottom:14px">
                <div class="card card-stat"><div class="stat-value">0</div><div class="stat-label">Cached workdirs</div></div>
                <div class="card card-stat"><div class="stat-value">0 B</div><div class="stat-label">Total disk</div></div>
            </div>
            <div class="empty-state">
                <div class="empty-icon">📁</div>
                <p class="empty-text">No PR workdirs cached yet. The first <code>address-review</code> run on any PR will clone its repo here, and reuse the clone on subsequent iterations.</p>
            </div>
        `;
        return;
    }

    target.innerHTML = `
        <div class="card-grid" style="margin-bottom:14px">
            <div class="card card-stat"><div class="stat-value">${workdirs.length}</div><div class="stat-label">Cached workdirs</div></div>
            <div class="card card-stat"><div class="stat-value">${fmtBytes(totalBytes)}</div><div class="stat-label">Total disk</div></div>
        </div>

        <div class="table-wrap" style="overflow-x:auto">
            <table style="min-width:780px">
                <thead><tr>
                    <th>Repo</th>
                    <th>PR</th>
                    <th>Branch</th>
                    <th style="text-align:right">Size</th>
                    <th>Cloned</th>
                    <th>Last sync</th>
                    <th>Status</th>
                    <th></th>
                </tr></thead>
                <tbody>${workdirs.map(renderWorkdirRow).join('')}</tbody>
            </table>
        </div>
    `;
}

function renderWorkdirRow(w) {
    const lockBadge = w.locked
        ? `<span title="Locked by pid ${w.lockHolder?.pid}" class="badge" style="background:#f59e0b22;color:#f59e0b">locked</span>`
        : `<span class="badge" style="background:#22c55e22;color:#22c55e">idle</span>`;
    const evictBtn = w.locked
        ? `<button class="btn btn-sm btn-ghost" onclick="evictWorkdir('${esc(w.owner)}','${esc(w.repo)}',${w.prNumber}, true)" title="Force-evict (lock will be ignored)">Force evict</button>`
        : `<button class="btn btn-sm btn-ghost" onclick="evictWorkdir('${esc(w.owner)}','${esc(w.repo)}',${w.prNumber}, false)">Evict</button>`;
    return `
        <tr>
            <td style="font-size:12px"><code>${esc(w.owner)}/${esc(w.repo)}</code></td>
            <td style="font-size:12px">#${w.prNumber}</td>
            <td style="font-size:12px;color:var(--text-muted)"><code>${esc(w.headRef || '')}</code></td>
            <td style="text-align:right;font-family:var(--mono);font-size:12px">${fmtBytes(w.sizeBytes)}</td>
            <td style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${esc(fmtDateTime(w.clonedAt))}</td>
            <td style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${esc(fmtDateTime(w.lastSyncAt))}</td>
            <td>${lockBadge}</td>
            <td style="text-align:right">${evictBtn}</td>
        </tr>
    `;
}

window.evictWorkdir = async function (owner, repo, pr, force) {
    if (!confirm(`Evict workdir for ${owner}/${repo}#${pr}?${force ? '\n\nThe lock holder may be mid-run; force-eviction can corrupt that run.' : ''}`)) return;
    try {
        await api.del(`/api/auto-fix/workdirs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr}${force ? '?force=true' : ''}`);
        await loadAutoFixWorkdirs();
    } catch (err) {
        if (err.message.includes('409')) {
            if (confirm('Workdir is locked by an active run. Force-evict anyway?')) {
                await window.evictWorkdir(owner, repo, pr, true);
            }
            return;
        }
        toast?.(`Failed to evict: ${err.message}`);
    }
};

function fmtBytes(n) {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
    return `${n} B`;
}

// ═════════════════════════════════════════════════════════════════════════════
// AI REVIEWS — browse the run log written by the ai-review action
// (~/.sokuza/runs/ai-review/) so we can evaluate whether truncation is
// dropping review-relevant signal.
// ═════════════════════════════════════════════════════════════════════════════
let aiReviewFilters = { truncated: false, errored: false, parseFailed: false };
let aiReviewsRefreshTimer = null;
let autoFixRefreshTimer = null;
let pricingCache = null;

async function loadPricing() {
    if (pricingCache) return pricingCache;
    try {
        pricingCache = await api.get('/api/auto-fix/pricing');
    } catch {
        pricingCache = { models: {} };
    }
    return pricingCache;
}

function estimateCostFromUsage(provider, model, usage) {
    if (!usage || !pricingCache) return null;
    const price = pricingCache.models?.[`${provider}/${model}`];
    if (!price) return null;
    const inTok = (usage.input_tokens ?? 0) / 1_000_000;
    const outTok = (usage.output_tokens ?? 0) / 1_000_000;
    return inTok * price.input_per_mtok + outTok * price.output_per_mtok;
}

function fmtCost(usd) {
    if (usd == null) return '—';
    if (usd < 0.005) return `<$0.01`;
    return `$${usd.toFixed(2)}`;
}

async function renderAiReviews(el) {
    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">AI Reviews</h1>
                <p class="page-subtitle">Run log of every <code>ai-review</code> action — outcomes, truncation, errors</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost btn-sm" onclick="reloadAiReviewsPage()">↻ Refresh</button>
            </div>
        </div>

        <div id="ai-reviews-stats" style="margin-bottom:18px"></div>

        <div class="filter-bar" id="ai-reviews-filters" style="margin-bottom:10px"></div>

        <div id="ai-reviews-table"></div>
    `;
    renderAiReviewFilters();
    await Promise.all([loadAiReviewsStats(), loadAiReviewsTable()]);
}

function renderAiReviewFilters() {
    const bar = $('#ai-reviews-filters');
    if (!bar) return;
    const isAll = !aiReviewFilters.truncated && !aiReviewFilters.errored && !aiReviewFilters.parseFailed;
    bar.innerHTML = `
        <button class="btn ${isAll ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="setAiReviewFilter('all')">All</button>
        <button class="btn ${aiReviewFilters.truncated ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="setAiReviewFilter('truncated')">Truncated only</button>
        <button class="btn ${aiReviewFilters.parseFailed ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="setAiReviewFilter('parseFailed')">Parse failures</button>
        <button class="btn ${aiReviewFilters.errored ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="setAiReviewFilter('errored')">Errors</button>
    `;
}

async function loadAiReviewsStats() {
    const target = $('#ai-reviews-stats');
    if (!target) return;
    let stats;
    try {
        stats = await api.get('/api/ai/runs/stats');
    } catch {
        target.innerHTML = '';
        return;
    }
    if (stats.total === 0) {
        target.innerHTML = '';
        return;
    }
    const pct = (n) => `${Math.round(n * 100)}%`;
    const fmtBytes = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
    const dropTotal = stats.droppedBytes.pattern + stats.droppedBytes.budget;
    target.innerHTML = `
        <div class="card-grid" style="margin-bottom:10px">
            <div class="card card-stat"><div class="stat-value">${stats.total}</div><div class="stat-label">Reviews (30d)</div></div>
            <div class="card card-stat"><div class="stat-value" style="color:${stats.truncatedRate > 0.25 ? '#f59e0b' : 'var(--text-primary)'}">${pct(stats.truncatedRate)}</div><div class="stat-label">Truncated</div></div>
            <div class="card card-stat"><div class="stat-value" style="color:${stats.parseFailed > 0 ? '#f59e0b' : 'var(--text-primary)'}">${stats.parseFailed}</div><div class="stat-label">Parse failures</div></div>
            <div class="card card-stat"><div class="stat-value" style="color:${stats.errored > 0 ? '#ef4444' : 'var(--text-primary)'}">${stats.errored}</div><div class="stat-label">Errors</div></div>
        </div>
        ${stats.topDroppedPaths.length > 0 ? `
        <details style="background:var(--bg-secondary,#161614);border:1px solid var(--border);border-radius:6px;padding:10px 14px">
            <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary)">Top dropped paths · ${fmtBytes(dropTotal)} total dropped (${fmtBytes(stats.droppedBytes.pattern)} pattern, ${fmtBytes(stats.droppedBytes.budget)} budget)</summary>
            <table style="width:100%;margin-top:10px;font-size:12px;font-family:var(--mono)">
                <thead><tr><th style="text-align:left">File</th><th style="text-align:right">Bytes dropped</th><th style="text-align:right">Hits</th><th>Reasons</th></tr></thead>
                <tbody>${stats.topDroppedPaths.map((p) => `<tr>
                    <td style="word-break:break-all">${esc(p.filename)}</td>
                    <td style="text-align:right">${p.bytes.toLocaleString()}</td>
                    <td style="text-align:right;color:var(--text-muted)">${p.count}</td>
                    <td style="font-size:11px">${p.reasons.pattern ? `<span style="color:var(--text-muted)">pattern×${p.reasons.pattern}</span>` : ''}${p.reasons.pattern && p.reasons.budget ? ' · ' : ''}${p.reasons.budget ? `<span style="color:#f59e0b">budget×${p.reasons.budget}</span>` : ''}</td>
                </tr>`).join('')}</tbody>
            </table>
        </details>` : ''}
    `;
}

window.reloadAiReviewsPage = function () {
    Promise.all([loadAiReviewsStats(), loadAiReviewsTable()]);
};

async function loadAiReviewsTable() {
    const target = $('#ai-reviews-table');
    if (!target) return;
    target.innerHTML = '<div class="skeleton skeleton-card"></div>';

    const params = new URLSearchParams({ limit: '200' });
    if (aiReviewFilters.truncated) params.set('truncated', 'true');
    if (aiReviewFilters.errored) params.set('errored', 'true');
    if (aiReviewFilters.parseFailed) params.set('parse_failed', 'true');

    let runs = [];
    try {
        const data = await api.get(`/api/ai/runs?${params}`);
        runs = data.runs || [];
    } catch (err) {
        target.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">Failed to load runs: ${esc(err.message)}</p></div>`;
        return;
    }

    if (runs.length === 0) {
        target.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p class="empty-text">No runs match the current filter${aiReviewFilters.truncated || aiReviewFilters.errored || aiReviewFilters.parseFailed ? '. Try "All" to see everything.' : ' yet — once an <code>ai-review</code> action runs, it will appear here.'}</p></div>`;
        return;
    }

    target.innerHTML = `
        <div class="table-wrap" style="overflow-x:auto">
            <table style="min-width:880px">
                <thead><tr>
                    <th>Time</th>
                    <th>Workflow</th>
                    <th>Repo / PR</th>
                    <th>Provider</th>
                    <th>Truncation</th>
                    <th>Outcome</th>
                    <th style="width:40px">Label</th>
                </tr></thead>
                <tbody>
                    ${runs.map(renderAiReviewRow).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderAiReviewRow(r) {
    const repo = r.event?.repo ?? '—';
    const prCell = r.event?.prNumber ? `${esc(repo)} <span style="color:var(--text-muted)">#${r.event.prNumber}</span>` : esc(repo);
    const truncCell = r.truncation?.triggered
        ? `<span style="color:var(--accent-hover);font-weight:600">${r.truncation.totalFiles}f → ${r.truncation.fullyIncludedFiles}+${r.truncation.truncatedFiles}t/${r.truncation.skippedFiles}s</span>`
        : `<span style="color:var(--text-muted)">none</span>`;

    let outcomeBadge, outcomeColor;
    if (r.error) { outcomeBadge = 'error'; outcomeColor = '#ef4444'; }
    else if (!r.output?.parseSucceeded) { outcomeBadge = 'parse-fail'; outcomeColor = '#f59e0b'; }
    else { outcomeBadge = r.output?.decision || 'ok'; outcomeColor = r.output?.decision === 'CHANGES_REQUESTED' ? '#f59e0b' : '#22c55e'; }
    const issueSuffix = typeof r.output?.issueCount === 'number' && r.output.issueCount > 0
        ? ` <span style="color:var(--text-muted);font-size:11px">· ${r.output.issueCount} issue${r.output.issueCount === 1 ? '' : 's'}</span>`
        : '';

    let labelCell = '<span style="color:var(--text-muted)">—</span>';
    if (r.label?.verdict === 'good') labelCell = '<span title="Marked good" style="color:#22c55e;font-size:14px">✓</span>';
    else if (r.label?.verdict === 'bad') labelCell = '<span title="Marked bad" style="color:#ef4444;font-size:14px">✗</span>';

    return `
        <tr style="cursor:pointer" onclick="openAiReviewDetail('${esc(r.id)}')">
            <td style="font-family:var(--mono);font-size:12px;color:var(--text-muted);white-space:nowrap">${esc(fmtDateTime(r.createdAt))}</td>
            <td>${r.workflowName ? `<span class="badge badge-action">${esc(r.workflowName)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="font-size:12px;white-space:nowrap">${prCell}</td>
            <td style="font-size:12px;white-space:nowrap"><code>${esc(r.provider)}</code> <span style="color:var(--text-muted);font-size:11px">${esc(r.model || '')}</span></td>
            <td style="font-family:var(--mono);font-size:11px;white-space:nowrap">${truncCell}</td>
            <td style="font-size:12px;white-space:nowrap"><span class="badge" style="background:${outcomeColor}22;color:${outcomeColor}">${esc(outcomeBadge)}</span>${issueSuffix}</td>
            <td style="text-align:center">${labelCell}</td>
        </tr>
    `;
}

window.setAiReviewFilter = function (which) {
    aiReviewFilters = { truncated: false, errored: false, parseFailed: false };
    if (which !== 'all') aiReviewFilters[which] = true;
    renderAiReviewFilters();
    loadAiReviewsTable();
};

window.openAiReviewDetail = async function (id) {
    openModal(`Run: ${id}`, '<div class="skeleton skeleton-card"></div>');
    let record;
    try {
        record = await api.get(`/api/ai/runs/${encodeURIComponent(id)}`);
    } catch (err) {
        $('#modal-body').innerHTML = `<p style="color:#ef4444">Failed to load run: ${esc(err.message)}</p>`;
        return;
    }
    $('#modal-body').innerHTML = renderAiReviewDetailBody(record);
};

function renderAiReviewDetailBody(r) {
    const event = r.event || {};
    const t = r.truncation || {};
    const o = r.output || {};
    const usage = r.usage || {};

    const filesTable = (t.files && t.files.length)
        ? `<table style="width:100%;font-size:12px;font-family:var(--mono)"><thead><tr><th style="text-align:left">File</th><th style="text-align:right">Original</th><th style="text-align:right">Final</th><th>Status</th></tr></thead><tbody>${
            t.files.map(f => `<tr>
                <td style="word-break:break-all">${esc(f.filename)}</td>
                <td style="text-align:right;color:var(--text-muted)">${f.originalBytes.toLocaleString()}</td>
                <td style="text-align:right">${f.finalBytes.toLocaleString()}</td>
                <td>${renderFileStatus(f)}</td>
            </tr>`).join('')
        }</tbody></table>`
        : '<p style="color:var(--text-muted);font-size:12px">No per-file detail recorded.</p>';

    const repairBadge = Array.isArray(o.repairAttempts) && o.repairAttempts.length > 0
        ? `<div style="margin-bottom:8px;padding:6px 10px;background:#22c55e22;border-left:3px solid #22c55e;font-size:12px">Recovered after ${o.repairAttempts.length} repair attempt${o.repairAttempts.length === 1 ? '' : 's'} (kind${o.repairAttempts.length === 1 ? '' : 's'}: ${esc(o.repairAttempts.map(a => a.kind).join(', '))}).</div>`
        : '';

    const issuesList = (o.issues && o.issues.length)
        ? `${repairBadge}<ul style="font-size:12px;padding-left:18px">${o.issues.map(i => `<li><strong>${esc(i.priority)}</strong> · <code>${esc(i.file || '')}</code> — ${esc(i.title || '')}</li>`).join('')}</ul>`
        : (o.parseSucceeded === false && o.rawSample
            ? `${repairBadge}<details style="font-size:12px"><summary style="cursor:pointer;color:#f59e0b">${esc(parseFailureLabel(o.parseFailureKind))} — show raw model output</summary><pre style="margin-top:8px;padding:10px;background:var(--bg-primary);border:1px solid var(--border);max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(o.rawSample)}</pre></details>${renderRepairHistory(o.repairAttempts)}`
            : `${repairBadge}<p style="color:var(--text-muted);font-size:12px">No issues flagged.</p>`);

    return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px;font-size:13px">
            <div>
                <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Workflow</div>
                <div>${r.workflowName ? esc(r.workflowName) : '—'}</div>
            </div>
            <div>
                <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Created</div>
                <div style="font-family:var(--mono);font-size:12px">${esc(r.createdAt)} · ${r.durationMs}ms</div>
            </div>
            <div>
                <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Event</div>
                <div>${sourceBadge(event.source)} <code style="font-size:11px">${esc(event.event || '')}</code>${event.repo ? ` · ${esc(event.repo)}` : ''}${event.prNumber ? ` #${event.prNumber}` : ''}${event.branch ? ` (${esc(event.branch)})` : ''}</div>
            </div>
            <div>
                <div style="color:var(--text-muted);font-size:11px;text-transform:uppercase;margin-bottom:4px">Provider · Model</div>
                <div><code>${esc(r.provider)}</code> · <code>${esc(r.model || '')}</code>${usage.input_tokens || usage.output_tokens ? ` · <span style="color:var(--text-muted);font-size:11px">${usage.input_tokens || 0}/${usage.output_tokens || 0} tok</span>` : ''}</div>
            </div>
        </div>

        <div style="margin-bottom:18px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <h4 style="margin:0;font-size:13px">Truncation</h4>
                <span style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">strategy=${esc(r.strategy)} · ${t.originalChars?.toLocaleString() || 0} → ${t.finalChars?.toLocaleString() || 0} chars · ${t.totalFiles || 0}f total · ${t.fullyIncludedFiles || 0} included · ${t.truncatedFiles || 0} truncated · ${t.skippedFiles || 0} skipped</span>
            </div>
            ${filesTable}
        </div>

        <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <h4 style="margin:0;font-size:13px">Output</h4>
                <span style="font-size:11px;color:var(--text-muted)">${o.parseSucceeded ? `parsed · decision: ${esc(o.decision || '?')}` : 'parse failed'}${typeof o.reviewChars === 'number' ? ` · ${o.reviewChars} chars` : ''}</span>
            </div>
            ${issuesList}
        </div>

        ${r.error ? `<div style="margin-top:14px;padding:10px;background:#ef444422;border-left:3px solid #ef4444;font-size:12px;font-family:var(--mono);white-space:pre-wrap">${esc(r.error)}</div>` : ''}

        ${r.event?.repo && r.event?.prNumber ? `
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                <h4 style="margin:0;font-size:13px">Auto-Fix this review</h4>
                <span style="font-size:11px;color:var(--text-muted)">runs <code>address-review</code> against ${esc(r.event.repo)} #${r.event.prNumber}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-sm btn-primary" onclick="triggerAddressRun('${esc(r.event.repo)}', ${r.event.prNumber}, '${esc(r.id)}', 'suggest')">👀 Suggest fixes</button>
                <button class="btn btn-sm btn-ghost" onclick="triggerAddressRun('${esc(r.event.repo)}', ${r.event.prNumber}, '${esc(r.id)}', 'push')" title="Push directly to the PR branch — only run this if you trust the bot to commit fixes">⚡ Push fixes</button>
                <span style="color:var(--text-muted);font-size:11px">opens a new GitHub review or commit on this PR</span>
            </div>
        </div>
        ` : ''}

        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                <h4 style="margin:0;font-size:13px">Label this run</h4>
                <span style="font-size:11px;color:var(--text-muted)">${r.label ? `marked ${esc(r.label.verdict)} · ${esc(fmtDateTime(r.label.labeledAt))}` : 'helps decide if truncation is dropping signal'}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-sm ${r.label?.verdict === 'good' ? 'btn-primary' : 'btn-ghost'}" onclick="setAiReviewLabel('${esc(r.id)}','good')">👍 Good</button>
                <button class="btn btn-sm ${r.label?.verdict === 'bad' ? 'btn-primary' : 'btn-ghost'}" onclick="setAiReviewLabel('${esc(r.id)}','bad')">👎 Bad</button>
                ${r.label ? `<button class="btn btn-sm btn-ghost" onclick="clearAiReviewLabel('${esc(r.id)}')">Clear</button>` : ''}
                <input id="ai-review-note-input" type="text" placeholder="Optional note (e.g. 'missed a real bug in dropped file')"
                       value="${esc(r.label?.note || '')}"
                       data-verdict="${esc(r.label?.verdict || '')}"
                       data-saved-note="${esc(r.label?.note || '')}"
                       style="flex:1;min-width:240px;padding:6px 10px;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-primary);font-size:12px;border-radius:4px"
                       onkeydown="if(event.key==='Enter'){saveAiReviewNote('${esc(r.id)}')}" onblur="saveAiReviewNote('${esc(r.id)}')" />
            </div>
        </div>
    `;
}

window.triggerAddressRun = async function (repoFull, prNumber, reviewRunId, mode) {
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) {
        toast?.('Invalid repo identifier');
        return;
    }
    if (mode === 'push' && !confirm(`Push mode commits and pushes fixes directly to PR #${prNumber}.\n\nContinue?`)) return;
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
    try {
        await api.post('/api/auto-fix/address-runs', {
            owner, repo, pr_number: prNumber,
            review_run_id: reviewRunId, mode,
        });
        toast?.(`Address-review (${mode}) submitted. Check the Auto-Fix page for results.`);
        if (btn) {
            btn.disabled = false;
            btn.textContent = mode === 'suggest' ? '👀 Suggest fixes' : '⚡ Push fixes';
        }
    } catch (err) {
        toast?.(`Failed: ${err.message}`);
        if (btn) { btn.disabled = false; }
    }
};

window.setAiReviewLabel = async function (id, verdict) {
    const note = ($('#ai-review-note-input')?.value || '').trim() || undefined;
    try {
        const record = await api.put(`/api/ai/runs/${encodeURIComponent(id)}/label`, { verdict, note });
        $('#modal-body').innerHTML = renderAiReviewDetailBody(record);
    } catch (err) {
        toast?.(`Failed to label: ${err.message}`);
    }
};

window.clearAiReviewLabel = async function (id) {
    try {
        const record = await api.del(`/api/ai/runs/${encodeURIComponent(id)}/label`);
        $('#modal-body').innerHTML = renderAiReviewDetailBody(record);
    } catch (err) {
        toast?.(`Failed to clear: ${err.message}`);
    }
};

/** Persist note edits. Only fires when a verdict already exists (a note
 *  without a thumbs is meaningless). The verdict is read from the input's
 *  data attribute, set by the renderer. */
window.saveAiReviewNote = async function (id) {
    const input = $('#ai-review-note-input');
    const verdict = input?.dataset.verdict;
    if (!input || !verdict) return;
    if (input.dataset.savedNote === input.value) return;
    input.dataset.savedNote = input.value;
    await window.setAiReviewLabel(id, verdict);
};

function renderRepairHistory(attempts) {
    if (!Array.isArray(attempts) || attempts.length === 0) return '';
    return `<details style="font-size:12px;margin-top:8px"><summary style="cursor:pointer;color:var(--text-muted)">Earlier failed attempts (${attempts.length})</summary>${
        attempts.map((a, i) => `<div style="margin-top:8px"><strong style="color:#f59e0b">Attempt ${i + 1} · ${esc(parseFailureLabel(a.kind))}</strong><pre style="margin-top:4px;padding:8px;background:var(--bg-primary);border:1px solid var(--border);max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11px">${esc(a.rawSample)}</pre></div>`).join('')
    }</details>`;
}

function parseFailureLabel(kind) {
    switch (kind) {
        case 'no-json':        return 'Agent gave up before producing JSON';
        case 'malformed-json': return 'Found JSON-like output but parse failed';
        case 'invalid-shape':  return 'JSON parsed but did not match review schema';
        default:               return 'Parse failed';
    }
}

function renderFileStatus(f) {
    if (f.status === 'included') return '<span style="color:#22c55e">included</span>';
    if (f.status === 'truncated') return '<span style="color:#f59e0b">truncated</span>';
    if (f.status === 'skipped') return `<span style="color:#ef4444">skipped (${esc(f.skipReason || '')})</span>`;
    return esc(f.status);
}

window.toggleLogPause = function () {
    logPaused = !logPaused;
    const btn = $('#log-pause-btn');
    if (btn) btn.textContent = logPaused ? '▶ Resume' : '⏸ Pause';
    const statusText = $('#log-status-text');
    if (statusText) statusText.textContent = logPaused ? 'Paused' : 'Live';
};

window.clearLogBuffer = function () {
    logBuffer = [];
    renderLogsBuffer();
};

// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM (autostart + updates — mirrors `sokuza service` / `sokuza update`)
// ═════════════════════════════════════════════════════════════════════════════
async function renderSystem(el) {
    const [info, svc, upd] = await Promise.all([
        api.get('/api/system/info').catch((e) => ({ error: e.message })),
        api.get('/api/system/service').catch((e) => ({ error: e.message })),
        api.get('/api/system/update').catch((e) => ({ error: e.message })),
    ]);

    const svcStatus = svc?.status;
    const infoBlock = info?.error
        ? `<p style="color:var(--text-muted)">${esc(info.error)}</p>`
        : `
            <p><span style="color:var(--text-muted)">Version:</span> <code>${esc(info.version ?? '')}</code></p>
            <p><span style="color:var(--text-muted)">Platform:</span> <code>${esc(info.platform ?? '')}</code> (Node ${esc(info.nodeVersion ?? '')})</p>
            <p><span style="color:var(--text-muted)">Config:</span> <code class="path-wrap">${esc(info.configPath ?? '')}</code></p>
            <p><span style="color:var(--text-muted)">PID:</span> <code>${esc(String(info.pid ?? ''))}</code></p>
        `;

    const svcBlock = svc?.error
        ? `<p style="color:var(--text-muted)">${esc(svc.error)}</p>`
        : `
            <p><span style="color:var(--text-muted)">Mechanism:</span> ${esc(svcStatus?.mechanism ?? '—')}</p>
            <p><span style="color:var(--text-muted)">Installed:</span> ${svcStatus?.installed ? '<span class="badge badge-success">yes</span>' : '<span class="badge">no</span>'}</p>
            <p><span style="color:var(--text-muted)">Enabled:</span> ${svcStatus?.enabled ? '<span class="badge badge-success">yes — starts at login</span>' : '<span class="badge">no</span>'}</p>
            <p><span style="color:var(--text-muted)">Active:</span> ${svcStatus?.active ? '<span class="badge badge-success">yes — running now</span>' : '<span class="badge">no</span>'}</p>
            <p><span style="color:var(--text-muted)">Unit file:</span> <code class="path-wrap" style="font-size:11px">${esc(svcStatus?.unitPath ?? '—')}</code></p>
            ${(svcStatus?.notes ?? []).map((n) => `<p style="color:var(--text-muted);font-size:12px">• ${esc(n)}</p>`).join('')}
            <div class="btn-group" style="margin-top:12px">
                ${svcStatus?.installed
                    ? `<button class="btn btn-danger-outline" onclick="systemServiceDisable()">Disable autostart</button>`
                    : `<button class="btn btn-primary" onclick="systemServiceEnable()">Enable autostart</button>`
                }
            </div>
        `;

    const updBlock = upd?.error
        ? `<p style="color:var(--text-muted)">${esc(upd.error)}</p>`
        : `
            <p><span style="color:var(--text-muted)">Current:</span> <code>sokuza ${esc(upd.current ?? '')}</code></p>
            ${upd.latest
                ? `<p><span style="color:var(--text-muted)">Latest:</span> <code>${esc(upd.latest)}</code> ${upd.updateAvailable ? '<span class="badge badge-success">update available</span>' : '<span class="badge">up to date</span>'}</p>`
                : `<p><span style="color:var(--text-muted)">Latest:</span> <span style="color:var(--text-muted)">no check yet</span></p>`
            }
            ${upd.checkedAt
                ? `<p><span style="color:var(--text-muted)">Checked:</span> ${esc(new Date(upd.checkedAt).toLocaleString())}</p>`
                : ''
            }
            <div class="btn-group" style="margin-top:12px">
                <button class="btn btn-ghost" onclick="systemCheckUpdate()">Check for updates</button>
                ${upd.updateAvailable ? `<button class="btn btn-primary" onclick="systemRunUpdate()">Update now</button>` : ''}
            </div>
        `;

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">System</h1>
                <p class="page-subtitle">Autostart and updates for this sokuza install</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost" onclick="renderPage()">↻ Refresh</button>
            </div>
        </div>

        <div class="card-grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
            <div class="panel">
                <div class="panel-header"><span class="panel-title">Install</span></div>
                <div class="panel-body" style="font-size:13px;line-height:1.8">${infoBlock}</div>
            </div>

            <div class="panel">
                <div class="panel-header"><span class="panel-title">Autostart</span></div>
                <div class="panel-body" style="font-size:13px;line-height:1.8">${svcBlock}</div>
            </div>

            <div class="panel">
                <div class="panel-header"><span class="panel-title">Updates</span></div>
                <div class="panel-body" style="font-size:13px;line-height:1.8">${updBlock}</div>
            </div>
        </div>

        <div id="system-update-output" style="margin-top:20px;display:none">
            <div class="panel">
                <div class="panel-header"><span class="panel-title">Update output</span></div>
                <div class="panel-body"><pre id="system-update-output-pre" style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto"></pre></div>
            </div>
        </div>
    `;
}

window.systemServiceEnable = async function () {
    if (!await confirm('Install and start the sokuza autostart service for the current user?')) return;
    try {
        await api.post('/api/system/service/enable', {});
        toast('Autostart enabled');
    } catch (err) {
        toast(`Enable failed: ${err.message}`, 'error');
    }
    renderPage();
};

window.systemServiceDisable = async function () {
    if (!await confirm('Stop and remove the autostart service? Sokuza will no longer start at login.')) return;
    try {
        await api.post('/api/system/service/disable', {});
        toast('Autostart disabled');
    } catch (err) {
        toast(`Disable failed: ${err.message}`, 'error');
    }
    renderPage();
};

window.systemCheckUpdate = async function () {
    try {
        await api.post('/api/system/update/check', {});
        toast('Update check complete');
    } catch (err) {
        toast(`Check failed: ${err.message}`, 'error');
    }
    renderPage();
};

window.systemRunUpdate = async function () {
    if (!await confirm('Run the update now? The running sokuza process must be restarted afterwards for the new version to take effect.')) return;
    toast('Updating — this can take up to a minute…');

    try {
        const result = await api.post('/api/system/update', {});
        const outEl = document.getElementById('system-update-output');
        const preEl = document.getElementById('system-update-output-pre');
        if (outEl && preEl) {
            outEl.style.display = '';
            preEl.textContent =
                (result.stdout ? `— stdout —\n${result.stdout}\n` : '') +
                (result.stderr ? `— stderr —\n${result.stderr}\n` : '') +
                (result.error ? `— error —\n${result.error}\n` : '');
        }
        if (result.ok) {
            toast('Update complete. Restart sokuza to apply the new version.');
        } else if (result.reason === 'source') {
            toast('Update refused: this sokuza is running from a source checkout — use git pull && npm run build.', 'error');
        } else if (result.reason === 'missing-command') {
            toast(`Update failed: \`${result.installer?.command}\` not found on PATH.`, 'error');
        } else {
            toast(`Update failed (exit ${result.exitCode ?? '?'}). See output below.`, 'error');
        }
    } catch (err) {
        toast(`Update failed: ${err.message}`, 'error');
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function renderSettings(el) {
    const data = await api.get('/api/config');
    // Use the server's raw YAML directly — re-serializing parsed-then-dumped
    // YAML on the client is what corrupted configs in the past (the
    // hand-rolled `toYaml` flattened nested keys inside array items to a
    // single indent level, which `yaml.load` accepted silently until a
    // duplicate-key collision made the whole file unparseable).
    const configYaml = data.raw
        ?? (typeof data.config === 'string' ? data.config : '# Failed to read config\n');

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Settings</h1>
                <p class="page-subtitle">Edit your sokuza.config.yaml directly</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-ghost" onclick="renderPage()">↻ Reload</button>
                <button class="btn btn-primary" onclick="saveConfig()" id="save-config-btn">Save Config</button>
            </div>
        </div>

        <div class="editor-layout" style="grid-template-columns:1fr 320px">
            <div>
                <div class="code-editor">
                    <textarea id="config-editor" spellcheck="false">${esc(configYaml)}</textarea>
                    <div class="code-editor-toolbar">
                        <span>sokuza.config.yaml</span>
                        <span id="config-status">Ready</span>
                    </div>
                </div>
            </div>
            <div>
                <div class="panel" style="margin-bottom:16px">
                    <div class="panel-header"><span class="panel-title">Quick Reference</span></div>
                    <div class="panel-body" style="font-size:12px;color:var(--text-secondary);line-height:1.7">
                        <p><strong>integrations:</strong> Define event sources (github, slack, webhook, cron)</p>
                        <p style="margin-top:8px"><strong>workflows:</strong> Each workflow needs:</p>
                        <div style="padding-left:12px;color:var(--text-muted);font-family:var(--mono);font-size:11px;margin-top:4px">
                            - name: my-workflow<br>
                            &nbsp;&nbsp;trigger:<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;source: github<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;event: push<br>
                            &nbsp;&nbsp;steps:<br>
                            &nbsp;&nbsp;&nbsp;&nbsp;- action: log<br>
                        </div>
                        <p style="margin-top:12px"><strong>Available actions:</strong></p>
                        <div class="event-tags" style="margin-top:4px">
                            ${availableActions.map(a => `<span class="event-tag">${esc(a)}</span>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="panel">
                    <div class="panel-header"><span class="panel-title">Tips</span></div>
                    <div class="panel-body" style="font-size:12px;color:var(--text-secondary);line-height:1.7">
                        <p>💡 Use <code style="color:var(--accent)">template:</code> to reference a template by name instead of defining steps inline.</p>
                        <p style="margin-top:8px">🔄 Changes are saved to disk immediately — the engine reloads on the next event.</p>
                        <p style="margin-top:8px">⚠️ Invalid YAML will show an error. Double-check indentation.</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Tab key support in textarea
    const editor = $('#config-editor');
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + 2;
        }
    });
}

window.saveConfig = async function () {
    const editor = $('#config-editor');
    const statusEl = $('#config-status');
    const saveBtn = $('#save-config-btn');
    if (!editor) return;

    const yamlText = editor.value;
    if (!yamlText.trim()) { toast('Config cannot be empty', 'error'); return; }
    statusEl.textContent = 'Saving...';
    saveBtn.disabled = true;

    try {
        // Send raw YAML to backend for parsing (backend uses js-yaml)
        const result = await api.put('/api/config', { __raw_yaml: yamlText });
        if (result.error) throw new Error(result.error);
        statusEl.textContent = '✓ Saved';
        toast('Config saved successfully');
        setTimeout(() => { if (statusEl) statusEl.textContent = 'Ready'; }, 2000);
    } catch (err) {
        statusEl.textContent = '✗ Error';
        toast(`Save failed: ${err.message}`, 'error');
    } finally {
        saveBtn.disabled = false;
    }
};


// ─── Event Badge ────────────────────────────────────────────────────────────
let unseenEventCount = 0;
function updateEventBadge() {
    const badge = $('#event-badge');
    if (!badge) return;
    if (unseenEventCount > 0 && currentPage !== 'events') {
        badge.style.display = '';
        badge.textContent = unseenEventCount > 99 ? '99+' : unseenEventCount;
    } else {
        badge.style.display = 'none';
        unseenEventCount = 0;
    }
}

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Skip if in a text input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
    }
    if (e.key === 'Escape') {
        const confirmEl = document.querySelector('.confirm-overlay');
        if (confirmEl) { confirmEl.remove(); return; }
        if ($('#modal-overlay')?.classList.contains('open')) { closeModal(); return; }
    }
    // Navigation shortcuts: Alt+1-6
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const pages = ['dashboard', 'my-prs', 'issues', 'workflows', 'library', 'integrations', 'events', 'queue', 'logs', 'system', 'settings'];
        const num = parseInt(e.key);
        if (num >= 1 && num <= pages.length) { e.preventDefault(); navigate(pages[num - 1]); }
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAT SESSIONS
// ─────────────────────────────────────────────────────────────────────────────
// Scoped to a repo, branch, or PR. Each session has a cloned workdir and a
// persisted message log. The agent can call tools — notably `run_workflow`
// — from inside the session.

let chatActiveSessionId = null;           // null → show the session list
let chatThreadInFlight = false;           // true while a turn is streaming

async function renderChat(el) {
    const [sessionsRes, configRes] = await Promise.all([
        api.get('/api/chat/sessions').catch(() => ({ sessions: [] })),
        api.get('/api/config').catch(() => ({ config: {} })),
    ]);
    const sessions = sessionsRes.sessions || [];
    const config = configRes.config || {};

    if (chatActiveSessionId) {
        const session = sessions.find((s) => s.id === chatActiveSessionId);
        if (session) {
            await renderChatThread(el, session);
            return;
        }
        chatActiveSessionId = null;
    }

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left">
                <h1 class="page-title">Chat</h1>
                <p class="page-subtitle">Ask questions about a repo, branch, or PR. The agent can trigger workflows from inside the chat.</p>
            </div>
            <div class="page-header-right">
                <button class="btn btn-primary btn-sm" onclick="openNewChatSession()">+ New Session</button>
            </div>
        </div>
        ${sessions.length === 0 ? `
            <div class="empty-state">
                <div class="empty-icon">💬</div>
                <p class="empty-text">No chat sessions yet</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:6px">Start a conversation scoped to a repo, branch, or PR.</p>
                <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="openNewChatSession()">Create a session</button>
            </div>` : `
            <div class="card-grid card-grid-3">
                ${sessions.map((s) => renderChatSessionCard(s)).join('')}
            </div>`}
    `;

    // Stash config for the New Session modal
    window._chatLastConfig = config;
}

function renderChatSessionCard(session) {
    const scopeBadge = chatScopeBadge(session.scope);
    const updated = new Date(session.updatedAt).toLocaleString();
    return `
        <div class="card" style="flex-direction:column;align-items:stretch;gap:8px;cursor:pointer" onclick="openChatSession('${esc(session.id)}')">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${scopeBadge}
                <strong style="font-size:14px;flex:1">${esc(session.title)}</strong>
            </div>
            <div style="font-size:12px;color:var(--text-secondary)">
                <div>Provider: <code>${esc(session.provider)}</code></div>
                <div style="margin-top:2px">Updated: ${esc(updated)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
                <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); deleteChatSession('${esc(session.id)}')" style="color:#ef4444">Delete</button>
            </div>
        </div>`;
}

function chatScopeBadge(scope) {
    if (!scope) return '';
    if (scope.kind === 'pr') {
        return `<span class="badge" style="font-size:10px;background:rgba(34,197,94,0.15);color:#22c55e">PR #${esc(String(scope.prNumber))}</span>`;
    }
    if (scope.kind === 'branch') {
        return `<span class="badge" style="font-size:10px;background:rgba(234,179,8,0.15);color:#eab308">branch</span>`;
    }
    return `<span class="badge" style="font-size:10px;background:rgba(99,102,241,0.15);color:var(--accent-hover)">repo</span>`;
}

window.openChatSession = function (id) {
    chatActiveSessionId = id;
    renderPage();
};

window.closeChatSession = function () {
    chatActiveSessionId = null;
    renderPage();
};

window.deleteChatSession = async function (id) {
    if (!confirm('Delete this chat session and its cloned workdir? This cannot be undone.')) return;
    try {
        await api.del('/api/chat/sessions/' + encodeURIComponent(id));
        if (chatActiveSessionId === id) chatActiveSessionId = null;
        toast('Session deleted');
        renderPage();
    } catch (err) {
        toast('Failed to delete: ' + (err.message || 'Unknown error'), 'error');
    }
};

// ─── New session modal ──────────────────────────────────────────────────────
//
// Users rarely remember repo/branch/PR strings by heart. The modal drives
// every scope field from a picker that reads live GitHub data through the
// proxy endpoints in api.ts, and falls back to pasting a github.com URL or
// typing a literal owner/repo for anything that's not yet discoverable.
//
// State lives on window._chatPicker so the dropdowns can share cached data
// without re-fetching on every keystroke.

function chatPickerInitState() {
    window._chatPicker = {
        me: null,            // { login } — authenticated user, for grouping + my-PRs
        repos: null,         // array from /api/github/repos
        reposLoading: false,
        reposError: null,
        branches: {},        // { "owner/repo": array }
        prsByRepo: {},       // { "owner/repo:state": array }
        myPrs: {},           // { state: array }
        selected: { repo: '', ref: '', prNumber: null, title: '', author: '' },
        prSource: 'my',      // 'my' (cross-repo) or 'repo' (scoped)
        prState: 'open',     // 'open' | 'closed' | 'all'
    };
}

window.openNewChatSession = function () {
    const config = window._chatLastConfig || {};
    const providers = config.ai?.providers || {};
    const chatProviders = Object.entries(providers)
        .filter(([, p]) => p.kind === 'anthropic-api')
        .map(([name]) => name);
    const defaultProvider = config.ai?.default_provider;
    const preferredProvider = chatProviders.includes(defaultProvider) ? defaultProvider : chatProviders[0];

    if (chatProviders.length === 0) {
        openModal('Add an AI provider first', `
            <p>Chat needs an <code>anthropic-api</code>-kind provider configured on the <a href="#integrations" onclick="closeModal()">Integrations page</a>.</p>
            <p>Quickest route: add the <strong>ZAI GLM (API)</strong> preset with your ZAI API key — it uses ZAI's Anthropic-compatible endpoint and works out of the box.</p>
        `, `<button class="btn btn-primary" onclick="closeModal()">Got it</button>`);
        return;
    }

    chatPickerInitState();
    const providerOptions = chatProviders.map((p) => `<option value="${esc(p)}" ${p === preferredProvider ? 'selected' : ''}>${esc(p)}</option>`).join('');

    openModal('New Chat Session', `
        <div class="form-group">
            <label class="form-label">Paste a GitHub URL <span style="color:var(--text-muted);font-weight:400">(optional shortcut)</span></label>
            <input type="text" class="form-input" id="chat-url-paste"
                placeholder="https://github.com/owner/repo/pull/123"
                oninput="onChatUrlPaste()">
            <div class="form-hint">Repo, branch (<code>/tree/&lt;branch&gt;</code>), or PR (<code>/pull/&lt;n&gt;</code>) URLs auto-fill the pickers below.</div>
        </div>
        <div class="form-group">
            <label class="form-label">Scope</label>
            <div class="chat-scope-radios">
                <label class="chat-scope-chip">
                    <input type="radio" name="chat-scope-kind" value="repo" onchange="onChatScopeChange()"> Repo
                </label>
                <label class="chat-scope-chip">
                    <input type="radio" name="chat-scope-kind" value="branch" onchange="onChatScopeChange()"> Branch
                </label>
                <label class="chat-scope-chip">
                    <input type="radio" name="chat-scope-kind" value="pr" checked onchange="onChatScopeChange()"> Pull Request
                </label>
            </div>
        </div>

        <!-- PR source toggle (only shown for PR scope) -->
        <div class="form-group" id="chat-pr-source-wrap">
            <label class="form-label">Find a PR</label>
            <div class="chat-scope-radios">
                <label class="chat-scope-chip">
                    <input type="radio" name="chat-pr-source" value="my" checked onchange="onChatPrSourceChange()"> My PRs
                </label>
                <label class="chat-scope-chip">
                    <input type="radio" name="chat-pr-source" value="repo" onchange="onChatPrSourceChange()"> PRs in a repo
                </label>
            </div>
            <div class="chat-pr-state-row">
                <span class="form-hint" style="margin-right:8px">State:</span>
                <select class="form-select chat-inline-select" id="chat-pr-state" onchange="onChatPrStateChange()">
                    <option value="open" selected>Open</option>
                    <option value="closed">Closed</option>
                    <option value="all">All</option>
                </select>
            </div>
        </div>

        <!-- Repo picker (shown for Repo/Branch scopes, and for PR scope when source=repo) -->
        <div class="form-group" id="chat-repo-wrap">
            <label class="form-label">Repository</label>
            <div class="combobox-container" id="chat-repo-combobox">
                <div class="combobox-selected" id="chat-repo-selected" onclick="document.getElementById('chat-repo-search').focus()">
                    <input type="text" class="combobox-search" id="chat-repo-search"
                        placeholder="Search repos or type owner/repo…"
                        oninput="onChatRepoInput()" onfocus="showChatRepoDropdown()" autocomplete="off">
                </div>
                <div class="combobox-dropdown" id="chat-repo-dropdown"></div>
            </div>
            <div class="form-hint" id="chat-repo-hint">Loading your repos…</div>
        </div>

        <!-- Branch picker (Branch scope only) -->
        <div class="form-group" id="chat-branch-wrap" style="display:none">
            <label class="form-label">Branch</label>
            <div class="combobox-container" id="chat-branch-combobox">
                <div class="combobox-selected" id="chat-branch-selected" onclick="document.getElementById('chat-branch-search').focus()">
                    <input type="text" class="combobox-search" id="chat-branch-search"
                        placeholder="Pick a repository first…" disabled
                        oninput="onChatBranchInput()" onfocus="showChatBranchDropdown()" autocomplete="off">
                </div>
                <div class="combobox-dropdown" id="chat-branch-dropdown"></div>
            </div>
        </div>

        <!-- PR picker (PR scope only) -->
        <div class="form-group" id="chat-pr-wrap">
            <label class="form-label" id="chat-pr-label">Pull Request</label>
            <div class="combobox-container" id="chat-pr-combobox">
                <div class="combobox-selected" id="chat-pr-selected" onclick="document.getElementById('chat-pr-search').focus()">
                    <input type="text" class="combobox-search" id="chat-pr-search"
                        placeholder="Loading your PRs…"
                        oninput="onChatPrInput()" onfocus="showChatPrDropdown()" autocomplete="off">
                </div>
                <div class="combobox-dropdown" id="chat-pr-dropdown"></div>
            </div>
            <div class="form-hint" id="chat-pr-hint"></div>
        </div>

        <!-- Resolved selection preview -->
        <div class="chat-selection-preview" id="chat-selection-preview" style="display:none"></div>

        <div class="form-group">
            <label class="form-label">Provider</label>
            <select class="form-input" id="chat-provider">${providerOptions}</select>
            <div class="form-hint">Only providers of kind <code>anthropic-api</code> can run chat sessions.</div>
        </div>
        <div class="form-group">
            <label class="form-label">Title <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
            <input type="text" class="form-input" id="chat-title" placeholder="Auto-derived from scope if blank">
        </div>
        <div id="chat-create-error" style="display:none;padding:10px;border-radius:6px;background:rgba(239,68,68,0.1);color:#ef4444;font-size:13px;margin-top:8px"></div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="chat-create-btn" onclick="submitNewChatSession()">Create session</button>
    `);

    // Kick off initial data loads in parallel and render UI state.
    onChatScopeChange();
    loadChatRepos();
    loadChatMyPrs();
    loadChatMe();
};

// ─── Scope / source toggles ─────────────────────────────────────────────────

window.onChatScopeChange = function () {
    const kind = document.querySelector('input[name="chat-scope-kind"]:checked')?.value;
    const repoWrap = document.getElementById('chat-repo-wrap');
    const branchWrap = document.getElementById('chat-branch-wrap');
    const prWrap = document.getElementById('chat-pr-wrap');
    const prSourceWrap = document.getElementById('chat-pr-source-wrap');
    if (!repoWrap || !branchWrap || !prWrap || !prSourceWrap) return;

    // Reset dependent selections when scope changes so stale values don't leak.
    const s = window._chatPicker.selected;
    s.ref = '';
    s.prNumber = null;
    s.title = '';
    s.author = '';

    // Keep the repo search input synced to selected.repo (may have been set by
    // URL paste or a My-PR selection while the picker was hidden).
    const repoSearch = document.getElementById('chat-repo-search');
    if (repoSearch) repoSearch.value = s.repo || '';

    if (kind === 'repo') {
        repoWrap.style.display = '';
        branchWrap.style.display = 'none';
        prWrap.style.display = 'none';
        prSourceWrap.style.display = 'none';
    } else if (kind === 'branch') {
        repoWrap.style.display = '';
        branchWrap.style.display = '';
        prWrap.style.display = 'none';
        prSourceWrap.style.display = 'none';
        // Enable the branch picker if we already have a repo.
        const bs = document.getElementById('chat-branch-search');
        if (bs) {
            bs.disabled = !s.repo;
            bs.value = '';
            bs.placeholder = s.repo ? `Search branches in ${s.repo}…` : 'Pick a repository first…';
        }
        if (s.repo) loadChatRepoBranches(s.repo);
    } else { // pr
        prSourceWrap.style.display = '';
        prWrap.style.display = '';
        // repoWrap visibility is governed by pr source (my vs repo)
        branchWrap.style.display = 'none';
        onChatPrSourceChange();
        return;
    }
    updateChatSelectionPreview();
};

window.onChatPrSourceChange = function () {
    const src = document.querySelector('input[name="chat-pr-source"]:checked')?.value || 'my';
    window._chatPicker.prSource = src;
    const repoWrap = document.getElementById('chat-repo-wrap');
    const prLabel = document.getElementById('chat-pr-label');
    const prSearch = document.getElementById('chat-pr-search');
    const prHint = document.getElementById('chat-pr-hint');

    // Clear PR selection when switching sources.
    const s = window._chatPicker.selected;
    s.prNumber = null;
    s.ref = '';
    s.title = '';
    s.author = '';
    if (prSearch) prSearch.value = '';

    if (src === 'my') {
        if (repoWrap) repoWrap.style.display = 'none';
        if (prLabel) prLabel.textContent = 'My Pull Requests';
        if (prSearch) {
            prSearch.disabled = false;
            prSearch.placeholder = 'Search your PRs across all repos…';
        }
        if (prHint) prHint.textContent = 'Shows PRs authored by you. Selecting one fills repo + branch automatically.';
        renderChatPrDropdown();
    } else {
        if (repoWrap) repoWrap.style.display = '';
        if (prLabel) prLabel.textContent = 'Pull Request';
        if (prSearch) {
            const repo = s.repo;
            prSearch.disabled = !repo;
            prSearch.placeholder = repo ? `Search PRs in ${repo}…` : 'Pick a repository first…';
        }
        if (prHint) prHint.textContent = '';
        if (s.repo) loadChatRepoPrs(s.repo);
        renderChatPrDropdown();
    }
    updateChatSelectionPreview();
};

window.onChatPrStateChange = function () {
    const state = document.getElementById('chat-pr-state')?.value || 'open';
    window._chatPicker.prState = state;
    const s = window._chatPicker.selected;
    if (window._chatPicker.prSource === 'my') {
        loadChatMyPrs(); // refresh for the new state
    } else if (s.repo) {
        loadChatRepoPrs(s.repo);
    }
};

// ─── Data loaders (with basic caching) ──────────────────────────────────────

async function loadChatMe() {
    if (window._chatPicker.me) return;
    try {
        const res = await api.get('/api/github/me');
        window._chatPicker.me = res;
        renderChatRepoDropdown();
    } catch { /* token may not have user scope; silently skip */ }
}

async function loadChatRepos() {
    const state = window._chatPicker;
    if (state.repos || state.reposLoading) return;
    state.reposLoading = true;
    state.reposError = null;
    try {
        const res = await api.get('/api/github/repos');
        state.repos = res.items || [];
    } catch (err) {
        state.reposError = err.message || 'Failed to load repositories';
        state.repos = [];
    } finally {
        state.reposLoading = false;
        const hint = document.getElementById('chat-repo-hint');
        if (hint) {
            if (state.reposError) hint.textContent = state.reposError + ' — you can still type owner/repo manually.';
            else hint.textContent = `${state.repos.length} repositor${state.repos.length === 1 ? 'y' : 'ies'} available. Start typing to filter, or enter a custom owner/repo.`;
        }
        renderChatRepoDropdown();
    }
}

async function loadChatRepoBranches(repo) {
    const state = window._chatPicker;
    if (state.branches[repo]) return state.branches[repo];
    const [owner, name] = repo.split('/');
    if (!owner || !name) return [];
    try {
        const res = await api.get(`/api/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`);
        state.branches[repo] = res.items || [];
    } catch {
        state.branches[repo] = [];
    }
    renderChatBranchDropdown();
    return state.branches[repo];
}

async function loadChatRepoPrs(repo) {
    const state = window._chatPicker;
    const key = `${repo}:${state.prState}`;
    if (state.prsByRepo[key]) return state.prsByRepo[key];
    const [owner, name] = repo.split('/');
    if (!owner || !name) return [];
    try {
        const res = await api.get(`/api/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=${encodeURIComponent(state.prState)}`);
        state.prsByRepo[key] = res.items || [];
    } catch {
        state.prsByRepo[key] = [];
    }
    renderChatPrDropdown();
    return state.prsByRepo[key];
}

async function loadChatMyPrs() {
    const state = window._chatPicker;
    const key = state.prState;
    if (state.myPrs[key]) { renderChatPrDropdown(); return state.myPrs[key]; }
    try {
        const res = await api.get(`/api/github/my-prs?state=${encodeURIComponent(key)}`);
        state.myPrs[key] = res.items || [];
    } catch {
        state.myPrs[key] = [];
    }
    renderChatPrDropdown();
    return state.myPrs[key];
}

// ─── Repo combobox ──────────────────────────────────────────────────────────

window.showChatRepoDropdown = function () {
    const dd = document.getElementById('chat-repo-dropdown');
    if (!dd) return;
    renderChatRepoDropdown();
    dd.classList.add('open');
};

window.onChatRepoInput = function () {
    renderChatRepoDropdown();
    const dd = document.getElementById('chat-repo-dropdown');
    if (dd) dd.classList.add('open');
};

function renderChatRepoDropdown() {
    const dd = document.getElementById('chat-repo-dropdown');
    const search = document.getElementById('chat-repo-search');
    if (!dd || !search) return;
    const state = window._chatPicker;
    const query = search.value.toLowerCase().trim();
    const repos = state.repos || [];
    const myLogin = state.me?.login?.toLowerCase() || null;

    if (state.reposLoading && repos.length === 0) {
        dd.innerHTML = '<div class="combobox-empty">Loading repositories…</div>';
        return;
    }

    // Group repos: Configured (source=config), Personal (owner = me), each Org, Other.
    const groups = { configured: [], personal: [], orgs: {}, other: [] };
    for (const r of repos) {
        const matches = !query ||
            r.full_name.toLowerCase().includes(query) ||
            (r.description || '').toLowerCase().includes(query);
        if (!matches) continue;
        if (r.source === 'config') {
            groups.configured.push(r);
            continue;
        }
        const owner = (r.owner_login || '').toLowerCase();
        if (r.owner_type === 'Organization') {
            (groups.orgs[r.owner_login] ||= []).push(r);
        } else if (myLogin && owner === myLogin) {
            groups.personal.push(r);
        } else {
            groups.other.push(r);
        }
    }

    const sections = [];
    const renderOption = (r) => {
        const badge = r.source === 'config' ? '<code class="combobox-option-code">configured</code>' :
            r.private ? '<code class="combobox-option-code">private</code>' : '';
        const desc = r.description ? esc(r.description) : '';
        return `<div class="combobox-option" onclick="selectChatRepoFromPicker('${esc(r.full_name)}')">
            <span class="combobox-option-label">${esc(r.full_name)}</span>
            <span class="combobox-option-desc">${desc}</span>
            ${badge}
        </div>`;
    };
    if (groups.configured.length) {
        sections.push('<div class="combobox-group-label">Configured in Sokuza</div>' + groups.configured.map(renderOption).join(''));
    }
    if (groups.personal.length) {
        sections.push(`<div class="combobox-group-label">Personal${myLogin ? ` (${esc(state.me.login)})` : ''}</div>` + groups.personal.map(renderOption).join(''));
    }
    for (const orgName of Object.keys(groups.orgs).sort((a, b) => a.localeCompare(b))) {
        sections.push(`<div class="combobox-group-label">Org · ${esc(orgName)}</div>` + groups.orgs[orgName].map(renderOption).join(''));
    }
    if (groups.other.length) {
        sections.push('<div class="combobox-group-label">Other</div>' + groups.other.map(renderOption).join(''));
    }

    // Allow free-form owner/repo entry when query looks like one and isn't already listed.
    if (query && /^[\w.-]+\/[\w.-]+$/.test(query) && !repos.some((r) => r.full_name.toLowerCase() === query)) {
        sections.unshift(`<div class="combobox-group-label">Use as typed</div>
            <div class="combobox-option" onclick="selectChatRepoFromPicker('${esc(query)}')">
                <span class="combobox-option-label">${esc(query)}</span>
                <span class="combobox-option-desc">Use this repository as entered</span>
            </div>`);
    }

    dd.innerHTML = sections.join('') || `<div class="combobox-empty">${query ? 'No repositories match. Type <code>owner/repo</code> to use a custom one.' : 'No repositories available.'}</div>`;
}

window.selectChatRepoFromPicker = function (fullName) {
    const state = window._chatPicker;
    state.selected.repo = fullName;
    // Clear dependent selections when repo changes.
    state.selected.ref = '';
    state.selected.prNumber = null;
    state.selected.title = '';
    state.selected.author = '';

    const search = document.getElementById('chat-repo-search');
    if (search) search.value = fullName;
    const dd = document.getElementById('chat-repo-dropdown');
    if (dd) dd.classList.remove('open');

    // Enable/update dependent pickers based on active scope.
    const kind = document.querySelector('input[name="chat-scope-kind"]:checked')?.value;
    if (kind === 'branch') {
        const bs = document.getElementById('chat-branch-search');
        if (bs) {
            bs.disabled = false;
            bs.value = '';
            bs.placeholder = `Search branches in ${fullName}…`;
        }
        loadChatRepoBranches(fullName);
    } else if (kind === 'pr' && state.prSource === 'repo') {
        const ps = document.getElementById('chat-pr-search');
        if (ps) {
            ps.disabled = false;
            ps.value = '';
            ps.placeholder = `Search PRs in ${fullName}…`;
        }
        loadChatRepoPrs(fullName);
    }
    updateChatSelectionPreview();
};

// ─── Branch combobox ────────────────────────────────────────────────────────

window.showChatBranchDropdown = function () {
    const dd = document.getElementById('chat-branch-dropdown');
    if (!dd) return;
    renderChatBranchDropdown();
    dd.classList.add('open');
};

window.onChatBranchInput = function () {
    renderChatBranchDropdown();
    const dd = document.getElementById('chat-branch-dropdown');
    if (dd) dd.classList.add('open');
};

function renderChatBranchDropdown() {
    const dd = document.getElementById('chat-branch-dropdown');
    const search = document.getElementById('chat-branch-search');
    if (!dd || !search) return;
    const state = window._chatPicker;
    const repo = state.selected.repo;
    if (!repo) {
        dd.innerHTML = '<div class="combobox-empty">Select a repository first.</div>';
        return;
    }
    const branches = state.branches[repo];
    if (!branches) {
        dd.innerHTML = '<div class="combobox-empty">Loading branches…</div>';
        return;
    }
    const query = search.value.toLowerCase().trim();
    const filtered = branches.filter((b) => !query || b.name.toLowerCase().includes(query));
    let html = '';
    if (filtered.length) {
        html += filtered.slice(0, 100).map((b) => `
            <div class="combobox-option" onclick="selectChatBranchFromPicker('${esc(b.name)}')">
                <span class="combobox-option-label">${esc(b.name)}</span>
                <span class="combobox-option-desc">${b.protected ? 'protected' : ''}</span>
                ${b.sha ? `<code class="combobox-option-code">${esc(b.sha)}</code>` : ''}
            </div>`).join('');
    }
    if (query && !branches.some((b) => b.name.toLowerCase() === query)) {
        html = `<div class="combobox-group-label">Use as typed</div>
            <div class="combobox-option" onclick="selectChatBranchFromPicker('${esc(query)}')">
                <span class="combobox-option-label">${esc(query)}</span>
                <span class="combobox-option-desc">Use this ref as entered</span>
            </div>` + html;
    }
    dd.innerHTML = html || '<div class="combobox-empty">No branches match.</div>';
}

window.selectChatBranchFromPicker = function (name) {
    const state = window._chatPicker;
    state.selected.ref = name;
    const search = document.getElementById('chat-branch-search');
    if (search) search.value = name;
    const dd = document.getElementById('chat-branch-dropdown');
    if (dd) dd.classList.remove('open');
    updateChatSelectionPreview();
};

// ─── PR combobox ────────────────────────────────────────────────────────────

window.showChatPrDropdown = function () {
    const dd = document.getElementById('chat-pr-dropdown');
    if (!dd) return;
    renderChatPrDropdown();
    dd.classList.add('open');
};

window.onChatPrInput = function () {
    renderChatPrDropdown();
    const dd = document.getElementById('chat-pr-dropdown');
    if (dd) dd.classList.add('open');
};

function renderChatPrDropdown() {
    const dd = document.getElementById('chat-pr-dropdown');
    const search = document.getElementById('chat-pr-search');
    if (!dd || !search) return;
    const state = window._chatPicker;
    const query = search.value.toLowerCase().trim();

    let items = [];
    if (state.prSource === 'my') {
        items = state.myPrs[state.prState];
        if (!items) {
            dd.innerHTML = '<div class="combobox-empty">Loading your PRs…</div>';
            return;
        }
    } else {
        const repo = state.selected.repo;
        if (!repo) {
            dd.innerHTML = '<div class="combobox-empty">Select a repository first.</div>';
            return;
        }
        items = state.prsByRepo[`${repo}:${state.prState}`];
        if (!items) {
            dd.innerHTML = '<div class="combobox-empty">Loading PRs…</div>';
            return;
        }
    }

    const filtered = items.filter((pr) => {
        if (!query) return true;
        const hay = `#${pr.number} ${pr.title || ''} ${pr.author || ''} ${pr.repo || ''}`.toLowerCase();
        return hay.includes(query);
    });

    if (filtered.length === 0) {
        dd.innerHTML = `<div class="combobox-empty">${items.length === 0 ? 'No PRs found.' : 'No PRs match your search.'}</div>`;
        return;
    }

    // When listing my-PRs across repos, group by repo.
    let html = '';
    if (state.prSource === 'my') {
        const byRepo = {};
        for (const pr of filtered) (byRepo[pr.repo] ||= []).push(pr);
        for (const repo of Object.keys(byRepo).sort((a, b) => a.localeCompare(b))) {
            html += `<div class="combobox-group-label">${esc(repo)}</div>`;
            for (const pr of byRepo[repo]) html += renderChatPrOption(pr, repo);
        }
    } else {
        for (const pr of filtered) html += renderChatPrOption(pr, state.selected.repo);
    }
    dd.innerHTML = html;
}

function renderChatPrOption(pr, repo) {
    const stateBadge = pr.state === 'closed'
        ? '<code class="combobox-option-code" style="background:rgba(148,163,184,0.2);color:#94a3b8">closed</code>'
        : pr.draft
            ? '<code class="combobox-option-code" style="background:rgba(234,179,8,0.2);color:#eab308">draft</code>'
            : '<code class="combobox-option-code" style="background:rgba(34,197,94,0.15);color:#22c55e">open</code>';
    const sub = `${pr.author ? '@' + pr.author : ''}${pr.head?.ref ? ` · ${pr.head.ref}` : ''}`;
    return `<div class="combobox-option" onclick="selectChatPrFromPicker('${esc(repo)}', ${Number(pr.number)})">
        <span class="combobox-option-label">#${Number(pr.number)} ${esc(pr.title || '')}</span>
        <span class="combobox-option-desc">${esc(sub)}</span>
        ${stateBadge}
    </div>`;
}

window.selectChatPrFromPicker = async function (repo, number) {
    const state = window._chatPicker;
    state.selected.repo = repo;
    state.selected.prNumber = number;
    // Sync the repo picker input too so that switching scope later shows the
    // correct repo in the combobox.
    const repoSearch = document.getElementById('chat-repo-search');
    if (repoSearch) repoSearch.value = repo;

    // Try to find head.ref in already-loaded data; otherwise fetch the PR detail.
    const fromRepoList = (state.prsByRepo[`${repo}:${state.prState}`] || []).find((p) => p.number === number);
    let pr = fromRepoList;
    if (!pr || !pr.head?.ref) {
        const [owner, name] = repo.split('/');
        try {
            const res = await api.get(`/api/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`);
            pr = res.pr;
        } catch { /* fall through with whatever we have */ }
    }
    if (pr) {
        state.selected.ref = pr.head?.ref || '';
        state.selected.title = pr.title || '';
        state.selected.author = pr.author || '';
    }

    const search = document.getElementById('chat-pr-search');
    if (search) search.value = `#${number} ${pr?.title || ''}`.trim();
    const dd = document.getElementById('chat-pr-dropdown');
    if (dd) dd.classList.remove('open');
    updateChatSelectionPreview();
};

// ─── URL paste ──────────────────────────────────────────────────────────────

window.onChatUrlPaste = function () {
    const input = document.getElementById('chat-url-paste');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    // Parse: https://github.com/<owner>/<repo>(/pull/<n>|/tree/<branch>)?
    const m = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\/(?:pull|tree)\/([^/\s?#]+))?(?:[?#/].*)?$/i);
    if (!m) return;
    const owner = m[1];
    const name = m[2];
    const tail = m[3];
    const fullName = `${owner}/${name}`;
    const isPr = /\/pull\//i.test(raw);
    const isTree = /\/tree\//i.test(raw);

    if (isPr && tail) {
        const prNum = Number(tail);
        if (!Number.isFinite(prNum) || prNum <= 0) return;
        // Switch scope to PR, source to repo (specific repo + number)
        const prRadio = document.querySelector('input[name="chat-scope-kind"][value="pr"]');
        if (prRadio) { prRadio.checked = true; onChatScopeChange(); }
        const repoSrc = document.querySelector('input[name="chat-pr-source"][value="repo"]');
        if (repoSrc) { repoSrc.checked = true; onChatPrSourceChange(); }
        selectChatRepoFromPicker(fullName);
        selectChatPrFromPicker(fullName, prNum);
    } else if (isTree && tail) {
        const branchRadio = document.querySelector('input[name="chat-scope-kind"][value="branch"]');
        if (branchRadio) { branchRadio.checked = true; onChatScopeChange(); }
        selectChatRepoFromPicker(fullName);
        selectChatBranchFromPicker(tail);
    } else {
        const repoRadio = document.querySelector('input[name="chat-scope-kind"][value="repo"]');
        if (repoRadio) { repoRadio.checked = true; onChatScopeChange(); }
        selectChatRepoFromPicker(fullName);
    }
};

// ─── Selection preview ──────────────────────────────────────────────────────

function updateChatSelectionPreview() {
    const preview = document.getElementById('chat-selection-preview');
    if (!preview) return;
    const kind = document.querySelector('input[name="chat-scope-kind"]:checked')?.value;
    const s = window._chatPicker.selected;
    const parts = [];
    if (s.repo) parts.push(`<code>${esc(s.repo)}</code>`);
    if (kind === 'branch' && s.ref) parts.push(`branch <code>${esc(s.ref)}</code>`);
    if (kind === 'pr' && s.prNumber) {
        parts.push(`PR <code>#${s.prNumber}</code>`);
        if (s.ref) parts.push(`head <code>${esc(s.ref)}</code>`);
        if (s.author) parts.push(`by @${esc(s.author)}`);
    }
    if (parts.length === 0) {
        preview.style.display = 'none';
        preview.innerHTML = '';
    } else {
        preview.style.display = '';
        preview.innerHTML = `<span class="chat-selection-label">Selected:</span> ${parts.join(' · ')}`;
    }
}

// ─── Click-outside to close any open chat-picker dropdown ───────────────────
document.addEventListener('click', (e) => {
    for (const id of ['chat-repo-combobox', 'chat-branch-combobox', 'chat-pr-combobox']) {
        const combo = document.getElementById(id);
        if (combo && !combo.contains(e.target)) {
            const dd = combo.querySelector('.combobox-dropdown');
            if (dd) dd.classList.remove('open');
        }
    }
});

// ─── Submit ─────────────────────────────────────────────────────────────────

window.submitNewChatSession = async function () {
    const kind = document.querySelector('input[name="chat-scope-kind"]:checked')?.value;
    const provider = document.getElementById('chat-provider')?.value;
    const title = document.getElementById('chat-title')?.value.trim();
    const errEl = document.getElementById('chat-create-error');
    const btn = document.getElementById('chat-create-btn');
    const s = window._chatPicker.selected;

    const showErr = (msg) => { if (errEl) { errEl.style.display = 'block'; errEl.textContent = msg; } };
    const hideErr = () => { if (errEl) errEl.style.display = 'none'; };
    hideErr();

    // Fall back to typed values in the search inputs when nothing has been "selected" yet.
    const repoFromSearch = document.getElementById('chat-repo-search')?.value.trim();
    const branchFromSearch = document.getElementById('chat-branch-search')?.value.trim();
    const repo = s.repo || repoFromSearch;
    const ref = s.ref || (kind === 'branch' ? branchFromSearch : '');

    if (!repo) return showErr('Select a repository, or type <owner/repo>.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return showErr('Repository must be in <owner/repo> format.');
    if (kind === 'branch' && !ref) return showErr('Select or type a branch.');
    if (kind === 'pr' && (!Number.isFinite(s.prNumber) || s.prNumber <= 0)) return showErr('Select a pull request.');
    if (kind === 'pr' && !s.ref) return showErr('Unable to resolve PR head ref — try re-selecting the PR.');

    const scope = kind === 'repo'
        ? { kind: 'repo', repo }
        : kind === 'branch'
            ? { kind: 'branch', repo, ref }
            : { kind: 'pr', repo, ref: s.ref, prNumber: s.prNumber, title: s.title || undefined, author: s.author || undefined };

    btn.disabled = true;
    btn.textContent = '⏳ Cloning & seeding…';
    try {
        const res = await api.post('/api/chat/sessions', { scope, provider, title: title || undefined });
        if (res.error) { showErr(res.error); return; }
        chatActiveSessionId = res.session.id;
        closeModal();
        toast('Session created');
        renderPage();
    } catch (err) {
        showErr(err.message || 'Failed to create session');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create session';
    }
};

// ─── Thread view ────────────────────────────────────────────────────────────

async function renderChatThread(el, session) {
    const data = await api.get('/api/chat/sessions/' + encodeURIComponent(session.id));
    const messages = data.messages || [];

    el.innerHTML = `
        <div class="page-header">
            <div class="page-header-left" style="display:flex;align-items:center;gap:12px">
                <button class="btn btn-ghost btn-sm" onclick="closeChatSession()">← Sessions</button>
                <div>
                    <h1 class="page-title" style="margin:0">${esc(session.title)}</h1>
                    <p class="page-subtitle" style="margin:4px 0 0">${chatScopeSummary(session.scope)} · <code>${esc(session.provider)}</code></p>
                </div>
            </div>
        </div>
        <div id="chat-thread" style="border:1px solid var(--border-color);border-radius:12px;padding:16px;max-height:60vh;overflow-y:auto;margin-bottom:16px;background:var(--bg-secondary)">
            ${messages.map((m) => renderChatMessage(m)).join('') || '<p style="color:var(--text-muted);font-size:13px">No messages yet. Ask the agent something about this ' + session.scope.kind + '.</p>'}
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end">
            <textarea id="chat-input" class="form-input" rows="3" style="flex:1;resize:vertical" placeholder="Ask anything about this ${session.scope.kind}… (Ctrl+Enter to send)"></textarea>
            <button class="btn btn-primary" id="chat-send-btn" onclick="sendChatMessage('${esc(session.id)}')">Send</button>
        </div>
    `;

    // Scroll to bottom
    const thread = document.getElementById('chat-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;

    // Ctrl+Enter or Cmd+Enter to send
    const input = document.getElementById('chat-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                window.sendChatMessage(session.id);
            }
        });
        input.focus();
    }
}

function chatScopeSummary(scope) {
    if (scope.kind === 'repo') return `repo · ${esc(scope.repo)}${scope.ref ? ` @ ${esc(scope.ref)}` : ''}`;
    if (scope.kind === 'branch') return `branch · ${esc(scope.repo)} @ ${esc(scope.ref)}`;
    return `PR #${esc(String(scope.prNumber))} · ${esc(scope.repo)} (${esc(scope.ref)})`;
}

function renderChatMessage(m) {
    if (m.role === 'system') {
        // Don't render system messages in the thread — they're context for
        // the model, not for the user. The tool_cache ones in particular
        // would be huge.
        return '';
    }
    if (m.role === 'user') {
        return `<div class="chat-bubble chat-bubble-user"><div class="chat-bubble-content">${renderInlineText(m.content)}</div></div>`;
    }
    if (m.role === 'assistant') {
        if (m.toolCall) {
            const inputStr = JSON.stringify(m.toolCall.input, null, 2);
            return `
                <div class="chat-tool-card">
                    <details>
                        <summary>🔧 <strong>${esc(m.toolCall.name)}</strong> <span style="color:var(--text-muted);font-weight:400">${esc(summarizeToolInput(m.toolCall.input))}</span></summary>
                        <pre style="margin-top:8px;font-size:11px;overflow-x:auto">${esc(inputStr)}</pre>
                    </details>
                </div>`;
        }
        return `<div class="chat-bubble chat-bubble-assistant"><div class="chat-bubble-content">${renderAssistantText(m.content)}</div></div>`;
    }
    if (m.role === 'tool') {
        const isError = m.toolResult?.isError;
        const body = m.content || m.toolResult?.output || '';
        return `
            <div class="chat-tool-result ${isError ? 'chat-tool-result-error' : ''}">
                <details>
                    <summary>↩️ tool result${isError ? ' <span style="color:#ef4444">(error)</span>' : ''} <span style="color:var(--text-muted);font-weight:400;font-size:11px">(${body.length} chars)</span></summary>
                    <pre style="margin-top:8px;font-size:11px;max-height:240px;overflow:auto">${esc(body)}</pre>
                </details>
            </div>`;
    }
    return '';
}

function summarizeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    const keys = Object.keys(input);
    if (keys.length === 0) return '';
    // Show the first 2 keys with abbreviated values
    return keys.slice(0, 2).map((k) => {
        const v = input[k];
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
    }).join(', ');
}

/**
 * Lightweight markdown-ish renderer for assistant text — handles fenced
 * code blocks, inline `code`, **bold**, and paragraph breaks. Not full
 * CommonMark; deliberate MVP subset. HTML is escaped first so model
 * output can't inject arbitrary markup.
 */
function renderAssistantText(text) {
    if (!text) return '';
    // Escape HTML first.
    let safe = esc(text);
    // Fenced code blocks: ```lang\n ... \n```
    safe = safe.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
        return `<pre class="chat-code">${code}</pre>`;
    });
    // Inline code: `...` (after block extraction so it doesn't mangle them)
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold: **...**
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Paragraphs: split on blank lines
    return safe.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function renderInlineText(text) {
    return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
}

window.sendChatMessage = async function (sessionId) {
    if (chatThreadInFlight) {
        toast('A response is still streaming — wait for it to finish.', 'error');
        return;
    }
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('chat-send-btn');
    const thread = document.getElementById('chat-thread');
    if (!input || !thread) return;

    const message = input.value.trim();
    if (!message) return;

    chatThreadInFlight = true;
    input.value = '';
    input.disabled = true;
    btn.disabled = true;
    btn.textContent = '⏳';

    // Optimistically render the user bubble.
    thread.insertAdjacentHTML('beforeend', renderChatMessage({
        id: 'optimistic-' + Date.now(),
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
    }));
    const pending = document.createElement('div');
    pending.className = 'chat-pending';
    pending.innerHTML = '<span class="spinner"></span> Thinking…';
    thread.appendChild(pending);
    thread.scrollTop = thread.scrollHeight;

    try {
        await streamChatResponse(sessionId, message, thread, pending);
    } catch (err) {
        pending.innerHTML = `<span style="color:#ef4444">Error: ${esc(err.message || 'unknown')}</span>`;
    } finally {
        chatThreadInFlight = false;
        input.disabled = false;
        btn.disabled = false;
        btn.textContent = 'Send';
        input.focus();
    }
};

/**
 * Stream the SSE response for one turn. Appends one message bubble per
 * event; drops the "Thinking…" placeholder once the first event arrives.
 *
 * Uses `fetch` with a ReadableStream because EventSource doesn't support
 * POST bodies (and we need one here — the user message is the body).
 */
async function streamChatResponse(sessionId, message, thread, pending) {
    const resp = await fetch('/api/chat/sessions/' + encodeURIComponent(sessionId) + '/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + dashboardToken,
        },
        body: JSON.stringify({ message }),
    });

    if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => '');
        throw new Error(body || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstEventReceived = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE: `data: <json>\n\n`. Events are separated by blank lines.
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = raw.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;
            let event;
            try { event = JSON.parse(jsonText); } catch { continue; }

            if (!firstEventReceived) {
                firstEventReceived = true;
                if (pending && pending.parentNode) pending.parentNode.removeChild(pending);
            }

            handleChatStreamEvent(event, thread);
            thread.scrollTop = thread.scrollHeight;
        }
    }
}

function handleChatStreamEvent(event, thread) {
    if (event.type === 'assistant_text' || event.type === 'tool_call' || event.type === 'tool_result') {
        thread.insertAdjacentHTML('beforeend', renderChatMessage(event.message));
        return;
    }
    if (event.type === 'error') {
        thread.insertAdjacentHTML('beforeend',
            `<div class="chat-tool-result chat-tool-result-error"><strong>Error:</strong> ${esc(event.error || 'unknown')}</div>`);
    }
    // 'done' requires no rendering.
}

// ─── Init ───────────────────────────────────────────────────────────────────
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (e) => { if (e.target === $('#modal-overlay')) closeModal(); });
$$('.nav-link').forEach((link) => link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.dataset.page); }));

window.navigate = navigate;

// Hash routing: restore page from URL hash
const validPages = ['dashboard', 'my-prs', 'issues', 'workflows', 'chat', 'library', 'integrations', 'events', 'queue', 'logs', 'system', 'settings'];
const hashPage = window.location.hash.replace('#', '');
if (validPages.includes(hashPage)) currentPage = hashPage;
window.addEventListener('hashchange', () => {
    const p = window.location.hash.replace('#', '');
    if (validPages.includes(p) && p !== currentPage) navigate(p);
});

connectSSE();
navigate(currentPage);
