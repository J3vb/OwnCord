# Plan: B9-10 — Report local messages, users and attachments and show own report status

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-10 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-10-local-report-intake`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 8. **Requirements:** BPR-070, BPR-091.
> **Dependencies:** B9-4, B9-3. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Report local messages, users and attachments and show own report status. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Report a message, a user and an attachment; review only the submitted report status; exercise duplicate, removed target and quota refusal.

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

| #   | Verified current state                                                                                    | Evidence at planning commit                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | The authenticated intake accepts target_type, target_id, reason and detail; creation returns a public id. | `Server/api/report_handler.go:32-38`; `Server/api/report_handler.go:54-59`; `Server/api/report_handler.go:76-92` |
| 2   | The reporter view returns summaries, not moderator evidence or internal notes.                            | `Server/api/report_handler.go:40-50`; `Server/api/report_handler.go:96-115`                                      |
| 3   | B5 reason categories are finite and server-owned.                                                         | `Server/service/report.go:53-59`                                                                                 |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

POST /api/v1/reports; GET /api/v1/reports/mine. B5 visibility, duplicate and rate-limit enforcement remains authoritative. No cross-server report routing.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                                          | Purpose                                             |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `Client/src/features/reports/** (new)`                                                                        | Typed intake and My reports UI with colocated tests |
| `Client/src/components/message-list/; Client/src/components/UserProfilePopup.ts; B9-4 navigation integration` | Narrow report entry callbacks                       |
| `Client/src/lib/api.ts; Client/tests/e2e/fullstack/b9-reports.spec.ts (new)`                                  | REST wrappers and real-server journey               |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan                        | Dated implementation status and exact-SHA evidence  |

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

### Task 1: Add target-specific entry points

Wire report actions on the existing message, user and attachment menus; pass the actual local target identifier and type. Use Q2 navigation for My reports without exposing moderator data.

### Task 2: Build the bounded form

Render B5 reason codes as English labels with detail validation, pending submission, duplicate/rate-limit/refused/deleted-target responses. Explain submission goes only to this server. No screenshot upload, central relay or guessed target metadata.

### Task 3: Show the authorized summary

Read reports/mine, display state/outcome/time and empty/error states. Treat erased/expired evidence as unavailable; never fill a missing field by calling the moderation queue.

### Task 4: Prove role isolation

Use member, reporter, subject and moderator accounts in a real-server scenario; cancellation sends nothing and completion returns focus. Record privacy-safe network destinations and summary field allowlist.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/service/report_test.go; Server/api/report_absence_test.go
- Proposed: reports/intake.test.ts; fullstack/b9-reports.spec.ts

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
- [ ] **Screen reader:** approved native AT reads names, roles, values, errors
      and relevant status once; no concealed/private/secret content in its tree.
- [ ] **Focus:** visible indicator, logical order, dialog containment/restore,
      stable location through async update/removal, and a safe fallback opener.
- [ ] **Contrast:** measure agreed text, controls, status and focus targets in
      built-in/high-contrast themes and the Q8-approved custom-accent policy;
      information never depends on color alone.
- [ ] **Reduced motion:** test both OS and app settings; no required animation,
      unwanted autoplay or motion-dependent feedback; preserve media controls.
- [ ] **Zoom/reflow:** test Q1-approved text scaling and desktop zoom/reflow,
      long English/expanded strings and smallest supported desktop window;
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

Borrowing a moderator detail response for My reports overexposes fields. Use separate typed DTOs and caches.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
