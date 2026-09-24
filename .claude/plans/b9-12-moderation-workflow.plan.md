# Plan: B9-12 — Assign, annotate and close reports with immutable history

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch `fm/b9-12-impl` from `dev` `9c5f5d67f29bc2313adb227a6e2c1d60abc962c6`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

> **Milestone:** B9-12 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-12-moderation-workflow`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 4, 8. **Requirements:** BPR-071, BPR-091.
> **Dependencies:** B9-11. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Assign, annotate and close reports with immutable history. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Assign a report, add a note, close it, then inspect its immutable history while a second moderator races an update.

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

| #   | Verified current state                                                                            | Evidence at planning commit                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | The queue API exposes assign, notes, close and act as distinct routes.                            | `Server/api/moderation_queue_handler.go:116-125`                                                |
| 2   | Notes and close have explicit request shapes; report events are a separate immutable history DTO. | `Server/api/moderation_queue_handler.go:42-57`; `Server/api/moderation_queue_handler.go:84-100` |
| 3   | The service forbids self-review by the reporter and validates supported queue states.             | `Server/service/report.go:444-463`; `Server/service/report.go:487-499`                          |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

POST /api/v1/moderation/queue/{id}/{assign,notes,close}; confidentiality/self-review and transactional writes in ReportService. No VIEW_AUDIT_LOG escalation is needed for report_events.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/moderation/{Workflow,History,store,api}.ts (new or extend)`       | Assignment/note/closure and immutable history      |
| `Client/src/i18n/moderation.ts (new or extend); owned moderation CSS`                  | English and local styles                           |
| `Client/tests/e2e/fullstack/b9-moderation-workflow.spec.ts (new)`                      | Conflict, retention and audit evidence             |
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

### Task 1: Add bounded workflow controls

Allow assignment using exactly the existing endpoint semantics, note submission and terminal outcome selection. Do not invent a bulk queue, arbitrary reassignment, reopen endpoint or editable history.

### Task 2: Expose conflicts honestly

Keep user draft only within the live authorized view; prevent duplicate submit and reconcile 409/stale assignment with a fresh detail read. Loss of authority destroys draft and private data. Do not silently overwrite another moderator.

### Task 3: Render history accurately

Render returned report events and action links chronologically with safe UTC/date formatting. Keep internal notes separate from target-visible reason/outcome copy; erasure and retention states are facts, not broken loading.

### Task 4: Exercise adversarial roles

Cover reporter-as-moderator, subject-as-moderator, self-review rejection, competing assign/close and deletion during note entry. Record the role matrix and an audit walkthrough using synthetic data.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/service/report_test.go; Server/service/report_retention_test.go
- Proposed: moderation/workflow.test.ts; fullstack/b9-moderation-workflow.spec.ts

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

Notes are private even when the moderator is also the reporter; never recycle the internal form as a user-visible reason field.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record (2026-09-24)

### Drift at the implementation base

Re-read at `9c5f5d67` (B9-11 #1774 merged). Every inventory row still holds;
the line ranges moved:

- Row 1: the routes are `Server/api/moderation_queue_handler.go:120-130`
  (`MountModerationQueueRoutes`); assign also takes `?force=1`, which this
  milestone does not offer (Task 1: no arbitrary reassignment).
- Row 2: `addNoteRequest`/`closeReportRequest` are `:88-94`; the detail DTO
  (`:61-86`) carries `notes`, `events` (`moderationEventResponse`, `:52-57`)
  and `actions` (`moderationActionResponse`, `Server/api/moderation_handler.go:42-53`).
- Row 3: `guardConfidentiality` / `GuardSelfReviewFor` are
  `Server/service/report.go:437-464`, `Get` `:538-573`, `Assign` `:581-622`,
  `Note` `:627-660`, `Close` `:666-693`. Contract facts the client relies on:
  a reporter reads their own report but gets no notes and a 403
  `SELF_REVIEW` on every write; the subject gets 404 everywhere; assign is 409
  when someone else holds the report or it closed; a note is 409 once the
  report closed and 400 for an empty body, more than 4,000 runes or any C0
  control character (line breaks included); close is 409 when already closed
  and does not require the closer to hold the report; the events are
  `created` (actor 0, detail = reason), `assigned`, `noted`, `closed`
  (detail = outcome); erasure sets an event's actor to 0; the retention sweep
  deletes a closed report's notes and evidence and keeps its events.

B9-11 left no server gap: no server, protocol, schema or migration change.

### What shipped

- **Review controls** (`features/moderation/Workflow.ts`). An unassigned
  report offers "Take this report" (plain assign, never `force`); once the
  reader holds it, an internal-note field and a close form with a required
  outcome (Action taken, No action needed, Already reported; nothing
  preselected; "a closed report can't be reopened"). A report someone else
  holds, the reader's own filing and a closed report offer no control, each
  with a sentence saying why.
- **Writes and conflicts** (`Queue.ts`). One write at a time, even across a
  re-read that rebuilds the controls; whatever the answer, the queue and the
  report are read again, each directly, so a failed queue read still re-reads
  the report and the server's state replaces the view's guess. The guard
  holds until that report read settles (rendered, failed or dropped), so the
  controls still on screen from before the write can't send it twice: no
  second take, no duplicate note, no false "already closed" after an own
  close.
  409 says which race was lost ("Another moderator took this report first",
  "Your note wasn't saved: this report was closed", "already closed by
  another moderator"); 403 `SELF_REVIEW` says so without leaving; any other
  403 is B9-11's refusal (every report and the draft go); 404 closes the
  report and re-reads the queue; a failed save keeps the note for another
  try. A report the reader just closed leaves the active list without the
  "no longer in this list" notice, and the status says it is under
  Show: Closed.
- **Draft lifetime.** The unsaved note lives only for its report while the
  view is live: switching report, refusal, 404, the view closing, role loss
  and sign-out drop it; a re-read that takes the note field away (someone
  else took or closed the report) drops it and says so. A background re-read
  keeps the draft, focus and caret.
- **History** (`History.ts`, adapter in `api.ts`). Internal notes in their own
  section (author, UTC-parsed local date, text), never mixed into the history.
  The history merges report events and the moderator actions taken with the
  report in time order (stable; unreadable times last); an action's reason is
  labelled "Reason shown to the member". Read-only by construction: no
  control inside either. Erased actors read "A deleted account", an unknown
  event "… updated the report", notes removed by retention "Note text is no
  longer kept …", notes of a report closed because its subject was erased
  (`subject_erased`) "Note text was deleted along with the reported
  account." rather than the retention copy, and the reporter's own view says
  why notes are hidden.

### Implementation decisions and file-table amendments

- **Note and close require holding the report.** The server lets any
  moderator note or close; the client offers them only to the moderator who
  took the report, so one moderator never overwrites another's review
  (Task 2) and there is no take-over (Task 1). This only narrows what the
  server allows.
- **Line breaks are sent as spaces**, and the hint says so: the server
  refuses every control character, so a multi-line note would always fail.
- **Files beyond the table**, each narrow wiring: `lib/api.ts` (the three
  write methods and the detail's `reporter_id`/`notes`/`events`/`actions`
  fields — the shared single-writer file, as B9-11 did for its reads),
  `features/moderation/{Evidence,Queue}.ts` (export `memberName`; compose the
  review into B9-11's detail), `styles/app/chat-area.css` (B9-11's
  moderation fragment; tokens only, no import change),
  `tests/e2e/b9-moderation-workflow.spec.ts` (the Q1 checks, mocked), and
  B9-11's `evidence.test.ts`/`queue.test.ts` fixtures (the new wire fields;
  the adapter test that pinned "notes and events are dropped" now pins that
  they are kept apart, and still that no upload id is kept).
- **Not touched:** navigation, MainPage, dispatcher, global stores (read-only
  use of `authStore` and `membersStore`), tokens, the catalog API, the PRD.
- **Budget.** Measured at the base: startup 93,955 B, MainPage 63,980 B; with
  this change 94,100 B of 95,500 B and 63,978 B of 64,000 B, no budget change.
  The review, history and copy load with the lazy Moderation Center chunk;
  the startup growth is the three API methods and the grouped CSS.

### Evidence

Base `9c5f5d67`; Node 26.9.0, vitest 4.1.11, Playwright Chromium, Go 1.26.7,
Linux.

| Check                                                                                                      | Result                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `npx vitest run --maxWorkers=4` (whole client)                                                             | 307 files, 6,665 passed, 152 expected-fail  |
| `src/features/moderation/{workflow,queue,evidence}.test.ts`                                                | 48 passed                                   |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint)           | clean                                       |
| `npm run build:budget && npm run check:budgets`                                                            | all ok; startup 94,100 B, MainPage 63,978 B |
| Playwright (dev server): `b9-moderation-workflow`, `b9-moderation-queue`, `b9-navigation`                  | 28 passed                                   |
| Playwright fullstack (real Go server): `fullstack/b9-moderation-workflow`, `fullstack/b9-moderation-queue` | 1 and 2 passed                              |
| `npx prettier --check` (changed files), `npm run check:docs`                                               | clean, passed                               |

**Role matrix and audit walkthrough** (fullstack, synthetic accounts: alice
owner and second moderator, bob moderator in the client then demoted, carol
and dave reporters and subjects):

| Role                         | Offered in the client                      | Server answer                                  |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Moderator, report unassigned | Take this report                           | assign 204                                     |
| Moderator holding it         | Add note, Close with outcome               | notes 204, close 204                           |
| Another moderator holds it   | nothing ("Another moderator is reviewing") | stale Take → 409, view shows alice as assignee |
| Reporter as moderator        | nothing; notes hidden                      | assign 403 `SELF_REVIEW`                       |
| Subject as moderator         | report not listed                          | assign, notes, close 404                       |
| Demoted moderator            | view, draft and reports gone               | assign, notes, close 403                       |

Bob takes carol's report from the keyboard, adds a two-line note (saved as one
line), then, with his `mod_queue` frames held back, alice closes it while he
writes a second note: his save gets 409 and says the report closed. Alice then
takes another report before bob's stale Take: 409, and the re-read shows her.
Under Show: Closed the history reads, in order, "Report sent for Harassment",
"You took the report", "You added an internal note", "alice closed the
report: Action taken", matching the server's `events`
(`created, assigned, noted, closed`) and `notes`; the closed report has no
textarea, input or button. Nothing scrolls sideways at 940×500. Retention is
covered by the unit suite (closed report with a `noted` event and no notes),
not the fullstack run: the sweep's window is days.

**Failing controls.** Each guard was removed in turn and the moderation unit
suite re-run; each failed and was restored: the reporter's no-controls branch,
the other-moderator no-controls branch (3 tests), 403-on-write denies, the
draft-lost notice, the own-close "not gone" case, focus restored by key, the
per-report draft reset, and one-write-at-a-time (3 tests).

**Review fixes.** The write guard now holds until the post-write report read
settles, the report is re-read directly after every write, and an erased
subject's notes get their own line; the unused `history.system` string is
gone. Five new `workflow.test.ts` cases (second take, duplicate note, guard
released after a retried failed read, re-read despite a failed queue read,
erasure copy) and the 409 case (report re-read at once, not after the queue)
each failed on the previous head and pass now; the moderation unit suite is
53 passed.

### Accessibility (Q1)

- **Keyboard:** the note field, Add note, the outcome group (one Tab stop,
  arrows within) and Close report follow in reading order; Enter submits;
  an empty note or no outcome is refused locally with the error on the field
  or group and focus moved to it; B9-11's Escape path is unchanged
  (`b9-moderation-workflow.spec.ts`, keyboard and outcome tests). No
  hover-only action.
- **Screen reader:** the review is a region named "Review"; the note field
  is labelled, described by its privacy hint and its error; the outcome is a
  fieldset with a legend, described by its error; Close report is described
  by "can't be reopened". Success is announced once through a `role="status"`
  region and conflicts and refusals through a `role="alert"` region, both
  outside the rebuilt report so they exist before their text changes. Every
  control has a name (`findUnnamedControls`). Refusal and role loss remove the
  notes, history and draft from the tree. **NVDA and Orca recordings are
  owner-run and pending.**
- **Focus:** after a write or a background re-read, focus returns to the
  same control (caret kept in the note field); when that control is gone (a
  take or close), it goes to the report heading, or to the list after the
  report leaves it; never to `<body>`.
- **Contrast:** measured in dark, neon-glow, midnight and light, each with
  and without High Contrast: notes heading, byline and text, history hint,
  entry, date and action reason, review heading and state, note label and
  hint, outcome legend and labels, close hint, and both buttons, all ≥ 4.5:1;
  focus on the note field, Add note, the outcome radio and Close report
  ≥ 3:1 (JSON attached per theme). No state relies on colour: each is a
  sentence.
- **Targets:** buttons, the note field and each outcome label ≥ 24×24 CSS px.
- **Motion:** the review, history entries, notes and outcome labels have no
  animation or transition.
- **Zoom/reflow:** at 940×500 with 20 px Large Font every control, note and
  history entry scrolls into view and the view does not scroll sideways
  (screenshot attached); long text wraps. The OS 200 % zoom check is
  owner-run and pending with the native recordings.
