# Plan: B9-10 — Report local messages, users and attachments and show own report status

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-10-impl` from `dev` `166d71e44ce5dfde6455e3f108ce88a8def9c88f`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

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

### Drift at the implementation base (2026-09-23)

Re-read at `166d71e44ce5dfde6455e3f108ce88a8def9c88f` (B9-4 merged). Rows 1–3
hold at the cited lines: `git log 0beee8e4..166d71e4` touches
`Server/api/report_handler.go` not at all, and `Server/service/report.go` only
through `714b55a0` (the moderator detail withholds evidence without NSFW
consent), which leaves intake, `Mine` and the reason set unchanged. B9-4 and
B9-3 are merged; Q2 and the B5 report contracts are as the PRD records them.
No server, schema or protocol change is needed.

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

Borrowing a moderator detail response for My reports overexposes fields. Use separate typed DTOs and caches.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record (2026-09-23)

### What shipped

- **Entry points.** A Report button (flag icon, "Report message") on someone
  else's message in the hover/focus action bar; never on your own or a system
  row. The profile popup gains a Report button for anyone but you. The report
  goes to the dialog with the actual local identifier: the message id, an
  attachment's upload id, or the user id.
- **Attachments.** No attachment menu exists, so a message that carries
  attachments gets a "What are you reporting?" choice in its form: the message
  (preselected) or each attachment by filename. A per-attachment button was
  the other option; it would put a new control on every file and image.
- **The form** (`features/reports/reportDialog.ts`, on `createModal`). The five
  B5 reason codes as English radio buttons, optional detail, a note that the
  report goes only to this server's moderators. Line breaks and tabs in the
  detail become spaces, because the server refuses every control character;
  other control characters and over-2,000-code-point text are field errors.
  Pending marks Send `aria-busy`/`aria-disabled` and announces "Sending
  report…". Refusals are catalog text keyed on the server's code (duplicate,
  rate limit, deleted or not visible, invalid, anything else), never the
  server's message. Cancel, Escape, the backdrop, a channel switch and sign-out
  close the form and abort a pending send; a late result is dropped. Success
  closes it, returns focus to the opener and shows a toast pointing at
  Settings, Safety. No screenshot, no guessed metadata, no other destination.
- **My reports** (`features/reports/myReports.ts`) is the Settings Safety tab's
  first section (Q2): kind, reason, where it stands (state and outcome as one
  English phrase) and when, from `GET /reports/mine` only, with loading, empty,
  error/Retry and late-result handling. If the section's chunk fails to load,
  the pane shows a `role="alert"` message instead of staying blank. An unknown
  state or a missing date shows as unavailable; nothing reads the moderation
  queue.
- **Typed DTOs.** `api.ts` gains `fileReport`, `getMyReports`,
  `FileReportRequest` and `OwnReportSummary`, apart from any moderator shape.

### Implementation decisions and file-table amendments

- **The Safety builder takes the API client.** B9-4's `safety.build(signal)`
  had no way to reach the server, so it is now `build(signal, api)`, and
  `MainPage.ts` passes its `api` in the one line that hands the builder to the
  Settings overlay. That is this milestone's only single-writer edit besides
  `api.ts`; `destinations.ts` registers `safety`.
- **One Safety tab with B9-15.** B9-15 (#1757) merged its own Safety tab
  first. Merging `dev` in, `features/reports/safetyPane.ts` builds B9-15's
  pane (`buildSafetyTab`, whose body now renders into a slot of its own so it
  stays first) and appends My reports after it; B9-16 adds appeals to the
  same pane.
- **Budget.** The form, the openers and My reports load on first use
  (`import()`), and the two entry labels and the Safety tab's load error live
  in their own small catalog (`i18n/reportEntry.ts`), so MainPage stays inside
  its 60,000 B budget. After B9-15 merged, `dev` alone measured 59,968 B, so
  the profile popup (only ever needed after a click, and imported only by
  `MemberList`) now loads on first open too, and the member report's focus
  fallback moved into the lazy openers. Merged, MainPage is 59,997 B: the
  budget holds, with 3 B left for the next lane. Merging `dev` again after
  B9-5 (#1761) applied Firstmate's shared B9 lane budgets of 2026-09-23, a
  design call under the owner's standing delegation
  (MainPage 64,000 B, startup 93,000 B; re-baselined at B9-26): merged,
  MainPage is 60,133 B and the startup closure 91,282 B; after Refined Neon
  (#1764), 60,176 B and 91,816 B, with the report CSS on the new spacing and
  type-scale tokens.
- **Keyboard reach for users.** Member rows were click-only, so the profile,
  and its Report button, could not be reached from the keyboard. A row is now a
  named `role="button"` with `tabindex="0"` that opens the profile on Enter or
  Space; `aria-describedby` points at its presence and custom status, which the
  button role would otherwise hide. Q1 requires it for this journey.
- **The dialog's close button** was 22 px wide (the shared `.modal-close`);
  `.report-dialog .modal-close` gives it Q1's 24×24 minimum without touching
  other modals.
- **Files beyond the table**, each a narrow part of the entry wiring:
  `components/MessageList.ts` (the optional `onReportClick`),
  `pages/main-page/ChannelController.ts` (wires it),
  `components/MemberList.ts` and `pages/main-page/SidebarMemberSection.ts`
  (the profile's Report and the keyboard row), `lib/icons.ts` (`flag`),
  `features/navigation/destinations.ts` and `pages/MainPage.ts` (above),
  `i18n/reports.ts` and `i18n/reportEntry.ts` (catalogs),
  `styles/app/overlays.css` and `settings.css` (rules in their owning
  fragments; no import-order change), `tests/e2e/b9-reports.spec.ts` (the Q1
  checks, mocked), and the unit and e2e tests that cover the touched
  components (`renderers`, `member-list`, `user-profile-popup`,
  `b9-navigation`, whose Safety-tab absence check now expects the tab).

### Evidence

Base `166d71e4`; Node 26.9.0, vitest 4.1.11, Playwright Chromium headless
shell 151, Go 1.26.7, Linux. The counts and sizes below predate the review
round's fixes (member-row description, user-report fallback focus, Safety load
error), whose tests are in `member-list`, `sidebar-member-section` and
`myReports`.

| Check                                                                                                                                                                                                                                                     | Result                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --maxWorkers=4` (whole client)                                                                                                                                                                                                            | 293 files, 6,418 passed, 149 expected-fail                                                                              |
| `src/features/reports/intake.test.ts`, `myReports.test.ts`                                                                                                                                                                                                | 31 passed                                                                                                               |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint)                                                                                                                                                          | clean                                                                                                                   |
| `npm run build:budget && npm run check:budgets`                                                                                                                                                                                                           | all ok; MainPage 59,639 B of 60,000 B (58,491 B at base); after merging `dev` with B9-15, 59,997 B (dev alone 59,968 B) |
| Playwright (dev server): `b9-reports`                                                                                                                                                                                                                     | 12 passed                                                                                                               |
| Playwright (dev server): `b9-navigation`, `message-actions`, `member-list`, `user-profile`, `settings-overlay`, `settings-tabs-extra`, `a11y-smoke`, `b9-text-expansion`, `sidebar-menus`, `main-layout`, `message-list`, `logout-flow`, `profile-switch` | 95 passed                                                                                                               |
| Playwright fullstack (real Go server): `fullstack/b9-reports`                                                                                                                                                                                             | 2 passed                                                                                                                |

The real-server journey uses four synthetic accounts: alice is the subject
(her message, her attachment, her account), bob the reporter in the client,
carol a bystander member and dave a moderator. It proves cancel sends nothing;
success for a message, an attachment and a user, each returning focus; the
server's duplicate, removed-target and rate-limit refusals, each explained;
the summary route's fields are exactly `id, target_type, reason, state,
outcome, created_at, closed_at`; the moderator's queue holds the three actual
targets; the subject's own queue excludes them; the bystander has no reports
and a 403 on the queue. The client's report traffic at the transport
boundary, which refuses any origin but the test server, is four
`POST /api/v1/reports` and one `GET /api/v1/reports/mine`; the only
`/moderation` read is B9-15's `GET /api/v1/users/me/moderation` (the caller's
own history), and nothing reads the moderation queue.

**Failing controls.** Each guard below was removed in turn and its suite
re-run; every one failed and was restored before commit: the late-send drop,
close aborting a pending send, the pending re-entry guard, line-break
normalising, the duplicate explanation, the attachment's upload id
(`intake.test.ts`); the late-summary drop, the unknown-state fallback, the
closed-pane guard (`myReports.test.ts`); Report hidden on your own message
(`renderers.test.ts`); the keyboard row and no Report on yourself
(`member-list.test.ts`); the popup closing before the report opens
(`user-profile-popup.test.ts`). In the real-server spec, sending the message
id as the attachment target fails the journey on the server's refusal. In
`b9-reports.spec.ts`, the close button's 22 px width and an attachment label
the accessible-name check misread both failed before their fixes.

### Accessibility (Q1)

- **Keyboard:** every action is a native button, radio or textarea. The
  message's Report button is reachable through the action bar's
  `:focus-within`; the member row opens the profile on Enter or Space.
  Arrows move within each radio group, Enter submits, Escape closes, and Tab
  cycles inside the dialog (`b9-reports.spec.ts`, keyboard test).
- **Screen reader:** the dialog is named by its heading; the radio groups are
  fieldsets with legends; errors are `role="alert"` linked by
  `aria-describedby` with `aria-invalid`; pending and the empty list are
  `role="status"`; My reports is a region named "My reports". Every focusable
  control has a name (`findUnnamedControls`). No detail text, evidence or
  other person's data is in the summary's tree. **NVDA and Orca recordings
  are owner-run and pending.**
- **Focus:** focus moves to the first radio on open, to the field at fault on
  error, stays on Send while pending and after a refusal, and returns to the
  opener on cancel and success (the composer if the row was re-rendered; the
  member row for a user report, found again by its `data-testid` if the list
  re-rendered). After Retry succeeds in My reports, focus
  moves to its heading. Every focus ring measured ≥ 5.03:1 at ≥ 2 px.
- **Contrast:** measured on the rendered dialog and My reports in dark,
  neon-glow, midnight and light, each with and without High Contrast; the
  lowest text ratio is 5.09:1 (midnight, dates) and the lowest focus ratio
  5.03:1 (dark, radio). Only B9-2 qualified tokens are used (`--text-normal`,
  `--text-muted`, `--header-primary`, `--text-danger`, `--text-positive`,
  `--accent-text` for the radio mark, `--focus-ring`), so the preset and
  custom-accent (Q8) matrix in `b9-primitives.spec.ts` covers the accents.
  States are words, never colour alone.
- **Reduced motion:** the dialog's entry animation is 0 s under the OS
  setting and under the in-app toggle, and 0.3 s with neither (the control);
  nothing depends on it.
- **Zoom/reflow:** at 940×500 with 20 px Large Font, every dialog control
  scrolls into view and neither the dialog nor My reports scrolls sideways
  (screenshots attached to the run). OS zoom 200 % is owner-run with the
  native recordings.

BPR-070's evidence row and status are not changed here: its B9 half closes at
B9-26's joined journey with the owner's native recordings.
