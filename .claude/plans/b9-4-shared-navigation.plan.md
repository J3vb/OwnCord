# Plan: B9-4 — Add the agreed shared navigation integration points

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

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
