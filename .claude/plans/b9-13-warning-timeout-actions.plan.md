# Plan: B9-13 — Issue warnings and timeouts with accurate outcomes

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-24 on branch `fm/b9-13-impl` from `dev` `ea22a3bf699f9c1841502ceb69a8dbe3c3dabb2c`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-24).

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

## Implementation record (2026-09-24)

### Drift at the implementation base

Re-read at `ea22a3bf` (B9-12 #1777 merged). Every inventory row still holds;
the line ranges moved:

- Row 1: the direct routes are `Server/api/moderation_handler.go:87-96`
  (`MountModerationRoutes`: warn, timeout, untimeout, actions), bodies
  `:15-36`, handlers `:108-182`. Warn answers 201 `{id}`, timeout 201
  `{id, voice}`, untimeout 204.
- Row 2: the bounds are `Server/service/moderation.go:254-259`; `Warn`
  `:282-324`, `Timeout` `:342-391`, `LiftTimeout` `:473-508`. Contract facts
  the client relies on: MODERATE_MEMBERS, then target exists, then rank
  (`requireOutranksRole`: the actor's role position must be strictly higher),
  all 403 `FORBIDDEN` with no code telling "no permission" from "outranked";
  acting on yourself and a bad duration or reason (over 500 runes, any
  control character) are 400 `BAD_REQUEST`; lifting with no active timeout
  is 404. The voice half is "applied" only when the actor holds base
  MUTE_MEMBERS, can moderate voice in the target's current channel and the
  mute succeeded (`applyTimeoutVoiceHalf`, `:401-411`); a target not in voice
  is "skipped". A new timeout supersedes (lifts) the previous one.
- Row 3: `actOnReportRequest`/`actOnReportResponse` are
  `Server/api/moderation_queue_handler.go:99-114`, the handler `:337-411`.
  The act route checks MODERATE_MEMBERS first, then reads the report (404 for
  its subject), refuses its reporter (403 `SELF_REVIEW`), and answers a
  timeout 200 `{voice}` and a warning 204. It does not check the report's
  state. The report detail already carries `subject_id` and each action's
  `expires_at`; the client type lacked both.
- No server contract is missing: no server, protocol, schema or migration
  change. `dev` moved to `879740bf` (B9-19 #1781, B9-23 #1779) during the
  work and was merged in; neither touches the moderation files.

### What shipped

- **Actions section** (`features/moderation/ActionForms.ts`), labelled
  "Actions", after the review. The moderator holding an open report gets a
  warning form and a timeout form, each with a single-line reason labelled
  "shown to the member" (optional, as on the server; at most 500 characters;
  control characters sent as spaces). The timeout length is Q10 exactly: one
  number field and a Minutes/Hours/Days select, no presets; a length that is
  not a whole number from 1 minute to 28 days is refused before sending with
  an announced error and focus on the field. "Lift timeout" is offered while
  a timeout taken with this report is still running (the history's
  `expires_at` in the future, not lifted), described by its end time, to the
  holder of the open report or on a closed report; never when another
  moderator holds it. Nothing is offered on the reader's own filing or after
  the subject's account is erased, and nothing before the reader takes the
  report.
- **Linked and direct routes.** Warning and timeout go through
  `POST /moderation/queue/{public id}/act`, so the ledger row carries the
  report's public id; lifting uses the member's own
  `POST /moderation/users/{id}/untimeout` (there is no report-linked lift).
  The report id stays the opaque string and the member id the number; the
  warning's ledger id is never shown or used.
- **Committed outcome** (`Queue.ts`). Each action is one write under B9-12's
  one-at-a-time guard, and the queue and report are read again after every
  answer. Nothing is acknowledged before the server answers. A timeout's
  status line names the length and restricts its claim to messages and
  reactions; it adds "They were also server-muted in their voice channel"
  only when the server answered `voice: "applied"`, and otherwise says their
  voice wasn't changed (not in a voice channel the moderator can moderate, or
  the mute didn't take effect). Lifting says messages and reactions are back
  and makes no voice claim.
- **Refusals.** B9-12 treats a 403 on a review write as lost permission and
  clears the view. For an action a 403 can also mean the subject is ranked at
  or above the reader, which the client can't see (roles reach it without
  positions), so it says "The server refused this action. You can act only on
  members whose role is below yours." and reads again: if the reader was
  demoted, that read's own 403 clears the view, its reports and any unsaved
  reason. A 400 shows the server's own message; a 404 on lift says there is
  no timeout left and keeps the report; a 404 on the act route closes the
  report as B9-12 does; no answer at all (network, 500) says the action could
  not be confirmed and to check the history, which the re-read refreshes.
- **Drafts.** The typed reasons, length and unit live for their report while
  the view is live and survive a background re-read (focus and caret kept);
  a saved warning or timeout clears its own form; a re-read that takes the
  forms away (someone else took the report) drops the draft and says so.
- **History** (`History.ts`, adapter in `api.ts`): a timeout that is not
  lifted shows "Until {date}".

### Implementation decisions and file-table amendments

- **Actions require holding the report**, like B9-12's note and close: the
  server would let any moderator act on any report, so this only narrows.
- **No `permissions.ts` helper.** The Moderation Center is already gated on
  MODERATE_MEMBERS (`canModerateMembers`), the one bit warning and timeout
  need; the voice half's authority is per channel and decided by the server,
  so the client states the outcome instead of predicting it.
- **Files beyond the table**, each narrow wiring: `lib/api.ts` (the act and
  untimeout methods, `ModerationActRequest`, and the detail's `subject_id`
  and actions' `expires_at` — the shared single-writer file, as B9-11 and
  B9-12 did), `features/moderation/Queue.ts` (compose the section and send
  its writes), the B9-11/B9-12 unit fixtures (the new `subject_id` field),
  and `tests/e2e/b9-moderation-actions.spec.ts` (the Q1 checks, mocked).
  No CSS: the section reuses B9-12's `mod-work`/`mod-work-form` rules.
- **Not touched:** navigation, MainPage, dispatcher, global stores (read-only
  `authStore`), tokens, styles, the catalog API, the PRD (its shared status
  table and per-lane paragraphs are left alone; this record is the status).
- **Budget.** Startup 94,454 B of 95,500 B, MainPage 63,992 B of 64,000 B,
  no budget change. The forms and copy load with the lazy Moderation Center
  chunk; the startup growth is the two API methods.

### Evidence

Base `ea22a3bf`; Node 26.9.0, vitest 4.1.11, Playwright Chromium, Go 1.26.7,
Linux. Local Playwright ran on ports 1497 (dev server) and 4197/4173
(preview), never 1420.

| Check                                                                                                                       | Result                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `npx vitest run --maxWorkers=4` (whole client)                                                                              | 308 files, 6,728 passed, 152 expected-fail |
| `src/features/moderation/warning-timeout.test.ts`                                                                           | 38 passed                                  |
| Failing control: 403 on an action handled as lost permission, or the timeout always reported as voice "applied"             | 4 of those tests fail, as intended         |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint)                            | clean                                      |
| `npm run build:budget && npm run check:budgets`                                                                             | all ok                                     |
| Playwright (dev server): `b9-moderation-actions` (12), `b9-moderation-workflow`, `b9-moderation-queue`, `b9-text-expansion` | 12 and 33 passed                           |
| Playwright fullstack (real Go server): `b9-moderation-actions`, `b9-moderation-workflow`, `b9-moderation-queue`             | 4 passed                                   |

**Permission ladder** (fullstack, synthetic accounts: alice owner; bob a
"Warden" role, MODERATE_MEMBERS without MUTE_MEMBERS, position 50, in the
client; carol reporter; dave subject; a "Muter" role, MUTE_MEMBERS only):

| Case                                    | Offered in the client                        | Server answer                                     |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| Warning-only moderator, report held     | Issue warning, Time out; Lift while running  | act 204 / 200 `voice: skipped`; untimeout 204     |
| Report not held                         | nothing                                      | —                                                 |
| Ordinary member                         | no Moderation Center                         | warn 403                                          |
| Mute-only role                          | no Moderation Center                         | warn 403, act 403                                 |
| Self                                    | never listed (reports about you are hidden)  | warn 400                                          |
| Peer (same role)                        | offered                                      | warn 403                                          |
| Superior (Moderator above Warden)       | offered; shows the refusal, report stays     | act 403, ledger unchanged                         |
| Owner target                            | offered                                      | warn 403, act 403, ledger empty                   |
| Demoted during submission (frames held) | offered by the stale view; then view cleared | act 403; re-read 403; act and untimeout 403 after |
| Combined (with MUTE_MEMBERS), in voice  | mocked only: "also server-muted"             | needs a live LiveKit session; not run locally     |

The warning and timeout rows in dave's ledger carry `report_id` equal to the
report's public id and the typed reason; the timeout's `expires_at` is five
minutes out, and lifting sets `lifted_at`. The history reads "You issued:
Warning" and the timeout's "Until …".

**Accessibility** (mocked Playwright, `b9-moderation-actions.spec.ts`):
keyboard order warning reason → Issue warning → timeout reason → length →
unit → Time out → Lift timeout, each operable with Enter/Space and every
outcome announced in the `role="status"` line only after the answer; the
length error is `role="alert"`, referenced by `aria-describedby`, with
`aria-invalid` and focus on the field; no unnamed control; every target at
least 24×24 px; no animation or transition; text, control, error and focus
contrast at the Q1 thresholds in dark, neon-glow, midnight and light, each
with and without High Contrast (per-theme ratios attached as
`b9-13-contrast-*.json`); at 940×500 with 20 px Large Font nothing scrolls
sideways and every control and line scrolls into view (screenshot attached).
Custom-accent fallback is inherited unchanged from B9-2 (no new colour).
**Owner-run pending:** NVDA (Windows) and Orca (Linux) recordings, and the
200 % OS-zoom check.
