# Plan: B9-16 — Submit and track a local appeal

**Status:** DRAFT — 2026-09-23; planning only, implementation not started.

> **Milestone:** B9-16 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-16-personal-appeals`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 5, 8. **Requirements:** BPR-073, BPR-091, BPR-092.
> **Dependencies:** B9-15. Q6-approved recipient-discovery prerequisite. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Submit and track a local appeal. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Appeal an eligible action, survive a failed submit, withdraw or receive a decision, then reconnect and view the authoritative status.

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

| #   | Verified current state                                                                                                                   | Evidence at planning commit                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Submission requires a numeric moderation action_id; own status uses a distinct public appeal id.                                         | `Server/api/appeal_handler.go:15-29`; `Server/api/appeal_handler.go:69-75` |
| 2   | B5 fixes one appeal per action and a per-user cap; eligible kinds exclude kick, and currently banned users must use an out-of-band path. | `Server/service/appeal.go:165-188`                                         |
| 3   | Mine returns kind/reason/time/state/decision, not moderator internal notes.                                                              | `Server/api/appeal_handler.go:118-138`                                     |
| 4   | The moderator actions list is not a member-safe source of eligible action ids.                                                           | `Server/service/moderation.go:880-890`                                     |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

POST /api/v1/appeals, GET /mine, POST /{publicId}/withdraw and appeal_status; one appeal per action, three submissions per 24 hours at this commit. Banned-account policy is already settled, not reopened here.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/safety/{Appeals,api,store,wsHandlers}.ts (new or extend)`         | Appellant forms and status                         |
| `Client/src/lib/{types,dispatcher}.ts; Client/src/i18n/safety.ts`                      | Serialized event type/wiring and English           |
| `Client/tests/e2e/fullstack/b9-personal-appeals.spec.ts (new)`                         | Rate/duplicate/lifecycle journeys                  |
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

### Task 1: Require a real action source

Q6 and any separately planned recipient-history prerequisite must provide restart-safe authorized action ids before full closure. Never ask a user to guess an integer or grant moderator read authority to populate the form.

### Task 2: Build submission and withdrawal

Show the sanction summary, body field, local routing disclosure and server-controlled eligibility. Handle ALREADY_APPEALED, RATE_LIMITED, forbidden/deleted and closed cases without automatic resubmission; use the existing withdraw route.

### Task 3: Reconcile status

Read appeals/mine on entry/reconnect and apply appeal_status through dispatcher-owned state. Show open/assigned/decided/withdrawn/erased states actually returned; expose decision note only as authorized. Status is not proof removed content was restored.

### Task 4: Show unavailable paths honestly

Kick has no appeal under the settled policy. A currently banned account cannot authenticate to this API; provide accurate operator-contact guidance without inventing contact data or a banned-user bypass. Test allowed appeals after a ban lapses.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/service/appeal_test.go (TestAppeal_StateMachine and TestAppeal_WithdrawIsAppellantOnly)
- Proposed: safety/appeals.test.ts; fullstack/b9-personal-appeals.spec.ts

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

Live-only action ids make appeals disappear after restart. Q6 is a blocking contract dependency, not an optional UX enhancement.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q6 — Restart-safe recipient sanctions and appeal eligibility

**Options and consequences:** Add a member-safe own-action/restriction read with ids, reasons, expiry and eligibility; or use only existing live frames and ready warnings. The read needs a narrowly scoped server contract PR; live-only UX cannot recover removal/timeout action ids and all eligible history after restart and leaves BPR-072/073 incomplete. Currently banned users remain out-of-band under the existing B5 policy in either case.

**Recommendation (not approved):** Approve a separate B5 contract-completion PR for own-action/restriction discovery, with a DTO excluding reporter/evidence/internal notes. B9-15/16 remain blocked for complete closure until its exact contract is accepted.
