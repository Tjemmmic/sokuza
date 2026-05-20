# Node Graph Support Matrix

This document is a snapshot of every capability the Sokuza node-graph workflow
system currently exposes, plus a checklist of capabilities we know are missing.
Use it to drive what we build next. Anything unchecked is fair game for a PR.

Sources verified against [src/core/nodes/builtins.ts](src/core/nodes/builtins.ts),
[src/core/nodes/runtime.ts](src/core/nodes/runtime.ts),
[src/core/workflow.ts](src/core/workflow.ts),
[src/integrations/](src/integrations/),
[src/actions/](src/actions/),
[dashboard/](dashboard/), and
[templates/](templates/).

---

## 1. Trigger Nodes — supported today

| Type | Source | Events exposed (config) | Filter ports exposed (config) | Output ports (always) | Dynamic outputs |
|---|---|---|---|---|---|
| `trigger.github` | GitHub webhooks | `events` (multiselect, required) | `repos`, `branches`, `authors`, `labels` | `event`, `payload` | Event-conditional: PR/issue/comment/review/push fields |
| `trigger.github-poll` | GitHub REST polling | `events` (multiselect, required) | `repos` only | `event`, `payload` | Same event-conditional rules as `trigger.github` |
| `trigger.gh-cli` | Local `gh` CLI polling | `events` (multiselect, required) | `repos` only | `event`, `payload` | Same event-conditional rules as `trigger.github` |
| `trigger.slack` | Slack Events API | `events` (multiselect, required) | `channels` | `event`, `payload`, `channel`, `user`, `text` | None |
| `trigger.webhook` | Inbound HTTP | `path` (text, required) | None | `event`, `payload` | None |
| `trigger.cron` | Schedule timer | `schedule` (text, cron expr) | None | `event`, `payload` | None |
| `trigger.manual` | Dashboard "Run" form | `inputs` (kv list of form fields) | None | `event`, `payload`, plus one port per input | Per-input: each form field becomes a typed output port |

### GitHub event names accepted by `trigger.github`

| Event | Source(s) that emit it |
|---|---|
| `pull_request.opened` | github, github-poll, gh-cli |
| `pull_request.synchronize` | github, github-poll, gh-cli |
| `pull_request.closed` | github, github-poll, gh-cli |
| `pull_request.review_requested` | github only |
| `pull_request_review.submitted` | github, github-poll, gh-cli |
| `issues.opened` | github, github-poll, gh-cli |
| `issues.closed` | github, github-poll, gh-cli |
| `issues.labeled` | github only |
| `issues.assigned` | github only |
| `issue_comment.created` | github, github-poll, gh-cli |
| `push` | github, github-poll |

---

## 2. AI Nodes — supported today

| Type | Action | What it does | Key inputs | Key outputs |
|---|---|---|---|---|
| `ai.review` | `ai-review` | One-shot completion against a diff string; returns structured review JSON + rendered markdown | `diff`, `pr_number`, `repo`, `prompt`, `provider`, `model`, `max_diff_chars`, `max_tokens`, `parse_repair_retries` | `markdown`, `structured`, `summary`, `issues`, `mergeReady`, `runId` |
| `ai.agent` | `ai-agent` | Tool-using agent loop inside a workdir (Claude Code / opencode / similar CLI provider) | `prompt`, `workdir`, `context`, `output_format`, `allowed_tools`, `provider`, `model`, `max_tokens` | `output`, `transcript` |
| `ai.address-review` | `address-review` | Consume a prior `ai.review` and either post inline suggestions or commit fixes; supports iteration cap, cooldown, merge-ready heuristic | `mode` (suggest/push), `review_run_id`, `structured`, `pr_number`, `repo`, `max_iterations`, `cooldown_seconds`, `provider`, `model` | `iterationsRun`, `finalState` |

Per-node `provider` and `model` overrides are supported on all three.
Workflow-level `ai:` block sets defaults for all AI nodes in that workflow.

---

## 3. GitHub Action Nodes — supported today

| Type | Action | One-line |
|---|---|---|
| `github.fetch-diff` | `github-fetch-diff` | Pull a unified diff for a PR, with smart truncation |
| `github.fetch-pr` | `github-fetch-pr` | Fetch full PR object by number |
| `github.fetch-issue` | `github-fetch-issue` | Fetch full Issue object by number |
| `github.fetch-reviews` | `github-fetch-reviews` | List existing reviews on a PR |
| `github.clone-repo` | `github-clone-repo` | Shallow-clone a repo (or branch) into a temp workdir |
| `github.comment` | `github-comment` | Post a comment on a PR or issue |
| `github.create-review` | `github-create-review` | Post a real GitHub Review (COMMENT/APPROVE/REQUEST_CHANGES) |
| `github.create-pr` | `github-create-pr` | Push a branch and open a PR |
| `github.merge-pr` | `github-merge-pr` | Merge a PR (merge/squash/rebase), optional SHA guard |
| `github.update-pr` | `github-update-pr` | PATCH a PR — title/body/base/state |
| `github.wait-for-checks` | `github-wait-for-checks` | Poll commit checks until done or timeout |
| `github.add-label` | `github-add-label` | Add a label to a PR or issue |
| `github.remove-label` | `github-remove-label` | Remove a label from a PR or issue |

---

## 4. Other Action Nodes — supported today

| Group | Type | One-line |
|---|---|---|
| Git | `git.commit-and-push` | Stage / commit / push in a workdir (provider-agnostic) |
| Notify | `slack.send-message` | Post a message to a Slack channel |
| Notify | `slack.react` | Add an emoji reaction to a Slack message |
| Utility | `utility.log` | Write a message to the application log |
| Utility | `utility.webhook` | POST/PUT/PATCH/DELETE/GET to an arbitrary URL |

---

## 5. Flow & Data Nodes — supported today

| Group | Type | One-line |
|---|---|---|
| Flow | `flow.if` | Binary branch on a templated condition; emits `then`/`else` plus `thenFired`/`elseFired` sentinels |
| Flow | `flow.set` | Define a named value reusable via `{{nodes.<id>.value}}` |
| Flow | `flow.merge` | Wait on multiple inputs and forward the first defined one (a → b → c priority) |
| Flow | `flow.filter-list` | Filter a JSON array by per-item field test (equals / not-equals / truthy / exists / contains) |
| Data | `data.json-pluck` | Read a dot-path out of any value |
| Data | `data.template` | Compose a string with `{{nodes.x.y}}` placeholders |
| Data | `data.pr-fields` | Decompose a PR object into scalar fields (number, headSha, branch, author, …) |
| Data | `data.issue-fields` | Decompose an Issue object into scalar fields |
| Data | `data.review-fields` | Decompose a structured review (summary/issues/mergeReady/counts) |
| Data | `data.commits-fields` | Decompose a push event's commits (latest SHA / message / authors) |
| Data | `data.event-fields` | Split the canonical event envelope (source/eventName/payload/metadata) |

---

## 6. Engine / Runtime — supported today

| Capability | Status | Where |
|---|---|---|
| Topological scheduling with parallel layers | ✅ | `runtime.ts` (Promise.allSettled per layer) |
| Implicit edges from `{{nodes.X.Y}}` references in config | ✅ | `runtime.ts` ref-extraction |
| Explicit sequencing port (`__seq`) | ✅ | Used by templates to force ordering |
| Per-node `condition:` skip | ✅ | `runtime.ts` |
| Per-node `on_error: stop \| continue` | ✅ | continue mode surfaces `__error`/`__errorStack`/`__errorName` ports |
| Per-node `timeout:` (seconds) | ✅ | Races against `AbortSignal` |
| Workflow-level `AbortSignal` propagation | ✅ | All nodes fail fast on abort |
| Self-loop edge detection | ✅ | Throws at load time |
| Prototype-pollution guard in template paths | ✅ | `__proto__`/`constructor` blocked |
| Glob filters in `trigger.filters` values | ✅ | `*` → regex `.*`, dotall |
| OR-across-paths in `trigger.filters` keys | ✅ | `a\|b` syntax |
| Array-contains in `trigger.filters` keys | ✅ | `payload.labels[].name` syntax |
| Multi-value shorthand filters (repo / branch / author) | ✅ | Engine matches any-of |
| Per-node provider/model overrides | ✅ | `ai.review`, `ai.agent`, `ai.address-review` |
| Queue settings: concurrency, dedup, priority, timeout, retry | ✅ | Workflow-level + global tiers |
| Dedup template keys | ✅ | `dedup_key: "{{event.metadata.repo}}"` etc. |

---

## 7. Integrations — supported today

| Integration | Inbound | Outbound (actions) | Notes |
|---|---|---|---|
| `github` | Webhooks with HMAC verify | All 13 github.* actions | Requires `webhookSecret` + `token` |
| `github-poll` | REST polling | Reuses github actions | Requires `token`; configurable interval |
| `gh-cli` | Local `gh` CLI polling | Subset of github actions via `gh` | Uses your local gh auth — zero token config |
| `slack` | Events API + slash commands | `slack-send-message`, `slack-react` | Requires `botToken` + `signingSecret` |
| `webhook` | Generic inbound HTTP with optional HMAC | None (use `utility.webhook` for outbound) | Path-based dispatch |
| `cron` | Internal timer | None | Built-in event names + custom cron expressions |

---

## 8. Dashboard / Editor — supported today

| Feature | Status |
|---|---|
| Node palette grouped by category | ✅ |
| Drag-and-drop nodes onto canvas | ✅ |
| Click-output → click-input edge wiring | ✅ |
| Click-to-select node/edge; Delete/Backspace to remove | ✅ |
| Esc to cancel wiring / clear selection | ✅ |
| Ctrl/Cmd-S to save | ✅ |
| Mouse-wheel + Ctrl to zoom; explicit 100% / Fit buttons | ✅ |
| Per-node inspector with type-aware controls (text, textarea, number, select, multiselect, switch, code-md, code-yaml, kv, github-pr, github-issue, github-repo, ai-provider, ai-model) | ✅ |
| "Load default" button for ports with `defaultSource` | ✅ |
| YAML side-panel reflecting the graph | ✅ |
| Pages: Dashboard, My PRs, Issues, Workflows, Chat, Library, Integrations, Event Log, Auto-Fix, AI Reviews, Queue, Logs, System, Settings | ✅ |
| Live run viewer via SSE | ✅ |
| Template Library page (filter by group) | ✅ |
| "Run" button for manual triggers | ✅ |

---

## 9. Workflow-level Features — supported today

| Feature | Status | Notes |
|---|---|---|
| `trigger.source` multi-value | ✅ | Workflow can listen on multiple sources |
| `trigger.event` multi-value | ✅ | OR across event names |
| `trigger.repo` (exact match, multi) | ✅ | No globs in shorthand |
| `trigger.branch` (exact match, multi) | ✅ | Targets `payload.pull_request.base.ref` |
| `trigger.author` (case-insensitive, multi) | ✅ | Engine reads `payload.pull_request.user.login` |
| `trigger.labels` (any-of) | ✅ | Engine reads `payload.pull_request.labels[].name` |
| `trigger.filters` (raw dot-path, glob, OR, array-contains) | ✅ | Power-user escape hatch |
| `enabled: false` toggle | ✅ | |
| Workflow `ai:` defaults | ✅ | provider/model |
| Workflow `queue:` overrides | ✅ | Inline takes priority |
| Workflow `inputs:` form (manual trigger) | ✅ | Renders fields in dashboard |
| Templated workflows via `templates/library/` | ✅ | 41 examples |
| Legacy `steps:` + new `graph:` coexist | ✅ | Graph wins when both present |

---

## 10. Templates shipped today

### Top-level (8)

| File | Purpose |
|---|---|
| `ai-pr-review.yaml` | AI review every new PR, post as comment |
| `auto-fix-pr-review.yaml` | AI review + auto-fix loop (legacy `steps:`) |
| `auto-fix-address-review.yaml` | The second half of the auto-fix loop |
| `enforce-rules.yaml` | Check PR against `.github/RULES.md` |
| `fix-github-issue.yaml` | Manual: agent investigates + fixes + opens PR |
| `log-events.yaml` | Debug: dump every matched event to the log |
| `respond-to-reviews.yaml` | Agent reads review feedback, pushes fixes |
| `review-notify-slack.yaml` | AI review + Slack ping |
| `sokuza-slash-commands.yaml` | `/sokuza fix`, `/sokuza skip`, `/sokuza unskip` PR-comment commands |

### Library (41)

`address-review-on-changes`, `api-docs-sync`, `auto-label-pr`, `bug-report-validator`,
`changelog-entry`, `ci-failure-slack`, `cron-stale-pr-bump`, `daily-digest-slack`,
`deep-audit`, `dependency-review`, `deploy-notify-slack`, `event-debug-tap`,
`experiment-runner`, `failure-tracer`, `flow-filter-demo`, `flow-merge-demo`,
`generate-docs`, `gh-cli-quick-review`, `github-poll-watch`, `goal-pursuit`,
`issue-autofix-pr`, `issue-notify-slack`, `issue-triage`, `license-check`,
`pr-inspector`, `pr-merge-on-green`, `pr-rename-title`, `pr-size-labeler`,
`pr-summary`, `progress-pulse`, `push-changelog-pr`, `quality-loop`,
`release-notes`, `repo-scout`, `secret-scan`, `security-audit`, `ship-check`,
`slack-mention-react`, `stale-issue-cleanup`, `static-scan`, `update-readme`,
`webhook-forwarder`.

---

# What we DO NOT support yet — the checklist

Grouped by area. Check items off as we ship them. Where a workaround exists,
it's noted in parens. Completed items are marked `[x]` with the PR number
that shipped them.

**Shipped so far:** PR #4 (trigger filter parity + glob + exclude), PR #5
(`ai.agent` loop compat via `parse_as_review`), PR #6 (`utility.shell-exec`).

## A. Trigger nodes — filter parity & scoping

- [x] `trigger.gh-cli` exposes `branches` config port — **PR #4**
- [x] `trigger.gh-cli` exposes `authors` config port — **PR #4**
- [x] `trigger.gh-cli` exposes `labels` config port — **PR #4**
- [x] `trigger.github-poll` exposes `branches` config port — **PR #4**
- [x] `trigger.github-poll` exposes `authors` config port — **PR #4**
- [x] `trigger.github-poll` exposes `labels` config port — **PR #4**
- [x] **Negation filters** — `trigger.exclude: { repo, branch, author, labels }` (incl. glob and case-insensitive author) — **PR #4**
- [ ] **Draft-PR filter** as a first-class port *(workaround: `filters: { "payload.pull_request.draft": "false" }`)*
- [ ] **Comment-author filter** on `issue_comment.created`. Today `trigger.author` only matches PR/issue authors, not commenters.
- [ ] **Bot-author exclusion** as a built-in (e.g. `skip_bots: true`)
- [ ] **Org-wide repo scoping** — "watch all repos in `my-org`":
  - [x] Engine: glob in `trigger.repo` shorthand — **PR #4** (`repo: my-org/*` now matches via `globMatch`)
  - [ ] Pollers: auto-enumerate repos via `/orgs/{org}/repos` or `gh repo list <org>` — still missing
- [ ] **"All repos I have access to"** mode for `gh-cli`
- [ ] **PR base-branch filter** distinct from `trigger.branch` semantics (currently overloaded — `trigger.branch` already matches base ref; head-branch filter is missing)
- [ ] **Path filter** — only fire when files matching `src/**/*.ts` changed
- [ ] **File-count / diff-size filter** — only fire when PR < N lines / N files
- [ ] **Team-membership filter** — only fire when author belongs to `@org/team`

## B. Missing trigger sources

- [ ] **GitLab** integration (webhooks + actions)
- [ ] **Bitbucket** integration
- [ ] **Gitea / Forgejo** integration
- [ ] **Linear** trigger + actions (issue events)
- [ ] **Jira** trigger + actions
- [ ] **Discord** trigger + actions
- [ ] **Email** trigger (IMAP poll or inbound SMTP)
- [ ] **PagerDuty / Opsgenie** trigger
- [ ] **Sentry** trigger (new issue / regression)
- [ ] **Stripe / billing** webhooks
- [ ] **Generic git push hook** (local pre-commit / pre-push that calls into Sokuza)
- [ ] **File-watcher trigger** (run when local file changes)
- [ ] **Manual chained trigger** — fire a workflow from another workflow's success
- [ ] **GitHub Actions / CI** as a trigger (e.g. workflow_run.completed)

## C. Missing GitHub actions

- [ ] **Request reviewers** (`POST /pulls/{n}/requested_reviewers`)
- [ ] **Remove requested reviewers**
- [ ] **Assign / unassign issue or PR**
- [ ] **Close / reopen issue** (today only PRs via `update-pr`)
- [ ] **Create branch** (remote ref creation without local clone)
- [ ] **Delete branch** (remote)
- [ ] **Create release** + upload assets
- [ ] **Create / move / delete tag**
- [ ] **Fetch file contents** by path/ref (without cloning)
- [ ] **Put / commit single file** via Contents API
- [ ] **Search code** (`/search/code`)
- [ ] **Search issues / PRs** (`/search/issues`)
- [ ] **Fetch commit** by SHA
- [ ] **Fetch PR file list** (paths + statuses) without the full diff
- [ ] **Inline PR review comments** as a structured input *(today `github.create-review` only takes a single `body`)*
- [ ] **React to issue / PR comments** with `+1`/`heart`/etc. *(Slack has reactions; GitHub does not)*
- [ ] **Fetch user / team** info
- [ ] **Check team membership** (`/orgs/{org}/teams/{slug}/members/{user}`)
- [ ] **Fetch combined check status** alone (today bundled into `wait-for-checks`)
- [ ] **Trigger workflow_dispatch** (kick a GHA workflow from Sokuza)
- [ ] **Compare two refs** (`/compare/{base}...{head}`)

## D. Missing AI / agent capabilities

- [ ] **Direct Anthropic / OpenAI API node** that's not abstracted through provider registry — for users who want a single specific provider explicitly
- [ ] **Structured output / JSON-mode** node (use tool definitions or response_format) — today `ai.agent` has `output_format: json` but no schema enforcement
- [ ] **Vision / multi-modal input** node (pass images, screenshots)
- [ ] **Embeddings** node + **vector search** node for RAG over a codebase
- [ ] **Token-counting** / budget-guard node
- [ ] **Streaming output** surfaced in the live run viewer
- [ ] **Agent-with-MCP** — connect the ai.agent to an MCP server for tool access beyond the CLI's built-in tools
- [x] **`ai.agent` emits `parsed` / `runId`** — opt in via `parse_as_review: true`; records a run under `~/.sokuza/runs/ai-review/` with `strategy: 'agentic'` so `address-review` consumes it. — **PR #5**
- [ ] **Persistent memory / state** across runs (a key-value store node)
- [ ] **Cost / usage tracking** node — expose tokens-in, tokens-out, $ estimate
- [ ] **Prompt template library** browseable from the editor (today `defaultSource` is hardcoded to one source name)

## E. Missing flow-control primitives

- [ ] **`flow.foreach`** — fan-out: run downstream nodes once per array element, then fan-in
- [ ] **`flow.parallel-foreach`** — same but concurrent with a `max_concurrency`
- [ ] **`flow.while`** / **`flow.repeat-until`** — bounded loop with break condition
- [ ] **`flow.switch`** — N-way branch on a value (not just binary `if`)
- [ ] **`flow.delay`** / `flow.sleep` — pause N seconds
- [ ] **`flow.wait-until`** — pause until a templated condition becomes true (polling)
- [ ] **`flow.fail`** — terminate the workflow with a custom error message
- [ ] **`flow.retry`** — wrap a subgraph in a retry policy *(today retry is queue-level, not per-subgraph)*
- [ ] **`flow.try-catch`** — alternative subgraph runs on error *(today only `on_error: continue` swallows the error)*
- [ ] **`flow.human-approval`** — pause the run, await a dashboard click or PR comment, then resume
- [ ] **Sub-workflow invocation** — call another workflow as a node, pass inputs, receive outputs
- [ ] **Counter / accumulator** nodes for fan-in totals
- [ ] **`flow.race`** — first-to-finish wins, others cancelled *(opposite of merge)*

## F. Missing data / utility nodes

- [x] **Shell exec** in a workdir — `utility.shell-exec` node with timeout, abort propagation, output cap, and workdir deny-list; emits `stdout`/`stderr`/`exitCode`/`success`/`timedOut`/`truncated`/`durationMs`. — **PR #6**
- [ ] **File read** from a workdir path
- [ ] **File write** to a workdir path
- [ ] **File-exists / glob** node
- [ ] **JSON.parse from string**
- [ ] **JSON.stringify** node
- [ ] **YAML parse / stringify** node
- [ ] **Regex match / extract / replace**
- [ ] **String split / join / trim / case-convert**
- [ ] **Date format / parse / diff**
- [ ] **Math** node (add/sub/mul/div/compare)
- [ ] **Object merge / pick / omit**
- [ ] **Array map** (apply template per item; today only filter)
- [ ] **Array reduce / count / unique / sort**
- [ ] **HTTP GET with response body output** *(today `utility.webhook` returns status only, no body)*
- [ ] **HTTP with auth (Bearer / Basic / API-key)** as first-class config
- [ ] **HTTP retry policy** per node
- [ ] **HTML / CSS-selector scraping** node
- [ ] **CSV parse / write** node
- [ ] **Hash / sign** node (sha256, hmac)
- [ ] **Random / UUID** node
- [ ] **Env-var lookup** node (with allow-list for safety)
- [ ] **Secret-vault lookup** node (separate from env vars)
- [ ] **Database query** node (SQLite / Postgres / Redis)

## G. Missing integrations / notifiers

- [ ] **Discord webhook send** node
- [ ] **Microsoft Teams** webhook send
- [ ] **Email send** node (SMTP)
- [ ] **SMS** (Twilio) send
- [ ] **PagerDuty / Opsgenie** create-incident node
- [ ] **Datadog / Prometheus / OpenTelemetry** metric-emit node
- [ ] **S3 / GCS / Azure blob** put node (for storing run artifacts)
- [ ] **Sentry** create-issue / breadcrumb node
- [ ] **Telegram** send-message node

## H. Engine / runtime gaps

- [ ] **Per-node retry-with-backoff** (today retry is at queue level, all-or-nothing)
- [ ] **Per-node retry-only-on-specific-errors** (e.g. retry on 429 / 5xx, not on 4xx)
- [ ] **Workflow-level `on_failure:` hook** (e.g. "post to Slack if any workflow fails")
- [ ] **Edge type enforcement at runtime** *(today edges are typed in the editor only; runtime accepts anything)*
- [ ] **Schema-validated dynamic outputs** (so a typo in `nodes.x.foo` is caught at load time, not first run)
- [ ] **Dry-run mode** — simulate the graph with mock data, emit a trace
- [ ] **Replay** a past run with the same inputs
- [ ] **Pause / resume** a running workflow
- [ ] **Streaming intermediate node outputs to the run viewer** as they happen
- [ ] **Workflow-level concurrency lock** per resource (e.g. "only one workflow may touch repo X at a time")
- [ ] **Idempotency keys** — skip if the same key was processed within N seconds (today dedup exists in the queue but isn't surfaced as a node-level guard)
- [ ] **Workflow-level inputs validation** beyond required/optional (regex, enum, ranges)
- [ ] **Output-port docs surfacing** — show the structure of a node's outputs in the editor without running it

## I. Editor / UX gaps

- [ ] **Undo / redo** (Ctrl+Z / Ctrl+Shift+Z) — not implemented
- [ ] **Copy / paste / duplicate** node(s) — not implemented (`'copy'` strings in code are HTML5 DnD effects, not clipboard ops)
- [ ] **Marquee / multi-select** with shift-click and box-select
- [ ] **Group / collapse** subgraphs into a single visual node
- [ ] **Comment / sticky-note** annotations on the canvas
- [ ] **Auto-layout** ("tidy up") beyond the existing Fit
- [ ] **Search / filter palette** by node type/title
- [ ] **Minimap**
- [ ] **Snap-to-grid**
- [ ] **Validation panel** that lists every error / warning across the whole graph
- [ ] **Diff view** between current graph and last-saved YAML
- [ ] **Workflow draft auto-save** to localStorage
- [ ] **Shareable workflow URL** / export-as-link
- [ ] **Per-node test-fixture inputs** — let a node run in isolation with mock data
- [ ] **"Why didn't this fire?" debugger** — feed a sample event and see which trigger filter rejected it
- [ ] **Live tail of structured logs** scoped to a single run
- [ ] **Run history with input/output snapshots** per node (today timestamps + status only)
- [ ] **Bulk template import** from a URL or local folder
- [ ] **Workflow folders / tags** for organization
- [ ] **Read-only "share" mode** — render the graph without edit capability

## J. Auth, ops, deployment

- [ ] **Multi-user auth** / RBAC (Sokuza assumes single-tenant today)
- [ ] **OAuth bootstrap UI** for GitHub / Slack tokens (today user pastes secrets into config)
- [ ] **Secret-rotation** workflow
- [ ] **Audit log** of who edited what workflow when
- [ ] **Workflow versioning / rollback** (today: rely on `git` on the YAML files)
- [ ] **Docker / docker-compose** ship-and-run path
- [ ] **CLI mode** — one-shot `sokuza run <workflow>` without keeping the server up
- [ ] **Helm chart** for k8s deploys
- [ ] **Health endpoint / readiness probe**
- [ ] **Backup / export-all** to a tarball
- [ ] **Metric export** (Prometheus / OTEL) of engine internals
- [ ] **Webhook receive endpoint URL display** in the integrations page for easy copy-paste into GitHub/Slack

## K. Documentation / onboarding

- [ ] **Per-node help text** linking to a docs anchor
- [ ] **Walk-through tutorial** for first-time users
- [ ] **"What can I build?" example gallery** beyond the library list
- [ ] **Migration guide** from legacy `steps:` to graph form

---

## Priority hints

These are the gaps most often hit by realistic auto-PR-reviewer workflows
(based on what's in the current templates):

**P0 — block common user goals:**
- ~~A8 negation/skip filters~~ ✅ PR #4
- ~~A2/A3/A4 author/branch/label ports on `gh-cli` and `github-poll` nodes~~ ✅ PR #4
- A10 org-wide repo scoping — engine half ✅ PR #4; **poller half still missing**
- ~~D8 `ai.agent` emits `parsed` / `runId`~~ ✅ PR #5
- ~~F1 shell-exec node~~ ✅ PR #6
- E1 `flow.foreach` — **next**
- E4 `flow.switch` — **next**

**P1 — frequently asked, currently painful:**
- C1/C3/C4 request reviewers, assign/unassign, close issue
- F16 HTTP-GET with response body
- F4 regex node
- I1/I2 undo-redo + copy-paste
- H1 per-node retry-with-backoff
- G3 email send

**P2 — strategic but not blocking:**
- B1/B2/B3 GitLab/Bitbucket/Gitea
- B4 Linear, B5 Jira
- D4/D5 embeddings + RAG
- E12 sub-workflow invocation
- J5 workflow versioning
