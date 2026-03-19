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

Available templates: `ai-pr-review`, `log-events`, `enforce-rules`, `review-notify-slack`

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

## Exposing to the Internet

For development, use [localtunnel](https://github.com/localtunnel/localtunnel) to expose your local server:

```bash
npx -y localtunnel --port 3500
```

Then configure the provided URL as your webhook endpoint in GitHub/Slack settings.
