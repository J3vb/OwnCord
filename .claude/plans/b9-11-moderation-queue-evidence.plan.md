# Plan: B9-11 — Show the permission-gated moderation queue and authorized evidence

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-11 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-11-moderation-queue-evidence`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 8. **Requirements:** BPR-071, BPR-091.
> **Dependencies:** B9-4, B9-7, B9-10. B5 evidence-consent acceptance. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Show the permission-gated moderation queue and authorized evidence. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Enter the center as an authorized moderator, inspect permitted context, then lose permission or revoke consent while detail is pending.

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

| #   | Verified current state                                                                                                                                 | Evidence at planning commit                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | The queue DTO carries a public id, state and assignee; detail separately carries evidence, notes, events and action links.                             | `Server/api/moderation_queue_handler.go:14-81`                         |
| 2   | Queue endpoints require authenticated access and service-level moderation authority; detail handling has an authorization-before-id-resolution helper. | `Server/api/moderation_queue_handler.go:110-162`                       |
| 3   | The report subject cannot read the report; a moderator who filed it gets no internal notes.                                                            | `Server/service/report.go:433-463`; `Server/service/report.go:526-560` |
| 4   | The public B5 plan requires evidence consent verification before this interface is built.                                                              | `docs/plans/b5-community-content-moderation-2026-09-04.md:2940-2945`   |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

GET /api/v1/moderation/queue and /{publicId}; MODERATE_MEMBERS plus confidentiality. Report events are the feature history, not the global audit log. B5 evidence-consent acceptance is an additional blocking prerequisite.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/moderation/{api,store,Queue,Evidence}.ts (new)`                   | Queue/detail authorization lifecycle               |
| `Client/src/lib/{api,types,dispatcher}.ts; B9-4 composition`                           | Serialized DTO/event and route integration         |
| `Client/tests/e2e/fullstack/b9-moderation-queue.spec.ts (new)`                         | Role and consent matrix                            |
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

### Task 1: Check the hard dependency

Do not start the evidence surface until B5 publishes accepted consent behavior for report evidence and attachments, revoke and relabel/deletion. Capture its exact contract/test refs in this plan. No client-only substitute and no private advisory details in the PR.

### Task 2: Build queue and selected detail

Load only after moderation permission is known; render supported state filters and authoritative result counts. Use separate feature-scoped DTOs and lazy detail reads; do not assume pagination parameters the API does not offer.

### Task 3: Render authorized snapshots

Use only returned snapshot/context, no unrestricted channel-history fallback. Suppress external media automatically and use the consent gate before protected evidence requests. Show deleted/retained-by-reference attachment states without implying content can be restored.

### Task 4: Clear on authority changes

Handle role loss, subject/reporter role overlap, stale selection, logout/profile switch and racing response completion. Remove private DOM, accessibility text and memory state; mod_queue is an invalidation signal, not evidence itself.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/api/moderation_queue_authz_test.go; Server/service/report_test.go
- Proposed: moderation/queue.test.ts; moderation/evidence.test.ts; fullstack/b9-moderation-queue.spec.ts

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

A green list response does not authorize every detail. Preserve server omissions, 403/404 outcomes and per-content consent without probing for hidden records.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.
