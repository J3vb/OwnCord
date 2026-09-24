# Plan: B9-17 — Review and decide appeals without overexposing information

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch `fm/b9-17-impl` from `dev` `c215cadeb4e16bff71f9ecac5261b50b27f0a453`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-17 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-17-moderation-appeal-review`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 5, 8. **Requirements:** BPR-071, BPR-073, BPR-091.
> **Dependencies:** B9-12, B9-13, B9-16. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Review and decide appeals without overexposing information. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Assign and decide an appeal, see the appellant status update and verify the authorized immutable action/history result.

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

| #   | Verified current state                                                                                                                | Evidence at planning commit                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Moderator appeal endpoints list, fetch, assign and decide; detail includes a moderated action and an optional authorized report link. | `Server/api/appeal_handler.go:32-65`; `Server/api/appeal_handler.go:78-89`; `Server/api/appeal_handler.go:201-210` |
| 2   | Assignment and decision apply self-review and eligibility guards in the service.                                                      | `Server/service/appeal.go:431-444`; `Server/service/appeal.go:461-488`; `Server/service/appeal.go:553-598`         |
| 3   | Report detail explicitly separates internal notes and event history.                                                                  | `Server/api/moderation_queue_handler.go:42-81`                                                                     |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

GET /api/v1/moderation/appeals and /{id}; POST /{id}/assign and /decide. B5 owns conflict-of-interest, transactional reversal and notifications.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                     | Purpose                                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/moderation/{AppealQueue,AppealDetail,api,store}.ts (new or extend)` | Review workflow                                    |
| `Client/src/i18n/moderation.ts; owned moderation CSS`                                    | Distinct decision and private-note language        |
| `Client/tests/e2e/fullstack/b9-appeal-review.spec.ts (new)`                              | Reviewer/appellant role and audit evidence         |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan   | Dated implementation status and exact-SHA evidence |

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

### Task 1: Add the appeal tab

Reuse the approved center navigation and list/detail primitives. Keep report and appeal identifiers and DTOs separate; follow a report link only when returned and authorized.

### Task 2: Assign and decide

Support the actual B5 outcomes and note constraints. Make appellant-visible decision text distinct from internal report notes. Handle SELF_REVIEW, stale assignment, already-decided and REVERSAL_FAILED without displaying success.

### Task 3: Show the committed result

Refresh after decision, show whether the recorded outcome is uphold/overturn, and explain that an overturn of removal is record-only rather than recovered content. Preserve the sole-eligible-moderator exception and its audit record without turning it into a client bypass.

### Task 4: Prove both sides

Run reviewer/appellant views together, role loss, self-appellant, acting moderator with another eligible moderator, sole moderator, race and retention/deletion cases. Check appellant never receives reviewer-only fields.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/service/appeal_test.go (TestAppeal_ActingModeratorMayNotDecideWhereAnotherExists, TestAppeal_SoleModeratorMayDecideAndAuditSaysSo, TestAppeal_OverturnRemovalIsRecordOnly)
- Proposed: moderation/appeals.test.ts; fullstack/b9-appeal-review.spec.ts

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

A generic Overturned label may imply restored deleted content or a broader reversal than the specific action. Render the actual B5 result.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record (2026-09-24)

### Drift at the implementation base

Re-read at `c215cade` (B9-12 #1777, B9-13 #1784 and B9-16 #1763 merged).
Every inventory row still holds; the line ranges moved:

- Row 1: `MountModerationAppealRoutes` is `Server/api/appeal_handler.go:82-90`;
  list `:163-186`, detail `:188-217` (the report link is set only when
  `VisibleReportPublicID` authorizes it, `:207-212`), assign `:220-237`,
  decide `:240-258`. Assign also takes `?force=1` (outrank reassignment),
  which this client never sends.
- Row 2: `Server/service/appeal.go` `Queue` `:373-392` (omits the caller's own
  appeals), `Get` `:413-429` (403 `SELF_REVIEW` on the caller's own appeal),
  `guardAppellantSelfReview` `:442-447`, `Assign` `:460-499`, `Decide`
  `:552-620`. Contract facts the client relies on: every route is
  MODERATE_MEMBERS (403 `FORBIDDEN` otherwise, re-checked inside the write's
  transaction); the moderator who issued the action gets 403 `SELF_REVIEW`
  while another eligible moderator exists, and the sole-moderator exception
  is recorded by the server in the audit detail (`overturned (sole
moderator)`); decide writes on the observed state and assignee, so any
  change in between is 409 `CONFLICT`; an overturn whose reversal fails is 409
  `REVERSAL_FAILED` and nothing commits; the decision note (at most 2,000
  runes, no control characters, optional) is what the appellant reads in
  `GET /appeals/mine`. Decide does not require the decider to hold the appeal.
- Row 3: unchanged (`Server/api/moderation_queue_handler.go:42-82`).
- No server contract is missing: no server, protocol, schema or migration
  change. The queue row also carries the statement and decision note; the
  client adapter drops both from the list model.

### What shipped

- **Appeals tab** (`Queue.ts`): the Moderation Center is now a two-tab view,
  Reports and Appeals (WAI-ARIA tabs, activation follows focus, Left/Right,
  Home/End). The Appeals tab renders on first selection, so no appeal is read
  before it is chosen.
- **Queue** (`AppealQueue.ts`): filters Open and in review / Waiting for
  review / In review / Decided, with the count. A row names the appellant, the
  state and the filing date, never the statement or a decision note. The
  selected appeal stays open while its own read succeeds, even after leaving
  the filter, so a decision shows the recorded result. `mod_queue` appeal
  frames (`appeal_id`, now routed by `handleModQueue` to their own counter)
  and a reconnect only re-read.
- **Detail** (`AppealDetail.ts`): the appealed action (kind, who issued it,
  when, the reason shown to the member, until/lifted/acknowledged), the
  appellant's statement, and "Open the report" only when the server returned
  `report_id`; it opens in Reports by id (outside the filter) and is read with
  its own authorization. No evidence and no internal notes are ever part of
  an appeal.
- **Take and decide**: as in B9-12, take first and only the holder decides; an
  appeal someone else holds offers nothing and assignment is never forced. The
  moderator who issued the action is offered the controls with the server's
  rule stated, and the server decides (SELF_REVIEW, or the audited
  sole-moderator exception); the client never bypasses it. The decision is
  Uphold / Overturn (nothing preselected) with the kind's overturn effect as
  the group's description (a removal overturn is record-only: the message is
  not restored). The note is "Note to the appellant", described as not an
  internal note; line breaks and control characters are sent as spaces.
- **Committed outcome**: nothing is reported before the server answers; after
  every answer the queue and the appeal are re-read. A decided appeal shows
  "Upheld: the action stands." or "Overturned." with the kind's result, the
  note sent and that the appellant sees it in Safety without the decider. A
  withdrawn appeal says it can't be decided.
- **Refusals**: 403 `SELF_REVIEW` is shown as the server's refusal (and on the
  detail read as "You filed this appeal"); 409 `REVERSAL_FAILED` and 409
  conflicts say nothing was recorded and keep the draft; 400 shows the
  server's message; 404 closes the appeal; no answer says the change could
  not be confirmed. Any other 403 (a demoted moderator) clears both tabs and
  every appeal and report from the DOM and memory.

### Implementation decisions and file-table amendments

- **Only the holder decides**, like B9-12's close; the server would let any
  moderator decide an open or assigned appeal, so this only narrows.
- **Files beyond the table**, each narrow wiring: `lib/api.ts` (the four
  appeal methods and their wire types — the shared single-writer file, as
  B9-11..13 did), `features/moderation/Queue.ts` (the tabs, cross-tab deny and
  opening a linked report by id), `features/moderation/wsHandlers.ts`
  (appeal frames bump their own counter; dispatcher registration unchanged),
  `styles/app/chat-area.css` (the owned moderation fragment: tab styling, and
  `[hidden]` on the toolbar, which the B9-11 `display: flex` had overridden),
  and `tests/e2e/b9-appeal-review.spec.ts` (the Q1 checks, mocked). The unit
  test is `features/moderation/appeals.test.ts`.
- **Not touched:** navigation, MainPage, dispatcher, global stores (read-only
  `authStore`/`membersStore`/`uiStore`), tokens, the catalog API, the PRD (its
  shared status table and per-lane paragraphs are left alone; this record is
  the status).
- **Budget.** Startup 96,291 B of 97,000 B (dev `c215cade` 96,130 B: +161 B,
  the four API methods, the appeal counter and the tab CSS), MainPage 61,286 B
  of 64,000 B; no budget change. The views and copy load with the lazy
  Moderation Center chunk.

### Evidence

Base `c215cade`; Node 26.9.0, vitest 4.1.11, Playwright Chromium, Go 1.26,
Linux. Local Playwright ran the dev server on port 1517 and the preview on
4173, never 1420.

| Check                                                                                                                                        | Result                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `npx vitest run --maxWorkers=4` (whole client)                                                                                               | 310 files, 6,766 passed, 152 expected-fail |
| `src/features/moderation/appeals.test.ts`                                                                                                    | 17 passed                                  |
| Failing control: a demoted moderator's 403 shown as a refusal (not cleared); success shown before the answer; deny not propagated to Reports | 1, 4 and 1 tests fail, as intended         |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint`                                                                      | clean                                      |
| `npm run build:budget && npm run check:budgets`                                                                                              | all ok                                     |
| Playwright (dev server): `b9-appeal-review` (13)                                                                                             | 13 passed                                  |
| Playwright (dev server): `b9-moderation-queue`, `-workflow`, `-actions`, `b9-text-expansion`                                                 | 47 passed                                  |
| Playwright fullstack (real Go server): `b9-appeal-review`                                                                                    | 1 passed                                   |
| Playwright fullstack: `b9-moderation-queue`, `-workflow`, `-actions`, `b9-personal-appeals`                                                  | 7 passed                                   |

**Both sides, real server** (`fullstack/b9-appeal-review.spec.ts`, synthetic
accounts: alice owner via the API; carol a "Warden" with MODERATE_MEMBERS in
the client; bob the appellant in a second client on his Safety tab):

| Case                                           | Client                                                                      | Server                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Take, then overturn with a note                | "You're now reviewing…", then "Decision recorded…" and "Overturned."        | `overturned`, note saved; audit `appeal_decide` by carol      |
| Appellant view                                 | bob: under review → overturned, "Moderator's note: Fair point."; no "carol" | `/appeals/mine` rows carry exactly the eight member-safe keys |
| Race: bob withdraws while carol's form is open | "Nothing was recorded: this appeal changed first…", then "withdrew"         | 409; state `withdrawn`                                        |
| Acting moderator, another eligible moderator   | Take offered with the rule stated; "The server refused…"                    | 403 `SELF_REVIEW`; still open, unassigned                     |
| Demoted while frames are held                  | stale Take → "You no longer have permission…"; appeal and rows gone         | 403; appeal unchanged; queue 403 for carol afterwards         |
| Sole moderator                                 | not reachable here (the owner is always eligible)                           | `TestAppeal_SoleModeratorMayDecideAndAuditSaysSo` (Go)        |

**Accessibility** (mocked Playwright, `b9-appeal-review.spec.ts`): the tabs
are a named tablist operable with arrows; keyboard order heading → Open the
report → decision group (one stop, arrows choose) → note → Record decision,
each operable with Enter/Space; the missing-outcome error is `role="alert"`,
referenced by the group's `aria-describedby`, with focus on the first
option; the outcome is announced in the `role="status"` line only after the
answer; Escape closes the appeal back to its row; no unnamed control; every
target at least 24×24 px; no animation or transition in the tab or the
decision section; text, control, error and focus contrast at the Q1
thresholds in dark, neon-glow, midnight and light, each with and without High
Contrast (ratios attached as `b9-17-contrast-*.json`); at 940×500 with 20 px
Large Font nothing scrolls sideways and every control and line scrolls into
view (screenshot attached). Custom-accent fallback is inherited unchanged
from B9-2 (no new colour). **Owner-run pending:** NVDA (Windows) and Orca
(Linux) recordings, and the 200 % OS-zoom check.
