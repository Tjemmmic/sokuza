# Sokuza

A workflow automation engine for the kind of work AI is suddenly good at — code review, fix-on-feedback loops, triage, follow-up. Wires GitHub / Slack / webhooks / cron to AI providers (Anthropic API, Claude Code CLI, opencode, anything OpenAI-compatible) and gives you a dashboard to watch what it's doing.

> Pre-1.0. Breaking changes possible until 1.0. See [CHANGELOG.md](CHANGELOG.md).

---

## Install

```bash
npm install -g sokuza
sokuza init                # scaffolds ~/.sokuza/config.yaml
sokuza                     # starts the engine + dashboard
```

The first run prints a one-time dashboard link with the bearer token embedded. Open it; the dashboard handles the rest.

For a project-local install (running against the repo, not from `~/.sokuza/`):

```bash
sokuza init --local        # config + .env land in CWD
sokuza --config ./sokuza.config.yaml
```

Requires Node 20+.

## Five-minute first review

1. Add a GitHub Personal Access Token (`repo` scope is enough) to `~/.sokuza/config.yaml`:

   ```yaml
   integrations:
     github:
       token: ${GITHUB_TOKEN}
       webhookSecret: ${GITHUB_WEBHOOK_SECRET}
   ```

2. Tell sokuza to run an AI review on PR open:

   ```yaml
   workflows:
     - name: review-prs
       template: ai-pr-review
       trigger:
         repo: my-org/my-repo
   ```

3. Restart sokuza, expose port 24847 to GitHub (any tunnel works):

   ```bash
   npx -y localtunnel --port 24847
   ```

   Add the tunnel URL + `/webhooks/github` as a webhook in your repo's settings, with the same `GITHUB_WEBHOOK_SECRET`.

4. Open a PR. Watch the **AI Reviews** page in the dashboard.

## Auto-fix loop (review → fix → re-review)

Sokuza can take its own AI reviews and act on them — either as inline GitHub suggestions (safe) or as direct commits + pushes to the PR branch (less safe, gated). The loop converges automatically when the review judges the PR merge-ready or the iteration cap is hit.

Two cooperating workflows:

```yaml
workflows:
  # 1. Posts the AI review as a real GitHub Review with the marker
  #    `<!-- sokuza:run-id=... -->` that triggers step 2.
  - name: auto-pr-review
    template: auto-fix-pr-review
    trigger:
      repo: my-org/my-repo

  # 2. Wakes on the marker, runs the /address-review skill in a
  #    persistent per-PR workdir, posts a review-with-suggestions or
  #    commits + pushes fixes (depending on `mode`).
  - name: auto-address-review
    template: auto-fix-address-review
    trigger:
      repo: my-org/my-repo
    params:
      mode: suggest        # 'suggest' (post inline suggestions) or 'push'
      max_iterations: 5
      merge_ready:
        max_p1: 0
        max_p2: 1
        max_p3: -1         # -1 = unlimited
```

Loop guards built in: iteration cap, identical-issue-set fingerprint repeat, merge-ready heuristic, in-flight lock label, `sokuza-no-auto-fix` skip label, cooldown between iterations, PR-closed check.

Reviewers can also drive it manually with comment commands (set up via the `sokuza-slash-commands` template):

| Command | Effect |
|---|---|
| `/sokuza fix` | Trigger an address-review run on this PR |
| `/sokuza fix mode=push` | Same, but force push-mode regardless of workflow config |
| `/sokuza skip` | Add the `sokuza-no-auto-fix` label, halting auto-fix on this PR |
| `/sokuza unskip` | Remove the skip label |

## Dashboard

The dashboard is at `http://localhost:24847/` (open via the one-time link `sokuza` prints, or get the token any time with `sokuza token`).

| Page | What's there |
|---|---|
| **Dashboard** | Recent events, active workflows, quick-action library |
| **Workflows** | Browse / edit / manually trigger workflows |
| **AI Reviews** | Every `ai-review` run with truncation breakdown, parse-failure raw output, repair-attempt history, labeling (👍/👎 + note), 30-day stats |
| **Auto-Fix** | Address runs (mode, iter, issues, tests, cost), persistent workdirs (size + evict), per-PR convergence timeline interleaving reviews + address runs |
| **Chat** | Repo / branch / PR-scoped chat sessions with the AI agent |
| **Integrations** | AI providers + GitHub/Slack/webhook setup |
| **Event Log / Queue / Logs** | Real-time event stream, queue state, application log |

## CLI

| Command | Purpose |
|---|---|
| `sokuza` | Start the engine (default) |
| `sokuza init [--local] [--force]` | Scaffold config (default `~/.sokuza/config.yaml`; `--local` for CWD + `.env`) |
| `sokuza status` | Report locally-running instances |
| `sokuza logs [-f] [-n N]` | Tail the application log |
| `sokuza token [--rotate] [--json]` | Print the dashboard bearer token |
| `sokuza service enable` / `disable` / `restart` / `status` | Install/manage the autostart service (launchd on macOS, systemd on Linux) |
| `sokuza update` | Upgrade via the installer (npm, brew) |
| `sokuza version` | Print version |

## Configuration

`~/.sokuza/config.yaml` — auto-scaffolded from [sokuza.config.example.yaml](sokuza.config.example.yaml) on first run, `chmod 0600` so it's safe to embed AI provider API keys directly. Or use `${VAR_NAME}` interpolation from environment / `.env`.

The example file documents every option. Headlines:

- `server: { port, host }` — defaults to `127.0.0.1:24847`. Set `host: 0.0.0.0` only when you need to receive webhooks from a tunnel; nothing in front of `/api/*` and the dashboard except a bearer token + Host-header guard.
- `ai.providers` — register named providers (Anthropic API, OpenAI-compatible API, CLI like `claude` / `opencode`). Workflows pick by name. Per-workflow / per-step override + fallback chain.
- `integrations` — GitHub, Slack, webhook, gh-cli, github-poll, cron.
- `workflows` — list of workflow definitions (or template references).
- `auto_fix` — global defaults for the address-review action (mode, max_iterations, merge_ready thresholds). Per-workflow params override.

Pricing for cost estimates lives in [src/core/pricing.ts](src/core/pricing.ts) (built-in defaults) plus an optional `~/.sokuza/pricing.yaml` override. Costs are computed at read time, so updating prices retroactively re-costs historical runs.

## Built-in actions

| Action | Where it lives |
|---|---|
| `log`, `webhook` | [src/actions/log.ts](src/actions/log.ts), [webhook.ts](src/actions/webhook.ts) |
| `ai-review` | [src/actions/ai-review.ts](src/actions/ai-review.ts) — structured-JSON code review with parse-failure repair loop |
| `ai-agent` | [src/actions/ai-agent.ts](src/actions/ai-agent.ts) — tool-using agent in a cloned repo |
| `address-review` | [src/actions/address-review.ts](src/actions/address-review.ts) — consumes a review, runs the [/address-review skill](src/actions/address-review-skill.ts), posts suggestions or pushes commits |
| `github-fetch-diff`, `github-comment`, `github-clone-repo`, `github-create-pr`, `github-create-review`, `github-fetch-reviews`, `github-add-label`, `github-remove-label` | [src/integrations/github/actions/](src/integrations/github/actions/) |
| `slack-send-message`, `slack-react` | [src/integrations/slack/actions/](src/integrations/slack/actions/) |

## Templates

Top-level templates (user-facing):

| Template | Purpose |
|---|---|
| `ai-pr-review` | One-shot AI review posted as a comment |
| `auto-fix-pr-review` | AI review posted as a real GitHub Review with the marker the auto-fix loop needs |
| `auto-fix-address-review` | Triggers when the marker comment lands; runs address-review |
| `sokuza-slash-commands` | `/sokuza fix` / `skip` / `unskip` |
| `fix-github-issue` | Manual workflow to fix a GitHub issue end-to-end |
| `enforce-rules` | Repo-rule checks |
| `respond-to-reviews` | Reply to incoming reviews on a PR |
| `review-notify-slack` | Cross-source: PR review → Slack ping |
| `log-events` | No-op logger, useful for trigger debugging |

Library templates ship under [templates/library/](templates/library/) — auto-label PRs, dependency review, license check, security audit, daily digest, etc. (~28 starters). Browse them in the dashboard's Library page.

## Workflow YAML

Minimum:

```yaml
workflows:
  - name: hello
    trigger:
      source: github
      event: pull_request.opened
    steps:
      - action: log
        params: { message: "PR #{{event.payload.pull_request.number}}" }
```

Anything more interesting is in [sokuza.config.example.yaml](sokuza.config.example.yaml) and [templates/](templates/). Workflows compose: trigger filters, parameter templating (`{{event.x.y}}`, `{{steps.<id>.<field>}}`, `{{slash.args.mode}}`), parallel-step groups, per-step `condition` and `timeout`, per-step provider override, queue config (concurrency, dedup, priority).

## Security

- **Bearer token** on `/api/*` and the dashboard. Generated once, stored at `~/.sokuza/dashboard-token` with `0600`. Rotate with `sokuza token --rotate`.
- **DNS-rebinding guard**: `Host` header allow-list (`localhost`, `127.0.0.1`, `::1`, `sokuza.localhost`, plus any configured bind hostname and `SOKUZA_ALLOWED_HOSTS`). Exempt: `/health` and `/webhooks/*`.
- **CORS lock on `/health`**: only `https://sokuza.ai` (and the local dev origins behind `SOKUZA_ALLOW_DEV_ORIGINS`) may read it cross-origin. Never `*`.
- **Webhook signature verification** for the GitHub and Slack integrations.
- The dashboard binds to `127.0.0.1` by default. Don't move it off loopback unless you've put auth in front.

## Observability

- **Run records** at `~/.sokuza/runs/ai-review/<date>/<id>.json` and `~/.sokuza/runs/address-review/<date>/<id>.json`. Capture inputs, provider, model, token usage, structured issues, per-file truncation outcomes, parse-failure kinds, repair attempts.
- **Persistent workdirs** at `~/.sokuza/auto-fix-workdirs/<owner>/<repo>/<pr>/`. File-locked, stale-lock recovery on engine startup, idle eviction, evict-on-PR-close. Configurable root via `SOKUZA_WORKDIR_ROOT`.
- **Dashboard** surfaces all of the above with filtering, drill-down, labeling, cost estimates.

## Development

```bash
npm install
npm run dev       # tsx watch — auto-restart on TS changes
npm test
npm run lint      # tsc --noEmit
npm run build     # tsup → dist/index.js (single bundled file)
```

Tests use [vitest](https://vitest.dev/). Real-side-effect tests (filesystem, GitHub API) use mocks; tests that touch `~/.sokuza/` thread through `SOKUZA_RUNS_DIR` / `SOKUZA_WORKDIR_ROOT` environment overrides so they never hit the real home directory.

To work against the public marketing site (`https://sokuza.ai`)'s `/open` discovery probe from a local Astro dev server, set `SOKUZA_ALLOW_DEV_ORIGINS=1` when starting sokuza so its `/health` CORS allow-list also accepts `localhost:432[123]`.

## Project layout

```
src/
├── index.ts                     # Entry point, CLI dispatcher
├── version.ts
├── cli/                         # `sokuza init|status|logs|token|service|update`
├── core/
│   ├── engine.ts                # Orchestrator
│   ├── workflow.ts              # Trigger matching, step execution, templating
│   ├── queue.ts                 # Job queue with dedup/concurrency/timeouts
│   ├── config.ts, config-store.ts
│   ├── templates.ts             # YAML template loader
│   ├── ai-providers.ts          # Provider registry, completion + agent runners
│   ├── diff-truncator.ts        # Smart per-file diff truncation
│   ├── run-store.ts             # ai-review + address-review records
│   ├── workdir-store.ts         # Persistent per-PR git workdirs
│   ├── pricing.ts               # Token-cost computation
│   ├── chat-store.ts, chat-agent.ts, chat-tools.ts
│   └── log-store.ts
├── actions/
│   ├── log.ts, webhook.ts
│   ├── ai-review.ts             # JSON-output review with parse-failure repair
│   ├── ai-agent.ts              # Tool-using agent in a cloned repo
│   ├── address-review.ts        # /address-review skill executor
│   ├── address-review-skill.ts  # Embedded skill prompt
│   └── review-templates.ts      # Prompt + parser + renderer
├── integrations/
│   ├── github/                  # Webhooks + actions
│   ├── github-poll/             # Polling alternative when webhooks aren't an option
│   ├── gh-cli/                  # Uses `gh` CLI, no webhook setup needed
│   ├── slack/
│   ├── webhook/                 # Generic inbound webhooks
│   └── cron/                    # Scheduled triggers
├── server/
│   ├── server.ts                # Fastify app + `/health`
│   ├── auth.ts                  # Bearer token + DNS-rebinding guard
│   ├── api.ts                   # Dashboard REST API
│   └── discovery.ts             # `/health`, runtime state, port fallback
└── __tests__/

dashboard/                       # Vanilla-JS SPA, no bundler
templates/                       # Workflow YAML templates
templates/library/               # Browseable starter library
scripts/check-changelog.mjs      # Release-time changelog gate
```

## License

MIT — see [LICENSE](LICENSE).
