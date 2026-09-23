# Plan: B9-5 — Show the Message Requests inbox and safe text preview

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-5 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-5-message-requests-inbox`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 1, 8. **Requirements:** BPR-060, BPR-091.
> **Dependencies:** B9-4. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Show the Message Requests inbox and safe text preview. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Open a first-contact request, read sender and plain text, leave and reconnect without accepting or fetching media.

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

| #   | Verified current state                                                                                                           | Evidence at planning commit                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | B5 exposes an authenticated pending inbox with sender profile, optional text preview and no media bytes.                         | `Server/api/dm_request_handler.go:20-28`; `Server/api/dm_request_handler.go:44-99` |
| 2   | The generated event name exists, while dispatcher currently wires DM channel open/close without a request handler in that group. | `Client/src/lib/protocolTypes.ts:46-60`; `Client/src/lib/dispatcher.ts:154-160`    |
| 3   | The current DM sidebar section renders conversation rows and a View all messages button.                                         | `Client/src/pages/main-page/SidebarDmSection.ts:37-74`                             |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

GET /api/v1/dm-requests; recipient-only dm_request. HP-5/B5 decision 4: one-to-one only, safe text preview, trust only after acceptance. Sender gets no rejection/read signal.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Client/src/features/message-requests/{api,store,wsHandlers,Inbox}.ts (new)`           | Typed inbox, snapshot/event reconciliation and text-only view |
| `Client/src/lib/api.ts; Client/src/lib/types.ts; Client/src/lib/dispatcher.ts`         | Minimal API/type/registration edits, serialized               |
| `Client/src/pages/main-page/SidebarDmSection.ts; B9-4 navigation composition`          | Inbox entry with no ordinary-DM acceptance side effect        |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan | Dated implementation status and exact-SHA evidence            |

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

### Task 1: Add the inbox adapter and state

Mirror the REST fields exactly and add a feature-owned account/server-scoped request store. Reconcile GET snapshots and dm_request events through dispatcher-owned handlers; ignore late responses from an abandoned session.

### Task 2: Render text without rich-content side effects

Show sender name and inert message text through a dedicated safe-preview renderer. Do not mount the normal message renderer, automatic avatar loads, attachments, embeds, oEmbed, provider search or broker calls. A profile avatar URL is not permission to fetch it.

### Task 3: Integrate the read-only inbox

Mount through B9-4; handle empty, loading, unavailable and reconnect states. Recover authoritative pending state after reconnect and session handover. Keep unaccepted channels outside the ordinary conversation view.

### Task 4: Prove safe preview

Spy on broker, server file/history, and browser resource loads while opening and scrolling requests. Use link/GIF/attachment-looking text, a null preview and sender erasure; all automatic content fetch counts remain zero.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Proposed: Client/src/features/message-requests/inbox.test.ts; Client/tests/e2e/b9-message-requests.spec.ts
- Existing contract evidence: Server/api/dm_request_handler_test.go; Server/ws/dm_request_test.go

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

Reusing a rich renderer or avatar helper performs work before the inbox action; test fetch absence, not just hidden DOM.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
