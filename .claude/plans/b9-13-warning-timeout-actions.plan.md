# Plan: B9-13 — Issue warnings and timeouts with accurate outcomes

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-13 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-13-warning-timeout-actions`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 5, 8. **Requirements:** BPR-072, BPR-091.
> **Dependencies:** B9-12. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Issue warnings and timeouts with accurate outcomes. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Warn, apply and lift a timeout with and without voice authority; review rejected and partially applied cases.

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

| #   | Verified current state                                                                                             | Evidence at planning commit                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | B5 exposes warn, timeout and untimeout; timeout returns a distinct applied/skipped voice outcome.                  | `Server/api/moderation_handler.go:20-36`; `Server/api/moderation_handler.go:82-96`; `Server/api/moderation_handler.go:151-160` |
| 2   | Timeout duration is bounded from one minute to 28 days. Permission and hierarchy checks stay in ModerationService. | `Server/service/moderation.go:254-258`; `Server/service/moderation.go:336-368`                                                 |
| 3   | Report-linked actions accept kind/reason/duration, and timeout has a special result body.                          | `Server/api/moderation_queue_handler.go:92-108`                                                                                |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

MODERATE_MEMBERS gates warning/timeout, hierarchy applies, voice half uses current effective voice authority and reports applied/skipped. Consume existing routes; do not add a general admin grant.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/moderation/{ActionForms,api,History}.ts (new or extend)`          | Warning/timeout/untimeout actions                  |
| `Client/src/lib/permissions.ts; Client/src/i18n/moderation.ts`                         | Affordance helpers and accurate outcome copy       |
| `Client/tests/e2e/fullstack/b9-moderation-actions.spec.ts (new)`                       | Narrow roles and partial voice outcome             |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan | Dated implementation status and exact-SHA evidence |

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

### Task 1: Add action forms

Offer warning, timeout and lift-timeout only to the appropriate role, preserving server hierarchy/self-target decisions. Use the Q10 duration input (a number with a minutes/hours/days unit, 1 minute–28 days, sent as `duration_seconds`; no presets); validate against server bounds without treating validation as authorization.

### Task 2: Keep linked and direct actions consistent

Consume report-linked act for queue actions and direct routes where allowed; preserve report public ids and distinguish a warning id from a report/appeal id.

### Task 3: Show committed outcome

Acknowledge success only after response. Surface text timeout with voice applied/skipped accurately, including partial voice authority; do not promise all media was disconnected. Refresh action history after successful commit.

### Task 4: Verify the permission ladder

Run warning-only, mute-only, combined, ordinary member, self, peer, superior and owner-target cases; change permissions during submission and preserve the server refusal.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/service/moderation_actions_test.go; Server/api/moderation_queue_act_test.go
- Proposed: moderation/warning-timeout.test.ts; fullstack/b9-moderation-actions.spec.ts

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

A broad success toast would overstate a skipped voice half; keep operation result separate from the user role label.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q10 — Timeout duration control

**Decided 2026-09-23 by the owner:** option (a). One duration input (a number with a minutes/hours/days unit selector), validated client-side to the server's 1 minute–28 days and sent as `duration_seconds`; server validation remains authoritative and its `BAD_REQUEST` message is shown on refusal. A "Lift timeout" action calls the existing untimeout route. No presets in beta.

**Options and consequences:** Use a validated duration input within the existing one-minute to 28-day bounds; or add owner-chosen presets plus custom input. The former avoids inventing moderation policy; presets are faster but imply preferred sanction lengths.

**Drafting recommendation (historical):** Use a validated duration input initially; add presets only if the owner chooses their labels and values.
