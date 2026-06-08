# Cleanup & Improvement Branch — Implementation Plan

A single branch broken into logical, atomic commits. Sequenced so isolated/high-value
fixes land first and risky structural work last. Scoping decisions (2026-06-05):
**persistence deferred**, **full workflow rename w/ migration**, **full library overhaul**.

Cross-cutting note: clickable-queue, queue context, and event→run linking all stem from one
gap — event/repo/PR metadata already exists on jobs but is stripped at the API layer, and the
queue/event log are in-memory only. We stop discarding data we already have; full persistence is
a separate future effort.

---

## 1. fix(integrations): gh CLI false "not set up"  ⭐ priority, isolated

**Root cause (confirmed):** detection works (`gh auth status` → exit 0, regex matches). The
bug: `start.ts:81-86` injects `config.integrations['gh-cli'] = {}` in-memory only (never written
to disk; it's commented out in YAML). Every workflow create/update/delete calls `reloadConfig()`,
which does `this.config.integrations = reloaded.integrations` (`engine.ts:384`), wiping the
in-memory gh-cli entry → `getIntegrationStatus()` reports `enabled: false`.

- [ ] Track runtime-injected/auto-detected integration entries in the engine.
- [ ] Re-merge them after every `reloadConfig()` so a reload can't drop gh-cli.
- [ ] Add a regression test (reload preserves auto-detected gh-cli status).

## 2. refactor(dashboard): AI Providers own page + remove Cron integration card

- [ ] New top-level `ai-providers` page: nav `<li>` in index.html, `case` in `renderPage()`
      switch, extract `renderAiProviders()` (move provider section app.js:3962-4090).
- [ ] Remove the Cron integration card (zero config; schedules are per-workflow triggers via
      `engine.ts:728-749`). Keep the internal `CronIntegration` scheduler class.
- [ ] (Optional) Surface active cron schedules read-only somewhere sensible.

## 3. feat(queue): run context + clickable detail (no persistence)

- [ ] Include repo/owner/PR/branch in `serializeJob()` (api.ts:2497-2522) — extract branch via
      the same `payload.pull_request.head.ref` path the ai-review action uses (`_event-info.ts`).
- [ ] Show that context in queue rows (`renderQueue`, app.js:5089).
- [ ] Add `GET /api/queue/jobs/:id` (none today).
- [ ] Clickable rows → detail (modal mirroring `openAiReviewDetail`): job + workflow + event +
      related AI reviews (correlate via existing `/api/auto-fix/pr/.../timeline` for PR jobs).

## 4. feat(events): linkify + detail page

- [ ] Make matched-workflow names clickable → workflow (`renderEventCard`, app.js:4828).
- [ ] Linkify repo / PR / issue from metadata to GitHub.
- [ ] Add an `event-detail` route (same pattern as queue detail) with full event + linked
      entities (repo, owner, PR, issue, workflows, runs).
- [ ] Event→run linking uses heuristic/PR correlation + persisted run-store (persistence deferred).
- [ ] (Nice-to-have) Rename the confusing "Webhook Deliveries" tab (it's outbound).

## 5. feat(library): full overhaul

- [ ] Replace Install/Installed/Uninstall with **"Use Template"** — always creates a new instance
      (auto-suffix name if taken). Drop the single-instance gate and the dead "Edit" button.
      Remove `deck`/installed state from card logic (getInstalledWorkflowName app.js:3431).
- [ ] Show "N instances created from this template" instead of an installed badge.
- [ ] Structured **Preview** (replace raw-YAML dump app.js:3835): trigger, plain-language step
      list, required integrations, expected output/destination.
- [ ] Move category + metadata into YAML frontmatter; auto-discover `templates/library/*.yaml`
      (derive `libraryItems` from files instead of the hardcoded app.js array).
- [ ] Refine taxonomy: fix miscategorized items, add a "PR Review" grouping for the variants
      (ai / agentic / ensemble / -manual / -org / gh-cli-quick / pr-inspector), tag-based filter.

## 6. feat(workflows): view modes

- [ ] View-mode toggle (list / tiled / compact) persisted in `localStorage` (establish a small
      UI-prefs helper; app.js only stores the token today).
- [ ] Branch `renderWorkflows` (app.js:1237) per mode. No backend changes.

## 7. feat(workflows): rename with migration  ⚠️ deepest item, land last

Name is the primary key (config, API URLs `/api/workflows/:name`, run history `workflowName`,
queue matching, deck/`_libraryItem`). PUT technically allows rename (api.ts:375) but orphans data.

- [ ] Rename operation/endpoint that cascades: update config entry, migrate run-history records,
      update deck/`_libraryItem` refs, guard against in-flight queue jobs.
- [ ] Un-disable the name field in edit (app.js:1450, 3157) or add a dedicated Rename action.
- [ ] Tests for the migration (history follows the new name; no orphans).

---

## Deferred (future PRs)

- Queue + event-log **persistence** across restart (new disk store like run-store; stable
  event→job→run correlation ID). Decided to defer this round.
