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

### Added

#### Visual editor and graph runtime

- **Visual node-graph workflow editor.** Workflows can now be authored on a drag-and-drop canvas: drag node types from the palette, wire output ports to input ports, configure each node in the inspector. Supersedes the YAML/form editor as the default surface — the legacy editor is reachable via `openLegacyWorkflowEditor()` for power users. Existing workflows render as auto-laid-out graphs and can be re-wired visually.
- **Pluggable node registry.** Adding a new feature is now a single `NodeDefinition` object in `src/core/nodes/builtins.ts` (or registered by an integration). The registry drives the palette (via `GET /api/nodes`), the inspector form, and the runtime — no parallel UI/runtime/schema edits.
- **Graph runtime.** New `executeGraph()` runs node graphs with topo-sort layered parallelism, per-node `condition` / `on_error` / `timeout`, and `{{nodes.<id>.<port>}}` template interpolation alongside the legacy `{{steps.x}}` / `{{event.x}}` / `{{inputs.x}}`. Workflows opt in by setting `graph:` instead of `steps:`; the engine dispatches automatically.
- **Trigger-as-node.** Each integration source has a `trigger.<source>` node (github, github-poll, gh-cli, slack, webhook, cron, manual). Trigger node config is bridged to the legacy `TriggerDefinition` so event matching keeps working unchanged.
- **Recipe picker on `+ New Workflow`.** Pre-wired starter graphs for Manual PR Review, Auto PR Review, Auto-Fix Loop, Log Events, plus a Blank canvas. Replaces the empty-canvas onboarding cliff.
- **Type-validated wiring.** Each port carries a semantic type (`pr`, `issue`, `review`, `diff`, `commits`, `event`, `string`, `number`, `boolean`, `json`, `any`). Incompatible wires are rejected on the canvas with a clear toast; compatible inputs pulse green while wiring. Required-port indicators (red dot when empty, green when wired/configured) plus an `Inputs (X/Y connected)` panel in the inspector.
- **Per-input guidance.** Inspector lists every wireable input with its status, a "wire from existing node" picker, and a "or add a node that provides this" one-click action. Closes the "how do I get a diff?" question that the type system raised.
- **Config-driven dynamic output ports.** Trigger nodes grow ports based on their config — selecting `pull_request.opened` on the GitHub trigger reveals `pr`/`prNumber`/`repo`/`branch`/`author`; defining a manual-trigger input creates a typed output port for it.

#### New node groups

- **Data group (7 nodes).** Bridges closed structural types into the scalars action nodes need:
  - `data.json-pluck` — universal: dot-path into any object/JSON, emits `value` + `valueText` + `exists`. Numeric segments index arrays.
  - `data.pr-fields` — splits a PR object into `number` / `repo` / `headRepo` / `isCrossRepo` / `headRepoDeleted` / `branch` / `headFullRef` / `baseBranch` / `headSha` / `baseSha` / `author` / `title` / `body` / `state` / `draft` / `url` / `labels`. `headFullRef` emits the GitHub-canonical `owner:branch` form for fork PRs. `headRepoDeleted` flags PRs whose head fork has been removed so downstream clone-repo doesn't silently target the wrong place.
  - `data.issue-fields` — same shape for issues.
  - `data.review-fields` — splits a structured AI review into `summary` / `issues` / `mergeReady` plus derived `blockingCount` (P0/P1) / `nonBlockingCount` / `totalCount`.
  - `data.commits-fields` — pulls `count` / `latestSha` / `latestMessage` / `latestAuthor` / `messages` / `shas` from a push event's commits.
  - `data.event-fields` — splits the canonical event envelope into `source` / `eventName` / `timestamp` / `payload` / `metadata`.
  - `data.template` — visible composition node: textarea body with `{{nodes.x.y}}` placeholders, output `text`.
- **Git group (1 node, provider-agnostic).**
  - `git.commit-and-push` — stages (with optional `paths`), commits, and pushes from a workdir. Works against GitHub, GitLab, self-hosted git. Supports per-call branch override with explicit-existence detection (no try/catch swallow), validates paths against absolute / `..` / NUL / Windows-style backslash escape, validates branch names against leading `-` / `HEAD` / whitespace / control chars.
- **GitHub round-trip nodes (5 new).**
  - `github.fetch-pr` — number → full PR object (pipes into `data.pr-fields`).
  - `github.fetch-issue` — number → full Issue object.
  - `github.merge-pr` — merge / squash / rebase via API. Throws on `405` (not mergeable) and on a `200` response with `merged !== true` (silent-failure guard); distinguishes a missing `merged` field from explicit `false` so operators can triage API shape changes.
  - `github.update-pr` — PATCH a PR's title / body / state / base. Client-side guards against an empty PATCH body and against empty-string title/base.
  - `github.wait-for-checks` — polls Checks API + legacy combined-status until done or timeout. Dedupes statuses by `context` (keeping latest `updated_at`), folds aggregate combined `state` into the keep-polling decision so a queued context doesn't pass the success gate, validates `interval` ∈ [1s, 10min] and `interval ≤ timeout`, parallelises the two API calls, caps `getCheckRuns` pagination at 5 pages.
- **Flow group: `flow.filter-list`.** Filter a JSON array by a per-item field test (`equals` / `not-equals` / `truthy` / `exists` / `contains`). Outputs `filtered` / `count` / `first`.

### Changed

- **Type-tagged every wireable input across the builtins.** Closed types (`pr`, `issue`, `review`, `diff`, `commits`) can no longer be silently coerced into a text field. A contract test now iterates every registered builtin and reports any wireable input missing its type tag, so this can never regress.
- **`clone-repo` and `create-pr` re-emit construction-time fields.** Both now emit `repo` and `branch` so downstream nodes can wire from a single source instead of also wiring back to the trigger.
- **`slack.send-message` output renamed `ts` → `timestamp`** to match `slack.react`'s input — the obvious wire now works.
- **Label nodes expose typed success outputs.** `github.add-label` emits `success` + `appliedLabels`; `github.remove-label` emits `success` + `removedLabel`. Workflows can branch on label outcomes without parsing the synthetic `result` bag.
- **`GitHubApiClient` extended** with `updatePullRequest`, `mergePullRequest`, `getIssue`, `getCheckRuns` (paginated, capped at `maxPages=5`), `getCombinedStatus`. All error responses run through `truncateErrorBody()` (compact-JSON form, 500-char cap, `[truncated, N total]` note) so pretty-printed GitHub errors don't waste the budget on whitespace.
- **Shared `_target.ts` resolver** for owner/repo/number across all GitHub action handlers. Empty strings (`''`) and zero are treated as "not supplied" so a blank UI form field doesn't overshadow event metadata. Malformed `params.repo` (e.g. URL-paste fragments) is only flagged as an error when no other source resolved owner+repo.
- **Shared `git-helpers.ts`** module replaces the `execGit` / `execGitOutput` copy-paste between `clone-repo` and `create-pr`.

### Fixed

- **Wire endpoints align at any pan/zoom.** Moved the wire SVG out of the transformed canvas so endpoints render in viewport pixel space.
- **Workflow templates with `graph:` no longer fail "must have steps".** `templates.ts` now accepts either form; `engine.ts` and `api.ts` use `?? 0` fallbacks when reading `workflow.steps?.length`.

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
