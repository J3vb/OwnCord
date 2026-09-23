# Plan: B9-25 — Make desktop network, notification and update limitations actionable

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-25 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-25-honest-desktop-capabilities`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 9, 8. **Requirements:** BPR-092, BPR-091.
> **Dependencies:** B9-9, B9-15, B9-23, B9-24. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Make desktop network, notification and update limitations actionable. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Use a LAN server without internet, then lose the server; test denied notifications/capture and manual/failed update paths before restoring them.

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

| #   | Verified current state                                                                                                       | Evidence at planning commit                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Connection banners derive from one shared connection-status subscription and perform an initial sync.                        | `Client/src/pages/MainPage.ts:425-449`                                                             |
| 2   | UpdateNotifier already distinguishes manual-upgrade installs and renders download/restart/failure states.                    | `Client/src/components/UpdateNotifier.ts:38-68`; `Client/src/components/UpdateNotifier.ts:125-141` |
| 3   | Notification settings describe desktop notifications and taskbar flash; they are not a browser Web Push capability contract. | `Client/src/components/settings/NotificationsTab.ts:14-39`                                         |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

Existing B6 network modes and B7 update/session/platform contracts. B8 browser API, PWA and closed-app Web Push UX is deferred.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                        | Purpose                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/components/{UpdateNotifier,VoiceWidget}.ts; Client/src/components/settings/NotificationsTab.ts` | State-derived desktop labels                       |
| `Client/src/pages/MainPage.ts; connection UI composition`                                                   | Serialized shared-state consumption only           |
| `Client/tests/e2e/b9-desktop-capabilities.spec.ts (new)`                                                    | Mode and recovery matrix                           |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                      | Dated implementation status and exact-SHA evidence |

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

### Task 1: Build the desktop capability table

Record observed Windows/Linux supported behavior for notifications, capture, updater/package installs, native integrations, network and certificate trust. Include local-server reachability separately from internet-provider reachability.

### Task 2: Connect controls to actual state

Disable or explain unavailable actions using existing adapter results and transport state, not an assumed browser API or just an OS string. Keep one connection-state owner and do not add a new transport state machine.

### Task 3: Provide recovery actions

Distinguish permission denied, internet unavailable, server disconnected, update failed, manual package upgrade and displaced session. Show retry/settings/operator guidance appropriate to the state, preserving pending work where safe.

### Task 4: Prove honesty

Block internet while keeping the LAN server reachable; revoke notification/device permission; cancel capture; reject an update; restore capability and network. Verify no false-success text or retry storm. Browser/PWA/push support screens remain out of scope.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Client/tests/e2e/reconnection.spec.ts; Client/tests/e2e/updater.spec.ts; Client/tests/e2e/incompatible-epoch.spec.ts
- Proposed: b9-desktop-capabilities.spec.ts; native captures per OS

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

Online to the server and online to a provider are different facts. Do not disable LAN messaging because GIF search cannot reach the internet.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
