# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are validated in CI: the release workflow refuses to publish a
version that doesn't have a matching `## [X.Y.Z]` heading below.

## [Unreleased]

Add changes targeting the next release here. To ship: move this section
under a new `## [X.Y.Z] - YYYY-MM-DD` heading, bump `version` in
`package.json`, commit, push to main. The release workflow tags +
publishes automatically.

## [0.1.2] - 2026-04-27

### Fixed

- **Zombie jobs: AbortSignal now threaded to executors.** The queue created an AbortController per job but never passed its signal to the executor, making `cancel()` and timeout a no-op. Signal is now forwarded through `engine.ts` into `executeWorkflow()`, and workflows check for abort between step groups.
- **Timed-out jobs no longer hold concurrency slots forever.** The timeout handler previously only called `abort()` without transitioning the job out of the running set. It now force-fails the job: marks it failed, releases the concurrency slot, removes it from the running map, and records it in history.
- **`latest-wins` dedup cancels the running duplicate.** Previously a new job with the same dedup key would enqueue but the already-running duplicate kept going, defeating the purpose of latest-wins. The running job is now aborted and moved to history before the replacement is enqueued.
- **Dedup keys resolve correctly for PR comments.** `parseEvent` only looked at `body.pull_request` to extract `prNumber`, but `issue_comment.created` events on PRs carry the number under `body.issue` (with `issue.pull_request` set). All such comments collapsed to the same dedup key, letting duplicates pile up.
- **Auto-fix trigger matches the actual review event.** `auto-fix-address-review` only triggered on `issue_comment.created`, but `github-create-review` fires `pull_request_review.submitted`. The intended loop never closed; random comments containing the marker triggered spurious runs instead. Trigger now matches both events, and the filter uses OR-across-paths (`payload.review.body|payload.comment.body`) to find the marker in either payload shape.
- **`address-review` reads marker from review body.** `resolveReviewRunId` only checked `comment.body` for the `sokuza:run-id` marker. When the trigger fires via `pull_request_review.submitted`, the marker is in `review.body`. Now checks both.

## [0.1.1] - 2026-04-26

### Changed

- **README rewritten** to match current reality. The previous README pre-dated the dashboard, address-review action, auto-fix loop, CLI command surface, and most of the run-store / workdir-store / pricing infrastructure. New version documents what actually ships, with accurate examples, an honest pre-1.0 disclaimer, and a project layout that mirrors `src/`.
- **`templates/ai-pr-review.yaml` header comment** no longer references the long-removed `use_actual_review: true` parameter. Now points users at the `auto-fix-pr-review` template when they want the closed review→fix→re-review loop.

## [0.1.0] - 2026-04-26

Initial public release.

### Added

- **Workflow engine** with YAML-defined triggers, parameter templating, parallel groups, queue with dedup/concurrency/timeouts, and a per-workflow run history.
- **GitHub integration**: webhook handling, PR diff fetching with smart truncation, repo cloning, comment posting, PR creation, label management, and a Reviews API path that posts inline-anchored comments.
- **Slack integration** for notifications and slash commands.
- **`gh-cli` integration** for repos that prefer GitHub CLI over webhooks.
- **AI provider registry** supporting Anthropic API, any OpenAI-compatible API, and CLI providers (`claude-code`, `opencode`). Per-workflow / per-step provider override; fallback chain on failure.
- **`ai-review` action** with structured JSON output, automatic diff truncation, per-file truncation observability, and a parse-failure repair loop that re-queries the provider with a focused prompt to recover from intermittent JSON output failures.
- **`ai-agent` action** for tool-using agentic flows in cloned repos.
- **`address-review` action** that consumes an AI review and either:
  - posts a GitHub review with line-suggestion comments (`mode: suggest`), or
  - commits and pushes fixes to the PR head branch (`mode: push`).
  - Includes loop guards: iteration cap, identical-issue-set fingerprint, merge-ready heuristic, in-flight lock label, skip label, cooldown, PR-closed check.
- **Persistent per-PR workdirs** (`~/.sokuza/auto-fix-workdirs/`) with file-based locks, stale-lock recovery on engine startup, and idle eviction. Configurable root via `SOKUZA_WORKDIR_ROOT`.
- **Run-store** at `~/.sokuza/runs/` recording every `ai-review` and `address-review` run with strategy, provider, token usage, structured issues, and per-file truncation outcomes. Include `parseFailureKind` and `repairAttempts` for parse-failure debugging.
- **Pricing** with built-in defaults at `src/core/pricing.ts` and per-host overrides at `~/.sokuza/pricing.yaml`. Costs are computed at read time so historical runs re-cost as prices change.
- **Dashboard** (vanilla JS, no bundler):
  - Workflows browser + manual runs
  - AI Reviews page: stats, filters, labeling, parse-failure raw output, repair history
  - Auto-Fix page: address runs, persistent workdirs (with size + evict), per-PR convergence timeline interleaving reviews + address runs with cost rollups
  - Chat sessions per repo/branch/PR
  - Real-time updates over SSE
- **Slash commands**: `/sokuza fix [mode=]` triggers an address run, `/sokuza skip` / `/sokuza unskip` pauses or resumes auto-fix on a PR.
- **Workflow templates** including `auto-fix-pr-review`, `auto-fix-address-review`, `sokuza-slash-commands`, plus a library of Slack/CI/issue-triage starters.
- **CLI**: `sokuza init`, `sokuza`, `sokuza status`, `sokuza logs`, `sokuza token`, `sokuza service [enable|disable|status]`, `sokuza update`, `sokuza version`.
- **Discovery and security**:
  - `/health` endpoint with strict CORS — only `https://sokuza.ai` (or explicit dev origins) may read cross-origin.
  - DNS-rebinding guard: `Host` header must be in the allow-list (`localhost`, `127.0.0.1`, `::1`, `sokuza.localhost`, plus configured bind host and `SOKUZA_ALLOWED_HOSTS`).
  - Bearer-token gate on `/api/*` and the dashboard, stored at `~/.sokuza/dashboard-token` with `0600`.
- **Service installer** for macOS launchd and Linux systemd units, with autostart and log management.
