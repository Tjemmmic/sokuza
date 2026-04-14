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
let deck = [];
let libraryTemplates = [];
let librarySearchQuery = '';
let libraryActiveCategory = 'all';

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

const libraryItems = [
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
    { id: 'bug-report-validator', name: 'Bug Report Validator', description: 'Checks if bug reports have sufficient info: repro steps, expected/actual behavior, environment, errors.', category: 'issue-management', icon: '📝', tags: ['validation', 'bug', 'quality'], template: 'bug-report-validator', requiredIntegrations: ['github'], difficulty: 'easy', status: 'available', popular: false, defaultTrigger: { source: ['github'], event: ['issues.opened'] } },
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
];

// ─── Array helpers ──────────────────────────────────────────────────────────
function ensureArray(val) {
    if (val === undefined || val === null) return [];
    if (Array.isArray(val)) return val.filter(v => v !== '' && v !== undefined);
    return val === '' ? [] : [val];
}

// ─── API Layer ──────────────────────────────────────────────────────────────
const api = {
    async get(p) {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
    },
    async post(p, b) {
        const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
    },
    async put(p, b) {
        const r = await fetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
    },
    async del(p) {
        const r = await fetch(p, { method: 'DELETE' });
        if (!r.ok) throw new Error(`${r.status}`);
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
    // Redirect legacy templates page to library
    if (page === 'templates') page = 'library';
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

            case 'library': await renderLibrary(el); break;
            case 'integrations': await renderIntegrations(el); break;
            case 'events': await renderEvents(el); break;
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
    if (btn) { btn.disabled = true; const orig = btn.textContent; btn.textContent = '⏳'; }
    try {
        const result = await api.post('/api/workflows/run', {
            name: workflowName,
            inputs: {
                pull_request: { number: prNumber },
                owner,
                repo: `${owner}/${repo}`,
                repoName: repo,
                prNumber,
            },
        });
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

// Run a deck-sourced workflow against an issue
window.runIssueWorkflow = async function (workflowName, owner, repo, issueNumber) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        const result = await api.post('/api/workflows/run', {
            name: workflowName,
            inputs: {
                issue: { number: issueNumber },
                owner,
                repo: `${owner}/${repo}`,
                repoName: repo,
                issueNumber,
            },
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
        const result = await api.post('/api/workflows/run', {
            name: workflowName,
            inputs: {
                issue: { number: issueNumber },
                owner,
                repo: `${owner}/${repo}`,
                repoName: repo,
                issueNumber,
            },
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
    const runs = runsData.runs || [];

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
            <thead><tr><th>Name</th><th>Source</th><th>Trigger</th><th>Type</th><th>Steps</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>${workflows.map((wf) => {
                const hasInputs = wf.inputs?.length > 0;
                const sources = Array.isArray(wf.trigger?.source) ? wf.trigger.source : [wf.trigger?.source || 'github'];
                return `<tr>
                <td><strong style="cursor:pointer;color:var(--accent-hover)" onclick="openWorkflowEditor('${esc(wf.name)}')">${esc(wf.name)}</strong>${hasInputs ? '<br><span style="font-size:10px;color:var(--text-muted)">\u{1F3AE} has inputs \u2014 run from dashboard</span>' : ''}</td>
                <td>${sourceBadge(sources[0])}${sources.length > 1 ? `<span style="font-size:10px;color:var(--text-muted)"> +${sources.length - 1}</span>` : ''}</td>
                <td><code style="font-size:12px;color:var(--text-secondary)">${esc((() => { const evts = Array.isArray(wf.trigger?.event) ? wf.trigger.event : [wf.trigger?.event].filter(Boolean); return evts.map(e => eventLabelMap[e] || e).join(', '); })())}</code>${wf.trigger?.repo ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(Array.isArray(wf.trigger.repo) ? wf.trigger.repo.join(', ') : wf.trigger.repo)}</span>` : ''}</td>
                <td>${wf.template ? `<span class="badge badge-action">${esc(wf.template)}</span>` : '<span style="font-size:12px;color:var(--text-muted)">custom</span>'}${wf.enabled === false ? ' <span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);font-size:10px">disabled</span>' : ''}</td>
                <td>${wf.steps?.length ?? '\u2014'}</td>
                <td style="text-align:right">
                    <div class="btn-group" style="justify-content:flex-end">
                        <button class="btn ${hasInputs ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="openRunModal('${esc(wf.name)}')" title="Run workflow manually">${hasInputs ? '\u25b6 Run' : '\u25b6'}</button>
                        <button class="btn btn-ghost btn-sm" onclick="openWorkflowEditor('${esc(wf.name)}')">Edit</button>
                        <button class="btn btn-ghost btn-sm" onclick="duplicateWorkflow('${esc(wf.name)}')">Duplicate</button>
                        <button class="btn btn-danger-outline btn-sm" onclick="deleteWorkflow('${esc(wf.name)}')">Delete</button>
                    </div>
                </td>
            </tr>`}).join('')}</tbody>
        </table></div>` : `<div class="empty-state"><div class="empty-icon">\u26a1</div><p class="empty-text">No workflows yet</p><button class="btn btn-primary" onclick="openWorkflowEditor()">Create Your First Workflow</button></div>`}
    `;
}

// ─── Workflow Editor (structured) ───────────────────────────────────────────
window.openWorkflowEditor = function (existingName) {
    const isEdit = !!existingName;
    const wf = isEdit ? workflows.find((w) => w.name === existingName) : null;

    // If creating new and no name given, show Quick Start chooser
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
    // Sort: installed first, then popular, then available before coming-soon
    items.sort((a, b) => {
        const aInstalled = deck.includes(a.id) ? 1 : 0;
        const bInstalled = deck.includes(b.id) ? 1 : 0;
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
    const isInstalled = deck.includes(item.id);
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
                <button class="btn btn-ghost btn-sm" onclick="previewLibraryItem('${item.id}')">Preview</button>
            ` : `
                <button class="btn btn-primary btn-sm" onclick="installLibraryItem('${item.id}')">⚡ Install</button>
                <button class="btn btn-ghost btn-sm" onclick="previewLibraryItem('${item.id}')">Preview</button>
            `}
        </div>
    </div>`;
}

async function renderLibrary(el) {
    // If builder is active, render it instead
    if (builderState) { renderTemplateBuilder(el); return; }

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
    const isInstalled = deck.includes(item.id);
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
    const data = await api.get('/api/integrations');
    integrations = data.integrations || {};

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
    `;
}

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

// ═════════════════════════════════════════════════════════════════════════════
// EVENT LOG
// ═════════════════════════════════════════════════════════════════════════════
let eventFilter = { source: '', search: '' };

async function renderEvents(el) {
    const [evtData, statsData] = await Promise.all([api.get('/api/events'), api.get('/api/events/stats')]);
    events = evtData.events || [];
    eventStats = statsData;

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
    `;
}

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
        // Forward original event data for faithful replay
        const inputs = e.event?.payload?.inputs || {};
        const result = await api.post(`/api/workflows/${encodeURIComponent(wfName)}/run`, {
            inputs,
            _replayEvent: e.event,
        });
        toast(`Replayed event → "${wfName}" workflow started`);
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
    eventSource = new EventSource('/api/events/stream');
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
            if (currentPage === 'dashboard') renderPage();
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
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function renderSettings(el) {
    const data = await api.get('/api/config');
    const configYaml = typeof data.config === 'string' ? data.config : toYaml(data.config);

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

function toYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    let out = '';
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) {
            out += `${pad}${k}:\n`;
            for (const item of v) {
                if (typeof item === 'object') {
                    const lines = toYaml(item, indent + 2).split('\n').filter(Boolean);
                    out += `${pad}  - ${lines[0].trim()}\n`;
                    for (let i = 1; i < lines.length; i++) out += `${pad}    ${lines[i].trim()}\n`;
                } else {
                    out += `${pad}  - ${item}\n`;
                }
            }
        } else if (typeof v === 'object') {
            out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        } else {
            out += `${pad}${k}: ${v}\n`;
        }
    }
    return out;
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
        const pages = ['dashboard', 'my-prs', 'issues', 'workflows', 'templates', 'integrations', 'events', 'settings'];
        const num = parseInt(e.key);
        if (num >= 1 && num <= pages.length) { e.preventDefault(); navigate(pages[num - 1]); }
    }
});

// ─── Init ───────────────────────────────────────────────────────────────────
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (e) => { if (e.target === $('#modal-overlay')) closeModal(); });
$$('.nav-link').forEach((link) => link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.dataset.page); }));

window.navigate = navigate;

// Hash routing: restore page from URL hash
const validPages = ['dashboard', 'my-prs', 'issues', 'workflows', 'templates', 'library', 'integrations', 'events', 'settings'];
const hashPage = window.location.hash.replace('#', '');
if (validPages.includes(hashPage)) currentPage = hashPage;
window.addEventListener('hashchange', () => {
    const p = window.location.hash.replace('#', '');
    if (validPages.includes(p) && p !== currentPage) navigate(p);
});

connectSSE();
navigate(currentPage);
