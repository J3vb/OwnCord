# Plan: B9-4 — Add the agreed shared navigation integration points

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-4-impl` from `dev` `500f99a4`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

Implemented at `71737d93ab1f917d05081894b1ddc2f64ffdfbe4`.

> **Milestone:** B9-4 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-4-shared-navigation`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 7, 8. **Requirements:** BPR-090, BPR-091; BPR-060, BPR-071, BPR-073.
> **Dependencies:** B9-3. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Add the agreed shared navigation integration points. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Navigate into each available destination and back, then switch profile or lose permission while a destination is open.

## What this milestone is not

No browser/PWA/phone/tablet product, touch-device qualification, new provider,
second shipping language, central moderation service or wholesale rebrand.
No permission-policy relaxation, unrelated feature, dependency major, CI redesign
or generated-file hand edit. The file table is the proposed implementation
boundary; work outside it needs an updated plan. This planning PR changes no
product code, tests or CI.

## Current-state inventory and verify before implementation

Every reference below was read at `0beee8e4c50ca18823750e381d3a1d6e327029b8`. These are source-inspection
facts, not claims that tests or platform acceptance passed. Proposed paths later
in this file are explicitly new work, not present behavior. Re-read this table
at the actual implementation base; record drift before coding.

| #   | Verified current state                                                                                     | Evidence at planning commit                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | SidebarArea composes channels/DMs, server switching, voice and user controls.                              | `Client/src/pages/main-page/SidebarArea.ts:1-52`; `Client/src/pages/main-page/SidebarArea.ts:61-83`                      |
| 2   | Global UI state currently distinguishes channels and DMs and carries connection/session-replacement state. | `Client/src/stores/ui.store.ts:8-28`; `Client/src/stores/ui.store.ts:43-52`                                              |
| 3   | MainPage creates the shared sidebar and owns channel mounting and teardown.                                | `Client/src/pages/MainPage.ts:482-490`; `Client/src/pages/MainPage.ts:947-990`; `Client/src/pages/MainPage.ts:1043-1045` |

### Drift at the implementation base (2026-09-23)

Re-read at `500f99a413070c9ae7613c49137a688e581116ea` (B9-3 merged). `git log
0beee8e4..500f99a4` over the three rows' files is empty: every cited line range
still holds. The entry preconditions hold as the PRD records them — B9-3 merged,
Q9's gate conditions met and Q2 decided on 2026-09-23. `dev` later gained
`281c3b2b` and `6fd8cc0c`, which touch none of these files; they were merged in.

### Implementation decisions and file-table amendments

- **One state owner.** `uiStore.activeView` holds the open content view; the
  content navigator (`features/navigation/contentView.ts`) is its only writer
  and owns the view's `Disposable`, DOM and focus. The state dies with the page:
  `MainPage.destroy()` and `onAuthCleared` both tear the view down, so a profile
  switch or logout never carries a view, or its private content, to the next
  session.
- **No active channel while a view is open.** Opening clears `activeChannelId`
  after remembering it as `channelBeforeDm`. Otherwise the hidden channel would
  count as on screen: `wsHandlers.ts` and `notifications.ts` suppress unread
  and notifications for the active channel. MainPage's existing
  active-channel subscriber tears the chat surface down. Choosing any channel
  or DM (the one the user came from included) replaces the view.
- **Back is the sidebar's path.** `SidebarArea.returnToChannel()` is the DM back
  arrow's body, extracted unchanged. Close and Escape call it. Focus returns to
  the entry that opened the view, or, when that entry left with DM mode, to the
  returned channel's composer.
- **Nothing shows before its feature.** `NAVIGATION_DESTINATIONS` is empty in
  this build. The Requests section, the DM header badge, the Moderation button
  and the Safety tab each render only when their destination has an entry.
  Production has no test hook for registering a view, so
  `b9-navigation.spec.ts` proves the absence and the unchanged routes in the
  real app (it also runs against the production bundle). The transitions
  through a destination run against inert views in `navigation.test.ts`.
- **Files beyond the table**, each a Q2 surface the table's groups did not name:
  `Client/src/lib/permissions.ts` (`canModerateMembers`, beside
  `canViewAuditLog`); `Client/src/pages/main-page/SidebarDmSection.ts` (the DM
  header's pending-request badge, apart from unread);
  `Client/src/components/SettingsOverlay.ts` (the Safety tab seam and
  `openSettings("Safety")` landing); `Client/src/i18n/navigation.ts` (new) and
  one `tabs.safety` key in `Client/src/i18n/settings.ts`;
  `Client/src/styles/app/chat-area.css` and `member-list.css` (the view column
  and badge rules, in their owning fragments); and the unit tests whose
  `UiState` fixtures gained the two new fields.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Navigation visibility is only an affordance. B5 authenticates and authorizes reads/actions; never prefetch moderator data to decide whether to show a menu.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                     | Purpose                                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/pages/MainPage.ts; Client/src/pages/main-page/SidebarArea.ts; Client/src/stores/ui.store.ts` | Serialized shared navigation composition           |
| `Client/src/features/navigation/** (new)`                                                                | Owned view integration and tests                   |
| `Client/tests/e2e/b9-navigation.spec.ts (new)`                                                           | Keyboard, role-loss and teardown routes            |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                   | Dated implementation status and exact-SHA evidence |

Shared edits to navigation, `api.ts`, `types.ts`, `dispatcher.ts`, global stores,
tokens and style import composition take the PRD's single-writer lane. Parallel
work may prepare local modules; shared edits merge sequentially after rebase.

## Tasks

### Task 0: Verify the real base and acceptance preconditions

Create the named branch from `dev`; record its full SHA. Recheck the inventory,
dependency evidence and applicable owner answers. Capture the current affected
checks before changes. An unmet gate means **blocked**, not a speculative
implementation against a made-up endpoint. Retain the reviewed code proof above
and add a failing contract/measurement for the change; no threshold weakening.

### Task 1: Record the approved destination map

Implement Q2 as decided 2026-09-23: Message Requests, Moderation Center and personal safety/status destinations, return path and badge meaning. Preserve familiar channel/DM/voice navigation.

### Task 2: Expose narrow mounting callbacks

Add a typed feature-view integration point and cleanup/focus contract. Feature PRs plug their view into it. Do not display empty or nonfunctional destinations before their feature is available.

### Task 3: Keep one state owner

Ensure navigation has one writer, destroys the old view, scopes selection to server/account and returns focus to a reachable opener. Permission loss removes an unavailable destination and clears its private view.

### Task 4: Test transitions before feature work

Use inert test views to prove channels → feature → DM → settings → logout and profile switch, with pending work disposed and no stale content. Record the shared-file reservation procedure.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/unit/main-page.test.ts; Client/tests/e2e/main-layout.spec.ts; Client/tests/e2e/profile-switch.spec.ts
- Proposed: Client/src/features/navigation/navigation.test.ts; b9-navigation.spec.ts

- [ ] Named behavior tests cover success, refusal, pending/error, reconnect and
      teardown where applicable, with an observed failing control before the fix.
- [ ] Evidence names the implementation SHA, platform/tool versions, fixture,
      command, expected result, actual result and recording/report location.
- [ ] No new warning, import cycle, native-import violation, unexplained test
      log, weakened assertion or reduced coverage/performance threshold.

### Accessibility blocks this milestone

Apply these checks to this milestone's user journey above, including loading,
empty, error, denied and completed states. A source-only/evidence milestone
records the applicable evidence and any missing checks; documentation alone
does not prove unchanged UI behavior. The CSS-only move supplies before/after
evidence. No milestone defers its accessibility acceptance to B9-26.

- [ ] **Keyboard:** Tab/Shift+Tab, Enter/Space, Escape and applicable arrow keys
      reach and operate every action; pointer parity; no hover-only action.
- [ ] **Screen reader:** NVDA (Windows) and Orca (Linux) read names, roles, values, errors
      and relevant status once; no concealed/private/secret content in its tree.
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure text, controls, status and focus at the Q1 thresholds in
      built-in/high-contrast themes, preset accents and the Q8 custom-accent fallback
      (accent text/focus below 3:1 uses the theme default accent);
      information never depends on color alone.
- [ ] **Reduced motion:** test both OS and app settings; no required animation,
      unwanted autoplay or motion-dependent feedback; preserve media controls.
- [ ] **Zoom/reflow:** test Q1 text scale 12–20 px with Large Font, OS zoom 200 %,
      long English/expanded strings and the 940×500 minimum desktop window;
      no clipped or unreachable controls, lost content or focus off screen.

Frontend automation plus manual native evidence is required: mocked Playwright
alone cannot qualify OS accessibility or native network behavior. Browser/mobile
device qualification is deferred with B8; desktop zoom/reflow is not deferred.

## Validation

For a product PR run `npm run check:client` and the named focused/fullstack/native
checks selected by the changed paths; preserve existing bundle budgets and
lifecycle gates. Rust/server changes are not assumed: if an approved prerequisite
changes them, it must run its complete component gate separately. Never run a
local Tauri packaging build (CI-only per Client/CLAUDE.md). Documentation-only
B9-0/B9-27 use `npm run check:docs`, `npm run check:hygiene` and evidence review.
All PRs retain exact-integration-SHA CI evidence before phase closure.

## Risks and rollback

Multiple feature branches editing MainPage or ui.store can create competing state. Serialize every composition edit.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q2 — Navigation and badge placement

**Decided 2026-09-23 by the owner:** keep the existing shell; no new rail. Message Requests: a "Message Requests (N)" section at the top of DM mode, N = pending requests from `GET /api/v1/dm-requests`, kept live by the `dm_request` frame. Badge meaning: the DM header badge shows pending-request count separately from unread; request messages never add to unread or mention counts, never flash the taskbar and never raise a desktop notification before acceptance. Moderation Center: a "Moderation" button in the server header beside "Audit Log", shown only with `MODERATE_MEMBERS`, opening a content-area view (not the browser); no badge in beta, the open-report count is shown inside the view. Personal notices, restrictions, own reports and appeals: a "Safety" tab in Settings, linked from the Q4 notice banner. Back: the Moderation Center and Requests views reuse the existing `channelBeforeDm` return path (close or Escape returns to the channel the user came from).

**Options and consequences:** Place Requests beside DMs, Moderation Center behind a permission-gated server entry and personal notices/appeals in a safety view; or use a new top-level navigation rail. The first changes familiar workflows less; the rail is more visible but has a larger navigation and reflow cost. Badge semantics (pending requests versus unread) also need an explicit choice.

**Drafting recommendation (historical):** Use the existing shell and a pending-request count; approve destinations, back behavior and badge meaning together before B9-4.

## Implementation record (2026-09-23)

### How a feature plugs in

A feature milestone adds one entry to `NAVIGATION_DESTINATIONS` in
`Client/src/features/navigation/destinations.ts` and nothing else in the shell:

- `requests: { build, pending }` (B9-5). `pending` is the live count behind
  "Message Requests (N)" and the DM header badge.
- `moderation: { build }` (B9-11). It is shown and openable only with
  `MODERATE_MEMBERS`, and closed at once on losing it.
- `safety: { build(signal) }` (B9-10/15/16). A Q4 notice opens it with
  `openSettings("Safety")`.

`build` receives `{ signal, close }`. The signal aborts on close, replacement,
permission loss, sign-out and page teardown, so bind every listener, request and
timer to it and drop late results. The view renders inside a named region under
a heading and a Close button that the navigator supplies. A control that
handles Escape itself calls `preventDefault()` first.

### Shared-file reservation procedure

Registering a destination is a one-line edit to `destinations.ts` plus the
feature's own directory and catalog, and takes no reservation. An edit to
`MainPage.ts`, `SidebarArea.ts`, `SidebarDmSection.ts`, `SettingsOverlay.ts`,
`ui.store.ts`, `features/navigation/contentView.ts`, `dispatcher.ts`, `api.ts`
or `types.ts` takes the PRD's single-writer lane: name it in the PR
description, keep one such PR open at a time, merge `dev` in (not rebase)
before review, and land in order.

### Evidence

Implementation `71737d93ab1f917d05081894b1ddc2f64ffdfbe4` on base
`500f99a4`; Node 26.9.0, vitest 4.1.11, Playwright Chromium, Linux.

| Check                                                                                                                                                                                                       | Result                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Affected unit files before the change (`main-page`, `sidebar-area`, `settings-overlay`, `sidebar-dm-section`, `ui.store`, `ui-strings`)                                                                     | 284 passed                                                                  |
| `npx vitest run --maxWorkers=4` (whole client)                                                                                                                                                              | 290 files, 6,375 passed, 149 expected-fail                                  |
| `src/features/navigation/navigation.test.ts`                                                                                                                                                                | 25 passed                                                                   |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint)                                                                                                            | clean                                                                       |
| `npm run build:budget && npm run check:budgets`                                                                                                                                                             | all ok; MainPage 58,491 B of 60,000 B, startup closure 87,294 B of 91,000 B |
| Playwright (dev server): `b9-navigation`, `main-layout`, `profile-switch`                                                                                                                                   | 8 passed                                                                    |
| Playwright (dev server): `a11y-smoke`, `sidebar-header`, `settings-overlay`, `settings-tabs-extra`, `dm-system`, `b9-primitives`, `b9-text-expansion`, `logout-flow`, `channel-sidebar`, `admin-moderation` | 92 passed                                                                   |
| `npm run check:docs`, Prettier on changed files                                                                                                                                                             | passed                                                                      |

**Failing controls.** Each guard below was removed in turn and the named suite
re-run. Every one failed, and each was restored before commit: clearing the
active channel on open; the permission-loss recheck; the sign-out teardown; the
Escape handled-by-view guard; a channel choice closing the view; opener focus
restore (`navigation.test.ts`); the sidebar's `MODERATE_MEMBERS` gate; the DM
redraw keeping the Requests entry's element; the badge hiding at zero
(`sidebar-area.test.ts`); the Settings tab request (`settings-overlay.test.ts`);
and page teardown destroying the view (`main-page.test.ts`).

### Accessibility (Q1)

- **Keyboard:** every entry is a `<button>`, and the Safety tab joins the
  arrow-key tablist (unit). The view closes on its Close button or Escape. In
  e2e, the settings route opens with Enter and closes with Escape. Gap:
  `DmSidebar`'s back header is a click-only `div`. It predates this milestone
  and is recorded for the B9-21 shell pass; the content views' own back
  (Close/Escape) does not depend on it.
- **Screen reader:** the view is a `region` named by its `h2`. Its Close button
  is named "Close <view>". Entries carry `aria-current="page"` while their view
  is open. The DM header badge reads "N pending message requests" from
  `.sr-only` text, with the digit hidden. **NVDA and Orca recordings are
  owner-run and pending.**
- **Focus:** the heading receives focus on open. On close, focus returns to the
  opener, or to the returned channel's composer once the opener is gone or
  hidden. Permission loss and switching views follow the same rules (unit).
- **Contrast, reduced motion, zoom/reflow:** the new badge and view header use
  B9-2 tokens (`--text-normal` on `--bg-tertiary`, `--border-strong`, the
  chat-header rules), and nothing new animates. None of these surfaces renders
  until a destination ships, so the 940×500 / 20 px and contrast measurements
  of each rendered entry and view belong to the milestone that registers it
  (B9-5, B9-11, B9-10/15/16).
