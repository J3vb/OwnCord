# Plan: B9-16 — Submit and track a local appeal

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-16-impl` from `dev` `287a4905a88dbbee7024a365073f11fedf4439fc` (after B9-15 #1757); drift, decisions and evidence are in [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-16 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-16-personal-appeals`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 5, 8. **Requirements:** BPR-073, BPR-091, BPR-092.
> **Dependencies:** B9-15. Q6 prerequisite: the separate B5 contract-completion PR adding `GET /api/v1/users/me/moderation` (decided 2026-09-23; not yet implemented). All product work also requires the PRD entry gate.
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

### Drift at the implementation base (2026-09-23)

Re-read at `287a4905` (`dev`, after B9-15 #1757):

1. Row 1 holds (`Server/api/appeal_handler.go:15-29`, routes at `:69-75`).
   `POST /api/v1/appeals/` is mounted with a trailing slash; the client
   calls it that way, as the server's own tests do.
2. Row 2 holds; the lines moved to `Server/service/appeal.go:165-199`
   (`appealRateLimit`, `appealableKinds`) and `Submit` at `:206`. The server
   refuses any control character in the body (`hasControlChar`), line
   breaks included.
3. Row 3 holds. `decision_note` is set only once decided (upheld or
   overturned); `action_kind`/`action_reason`/`action_created_at` are `""`
   once the appealed action is erased.
4. Row 4 holds, and the Q6 prerequisite is met: `GET /api/v1/users/me/moderation`
   (#1730, `handleOwnModeration`) returns each row's ledger `id`,
   `appealable` and `appeal {id, state}`; B9-15 added
   `api.getOwnModeration` and the Safety tab that lists it.
5. New: `appeal_status` had no client payload type or dispatcher
   registration; B9-15 left the Safety tab's seam taking only a signal
   (`destinations.ts`), so it has no API client of its own.

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

The Q6 `GET /api/v1/users/me/moderation` contract (a separate B5 contract-completion PR) must provide restart-safe authorized action ids before full closure. Never ask a user to guess an integer or grant moderator read authority to populate the form.

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

Live-only action ids make appeals disappear after restart. Q6 is a blocking contract dependency, not an optional UX enhancement.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q6 — Restart-safe recipient sanctions and appeal eligibility

**Decided 2026-09-23 by the owner:** option (a), as a separate B5 contract-completion PR. Add `GET /api/v1/users/me/moderation` (session auth) returning the caller's own ledger rows of kind warning, timeout, removal, and ban where the ban has lapsed or been reversed, newest first, bounded by the existing retention sweep. Each row: `id` (the ledger id appeals use), `kind`, `reason`, `created_at`, `expires_at`, `lifted_at`, `acknowledged_at`, `appealable` (computed by the same rules `Submit` applies: kind eligible, not already appealed), and `appeal` (`{id, state}` or null). Excluded by construction: actor, reporter, report link, evidence, internal notes. Keep `ready.notices` as the fast path for unacknowledged warnings. Currently banned users remain out of band under B5 policy. B9-15/16 stay blocked for complete closure until this contract is accepted.

**Options and consequences:** Add a member-safe own-action/restriction read with ids, reasons, expiry and eligibility; or use only existing live frames and ready warnings. The read needs a narrowly scoped server contract PR; live-only UX cannot recover removal/timeout action ids and all eligible history after restart and leaves BPR-072/073 incomplete. Currently banned users remain out-of-band under the existing B5 policy in either case.

**Drafting recommendation (historical):** Approve a separate B5 contract-completion PR for own-action/restriction discovery, with a DTO excluding reporter/evidence/internal notes. B9-15/16 remain blocked for complete closure until its exact contract is accepted.

## Implementation record (2026-09-23)

### What shipped

- **Appeals section** (`features/safety/Appeals.ts`, rendered by
  `SafetyTab.ts` below the history): the routing disclosure ("goes only to
  this server's moderators", one appeal per action, 3 in 24 hours) and the
  unavailable paths (kick has no appeal; a currently banned account cannot
  sign in, so contact the operator; a ban that has ended appears in the
  history and can be appealed). No contact data is invented.
- **Real action source (Task 1):** a history row offers **Appeal** only when
  the server marks it `appealable`, and its ledger `id` is the `action_id`
  sent. No id is ever typed or read from a moderator route.
- **Submission (Task 2):** one panel, outside both lists, holds the form: the
  sanction (kind, date, reason), an optional body (`maxlength` 4000; line
  breaks and tabs are sent as spaces because the server refuses control
  characters) and Send/Cancel. Pending is `aria-busy`/`aria-disabled` and a
  second press sends nothing. Refusals are named: `ALREADY_APPEALED`,
  `RATE_LIMITED`, 404/403 (gone), 400 (the server's reason, focus back on the
  text with `aria-invalid`), anything else "wasn't sent". The draft stays and
  nothing resends by itself; 404/409 re-read the authoritative state.
- **Withdrawal:** open and assigned appeals offer **Withdraw appeal**, which
  opens a confirmation in the same panel ("You can't appeal this action
  again") before `POST /appeals/{id}/withdraw`; 409 (decided or already
  withdrawn) says it can no longer be withdrawn, 404 that it no longer
  exists. For an erased action the panel shows "the action no longer
  exists" in place of a reason.
- **Status (Task 3):** the safety store keeps `appeals` from
  `GET /appeals/mine`, read with the history on `ready`, a resumed
  connection, opening the tab, a retry and after each change; a failure has
  its own message and retry. A live `appeal_status` (registered in
  `lib/dispatcher.ts`, handler in `features/safety/wsHandlers.ts`) patches
  the appeal and its history row at once, then re-reads (an overturn lifts
  a timeout or acknowledges a warning). Each row shows the state, filed and
  decided dates, the moderator's note only when the server returns one, "a
  removal overturned doesn't restore the removed message", and "the action
  no longer exists" for an erased action. Never the assignee or the decider.
- **Focus:** a store update that re-renders a list keeps focus on the same
  control (`data-focus-key`), or the list's heading when that control left.
  Cancel returns to the opener; a sent or withdrawn result focuses the
  Appeals heading and is announced through a persistent `role="status"`.
  Errors use a persistent `role="alert"` linked by `aria-describedby`
  (`docs/architecture/b9-ui-contract.md`, Announcements).

### Implementation decisions and file-table amendments

- `lib/api.ts` gained `fileAppeal`, `getMyAppeals`, `withdrawAppeal` and the
  `MyAppeal`/`AppealState` types (as B9-15 did, no `features/safety/api.ts`:
  `ApiClient` exposes no generic request). `lib/types.ts` gained
  `AppealStatusPayload`; `features/connection/dispatchContext.ts` and
  `lib/dispatcher.ts` add `getMyAppeals` to the dispatch API.
- The Safety seam takes only a signal, so `Notices.ts` (mounted once per
  `MainPage` with the page's client) hands that client to the tab. No
  navigation, MainPage or `destinations.ts` change.
- The appeals strings are their own catalog, `i18n/appeals.ts`, loaded with
  the tab: `i18n/safety.ts` is on the startup path (the dispatcher's
  handlers), and putting them there cost ~650 B of the startup budget. The
  one exception is `appeals.unavailable`, the operator-contact guidance: it
  lives in `i18n/safety.ts` because the BANNED refusal
  (`connection/wsHandlers.ts`) also appends it to the server's message, a
  banned user never reaching the Safety tab.
- Outside the file table, each minimal: `styles/app/overlays.css` (rules
  beside the B9-15 safety rules; no import-order change),
  `features/safety/safety.test.ts` (the banner's API mock gains the two
  appeal methods), and `tests/e2e/b9-personal-appeals.spec.ts` (mocked, the
  Q1 accessibility evidence, as B9-15's).
- An admin unban does not set the ban row's `lifted_at`, so the history
  shows such a ban without "Lifted" (B9-15 rendering, unchanged here); it
  is still listed and appealable.

### Evidence

At `2f59d93ad21bfd00ae34e1982d2f891e3ad86aa0` (`fm/b9-16-impl`), the tested
client code: every command below ran on that content. The review fixes that
followed (neutral withdraw-409 text, the appeal byte limit, the BANNED
refusal's operator-contact guidance) are covered by the PR's CI at its final
head.

| Check           | Command                                                                                                                                                                          | Result                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Types           | `npm run typecheck`; `npm run typecheck:build`; `npm run typecheck:e2e`                                                                                                          | clean                                                                                          |
| Lint            | `npm run lint` (oxlint, cycles, eslint)                                                                                                                                          | clean                                                                                          |
| Unit            | `npx vitest run --maxWorkers=4`                                                                                                                                                  | all pass, incl. `src/features/safety/appeals.test.ts` (19) and `safety.test.ts` (25)           |
| Failing control | guards removed one at a time (pending, focus keep, body normalisation, stale read, withdrawable states, note, eligibility, draft reset, live patch, pending reset after success) | each fails at least one test, all restored                                                     |
| Budgets         | `npm run build:budget && npm run check:budgets`                                                                                                                                  | startup 90,265 B / 91,000 (base 90,294); MainPage 59,988 B / 60,000 (base 59,968); none raised |
| Docs/hygiene    | `npm run check:docs`; `npm run check:hygiene`                                                                                                                                    | pass                                                                                           |
| Mocked e2e      | `npx playwright test tests/e2e/b9-personal-appeals.spec.ts tests/e2e/b9-moderation-notices.spec.ts tests/e2e/b9-navigation.spec.ts`                                              | 14 pass                                                                                        |
| Fullstack       | `npm run test:e2e:fullstack -- tests/e2e/fullstack/b9-personal-appeals.spec.ts` (and B9-15's spec)                                                                               | 3 pass, twice; B9-15's 3 pass                                                                  |

The fullstack spec proves against the real server: a failed send keeps the
draft and sends once; the line break arrives as a space; one appeal per
action (including after a withdrawal); the fourth submission in 24 hours is
refused as `RATE_LIMITED`; assignment arrives live; a missed decision frame
is recovered by a reconnect, with the note and the overturned warning's
notice gone; a ban that has ended can be appealed after signing back in; and
bob's client calls no `/api/v1/moderation/` route.

### Accessibility (Q1)

Automated, in `tests/e2e/b9-personal-appeals.spec.ts`:

- **Names/roles:** `findUnnamedControls` is empty for the tab and the panel;
  each Appeal and Withdraw names its action ("Appeal Timeout, Sep 21, 2026, …",
  "Withdraw appeal (Message removed, …)"); the panel is a `group` labelled by
  its title.
- **Keyboard/focus:** Appeal, Send, Cancel, Withdraw, Keep by Enter/Space and
  Tab/Shift+Tab; the Q1 ring (`focusIndicator`) on Appeal, the text, Send and
  Cancel in every theme; focus stays on Send through pending and a refusal,
  Cancel returns to Appeal, a result focuses the Appeals heading.
- **Announcements:** refusals through the panel's `role="alert"`; "Appeal
  sent." and "Appeal withdrawn." through a persistent `role="status"`.
- **Contrast:** row text, Withdraw, title, reason, label, hint, Send and
  Cancel ≥ 4.5:1 in dark, midnight, neon-glow, light, High Contrast and a
  light custom accent (`#fee75c`, which falls back under Q8); the error ≥
  4.5:1. The matrix is attached to the run as `b9-16-contrast.txt`.
- **Reduced motion / reflow:** no animation or transition on the panel; at
  940×500 with 20px Large Font the tab has no horizontal overflow and the
  text, Send, Cancel and Withdraw scroll into view when focused.

**Owner-run, pending:** NVDA (Windows) and Orca (Linux) recordings of the
journey: the Appeal names, the form and its alert, "Appeal sent.", a live
status change, and the withdraw confirmation.
