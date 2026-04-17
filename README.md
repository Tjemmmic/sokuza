# Sokuza

**Cross-platform AI workflow automation engine.**

Sokuza connects multiple event sources — GitHub, Slack, custom webhooks, and scheduled timers — to composable workflows.  A single workflow can react to a GitHub PR and post to Slack, or a Slack command can trigger a code review. Templates make common patterns one-liners; custom steps let you build anything.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# 3. Create your config
cp sokuza.config.example.yaml sokuza.config.yaml

# 4. Start in development mode (auto-reload)
npm run dev
```

## Environment Variables

Create a `.env` file (see `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | For GitHub | Secret for verifying GitHub webhook signatures |
| `GITHUB_TOKEN` | For GitHub | GitHub PAT with `repo` scope |
| `SLACK_BOT_TOKEN` | For Slack | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | For Slack | Slack app signing secret |
| `ANTHROPIC_API_KEY` | For AI* | Anthropic API key for direct API access |

\*If no `ANTHROPIC_API_KEY` is set, AI actions fall back to the **Claude Code CLI** (requires `claude` CLI installed).

## Integrations

| Integration | Webhook Endpoint | Description |
|---|---|---|
| **GitHub** | `/webhooks/github` | PR events, issues, pushes, reviews |
| **GitHub CLI** | _(polling-based)_ | Zero-config GitHub integration using `gh` CLI |
| **Slack** | `/webhooks/slack/events` `/webhooks/slack/commands` | Messages, @mentions, reactions, slash commands |
| **Webhook** | `/webhooks/custom/:name` | Accept arbitrary JSON from any source |
| **Cron** | _(timer-based)_ | Scheduled triggers (every-5m, hourly, daily, etc.) |

### Actions

**Generic** (work with any source):

| Action | Description |
|---|---|
| `log` | Log a message with event context |
| `webhook` | POST a payload to an external URL |
| `ai-review` | Send a diff to Claude for code review |
| `ai-agent` | Run Claude Code CLI inside a repo with tool access |

**GitHub-specific** (auto-registered when GitHub is enabled):

| Action | Description |
|---|---|
| `github-fetch-diff` | Fetch a PR's diff and file list |
| `github-comment` | Post a comment on a PR or issue |
| `github-clone-repo` | Clone a repo to a temp directory |
| `github-create-pr` | Commit changes, push, and open a PR |
| `github-create-review` | Submit a PR review (approve/request-changes/comment) via REST API |

**Slack-specific** (auto-registered when Slack is enabled):

| Action | Description |
|---|---|
| `slack-send-message` | Post a message to a channel |
| `slack-react` | Add an emoji reaction to a message |

## Workflow Config

### Templates

Drop a YAML file in `templates/` and reference it by name:

```yaml
workflows:
  - name: review-prs
    template: ai-pr-review
    trigger:
      event: pull_request.opened
      repo: "my-org/my-repo"
```

Available templates: `ai-pr-review`, `log-events`, `enforce-rules`, `review-notify-slack`, `respond-to-reviews`, `security-audit`, `deep-audit`

**Library templates** (`templates/library/`): Additional workflow templates for specialized tasks like security audits, dependency reviews, and repo scouting. All review templates now use a standardized P1/P2/P3 priority system with consistent output format.

## AI Code Review System

Sokuza provides a standardized AI code review system with consistent formatting, priority levels, and approval logic across all review templates.

### Review Features

- **Consistent Format**: All reviews follow the same markdown structure with standardized headers and issue format
- **Priority System**: Three-level priority system (P1/P2/P3) with clear blocking criteria
- **Approval Logic**: Deterministic approval decisions based on issue counts
- **Multiple Review Types**: Support for general code reviews, security audits, and deep architectural audits

### Review Priority Levels

| Priority | Name | Description | Blocking? |
|----------|------|-------------|------------|
| **P1** | Blocking | Bugs, security vulnerabilities, crashes, broken API contracts | Yes |
| **P2** | Should Fix | Missing error handling, untested logic, performance issues | No (3+ blocks) |
| **P3** | Nice to Have | Readability, naming, minor style improvements | No |

### Approval Thresholds

A PR is **approved** when:
- Zero P1 issues AND
- Fewer than 3 P2 issues

A PR **requests changes** when:
- Any P1 issue exists OR
- 3 or more P2 issues exist

### Review Output Format

All reviews follow this standardized structure:

```markdown
## 🤖 AI Code Review

### Summary
[One-sentence overview]

### Issues Found
[Count] total issues: [X] P1 (blocking), [Y] P2 (should fix), [Z] P3 (nice to have)

---

❗ P1 — [Specific title]
**File:** `path/to/file.ts:L42-L50`
**Problem:** [What is wrong and WHY]
**Fix:** [Exact suggestion]

---

### Review Decision
✅ APPROVE / ❌ CHANGES REQUESTED

### Quick Reference
- P1: [title] • [title]
- P2: [title] • [title] • [title]
```

### Posting Actual GitHub Reviews

By default, AI reviews are posted as comments. To post as actual GitHub reviews (which appear in the PR's review section):

```yaml
workflows:
  - name: review-prs
    template: ai-pr-review
    trigger:
      event: pull_request.opened
      repo: "my-org/my-repo"
    params:
      use_actual_review: true  # Requires gh-cli integration
```

**Note**: `use_actual_review` requires the `gh-cli` integration to be enabled. The `gh` CLI must be installed and authenticated (`gh auth login`).

### Cross-Source Workflows

A single trigger from one source can fire actions across multiple platforms:

```yaml
workflows:
  - name: pr-review-notify
    trigger:
      source: github
      event: pull_request.opened
    steps:
      - id: diff
        action: github-fetch-diff
      - id: review
        action: ai-review
      - action: github-comment
        params:
          body: "{{steps.review.review}}"
      - action: slack-send-message
        params:
          channel: "#code-reviews"
          text: "New review on {{event.metadata.repo}}"
```

### Scheduled Workflows

```yaml
integrations:
  cron: {}

workflows:
  - name: daily-health
    trigger:
      source: cron
      event: daily
    steps:
      - id: repo
        action: github-clone-repo
        params: { repo: "my-org/my-repo" }
      - action: ai-agent
        params:
          workdir: "{{steps.repo.path}}"
          prompt: "Check for vulnerabilities"
      - action: slack-send-message
        params:
          channel: "#engineering"
          text: "{{steps.analysis.review}}"
```

### Custom Webhook Workflows

```yaml
integrations:
  webhook:
    endpoints:
      deploy-hook:
        secret: "${DEPLOY_HOOK_SECRET}"

workflows:
  - name: deploy-notify
    trigger:
      source: webhook
      event: deploy-hook
    steps:
      - action: slack-send-message
        params:
          channel: "#deploys"
          text: "Deployed {{event.payload.version}} to {{event.payload.env}}"
```

### Conditional Steps

Steps only run when a condition is truthy:
```yaml
- action: github-create-pr
  condition: "{{steps.analysis.changes_needed}}"
  params: { workdir: "{{steps.repo.path}}" }
```

### Shorthand Triggers

```yaml
trigger:
  event: pull_request.opened
  repo: "my-org/my-repo"
  branch: "main"
  author: "dependabot[bot]"
  labels: ["needs-review"]
```

## Project Structure

```
src/
├── index.ts                             # Entry point
├── core/
│   ├── types.ts                         # Shared types
│   ├── config.ts                        # YAML config loader
│   ├── engine.ts                        # Main orchestrator
│   ├── templates.ts                     # YAML template loader
│   ├── diff-truncator.ts               # Smart diff truncation
│   └── workflow.ts                      # Trigger matching & execution
├── actions/                             # Generic (source-agnostic) actions
│   ├── registry.ts
│   ├── log.ts
│   ├── webhook.ts
│   ├── ai-review.ts
│   └── ai-agent.ts
├── integrations/
│   ├── registry.ts
│   ├── github/                          # GitHub integration
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── events.ts
│   │   ├── signature.ts
│   │   └── actions/                     # GitHub-specific actions
│   │       ├── fetch-diff.ts
│   │       ├── comment.ts
│   │       ├── clone-repo.ts
│   │       └── create-pr.ts
│   ├── slack/                           # Slack integration
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── events.ts
│   │   ├── signature.ts
│   │   └── actions/
│   │       ├── send-message.ts
│   │       └── react.ts
│   ├── webhook/                         # Generic inbound webhooks
│   │   └── index.ts
│   └── cron/                            # Scheduled triggers
│       └── index.ts
├── server/
│   └── server.ts
└── __tests__/
templates/                               # YAML workflow templates
├── ai-pr-review.yaml
├── log-events.yaml
├── enforce-rules.yaml
└── review-notify-slack.yaml
```

## Development

```bash
npm run dev          # Start with auto-reload
npm run build        # Build for production
npm run lint         # Type-check without emitting
npm test             # Run tests
```

### Testing the public site against a local sokuza

When running the sokuza-web Astro dev server against a local sokuza (the
"Open app" detector at `/open`), the browser's origin is
`http://localhost:4321` (or 4322/4323 if 4321 is busy). The `/health`
endpoint's CORS allow-list only admits `https://sokuza.ai` in production,
so cross-origin probes from the dev site are rejected by default.

Set `SOKUZA_ALLOW_DEV_ORIGINS=1` when starting sokuza to additionally
accept the Astro dev origins:

```bash
SOKUZA_ALLOW_DEV_ORIGINS=1 sokuza
```

This is a development-only escape hatch — leave it unset in production so
no random dev origin on the user's machine can read `/health`.

## Exposing to the Internet

For development, use [localtunnel](https://github.com/localtunnel/localtunnel) to expose your local server:

```bash
npx -y localtunnel --port 24847
```

Then configure the provided URL as your webhook endpoint in GitHub/Slack settings.
