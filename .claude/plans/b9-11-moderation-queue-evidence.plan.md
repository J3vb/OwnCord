# Plan: B9-11 — Show the permission-gated moderation queue and authorized evidence

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-11-impl` from `dev` `64a41b3a1e6a0972059ec156a3f76f692fcccb99`; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

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

## Implementation record (2026-09-23)

### Drift at the implementation base

Re-read at `64a41b3a` (B9-7 #1755 and B9-10 #1754 merged). Every inventory row
still holds in substance; the line ranges moved:

- Rows 1–2: #1735 (`714b55a0`) added `evidence_withheld` to the detail DTO, so
  the DTOs are now `Server/api/moderation_queue_handler.go:17-107` and the
  routes, the authorization-before-id-resolution helper and the list/detail
  handlers `:120-275`.
- Row 3: `guardConfidentiality` and `GuardSelfReviewFor` are now
  `Server/service/report.go:432-468`, `Get` `:529-568`; `Queue` (`:492-515`)
  also drops reports about the caller.
- Row 4 / Task 1, the hard dependency, is **met**: the B5 evidence-consent
  follow-up merged as #1735 and the owner accepted it on 2026-09-23 (PRD
  entry-gate table, "B5 consent acceptance"). The contract this milestone
  uses: `evidence_withheld` is `NSFW_ACKNOWLEDGEMENT_REQUIRED` (acknowledge
  `channel_id` first) or `SOURCE_CHANNEL_UNAVAILABLE`, with `evidence` empty,
  re-evaluated on every read (`Server/service/report_evidence.go`); tests
  `Server/api/moderation_evidence_consent_test.go`
  (`TestModerationEvidence_AcknowledgeAndRevoke`, `_ConsentIsPerModerator`,
  `_AdministratorHasNoBypass`, `_SourceChannelRelabelling`,
  `_SourceChannelDeletion`, `_UnlabelledSourceNeedsNoAcknowledgement`).
- The B5 plan's exit-gate text cited as row 4 moved with #1748's
  reconciliation; the condition is the "Conditions 3 and 4" row of its
  [exit gate](../../docs/plans/b5-community-content-moderation-2026-09-04.md#exit-gate).

No server, protocol or schema change was needed: `GET /api/v1/moderation/queue`
(with `?state=open|assigned|closed`), `GET .../queue/{id}` and the `mod_queue`
frame all exist on `dev`.

### What shipped

- **Entry and view (Q2).** `destinations.ts` registers `moderation`, so B9-4's
  "Moderation" button beside Audit Log appears for `MODERATE_MEMBERS` holders
  and opens the content view; close and Escape take the `channelBeforeDm`
  path. There is no badge; the count is inside the view.
- **Queue.** Loads only once the view opens (the navigator builds it only
  with the permission). A "Show" filter over the server's own states (open
  and in review — the default —, waiting, in review, closed) and the
  server's result count ("2 reports open or in review"). Each row is one
  button: target and reason, subject and reporter, status, date. No
  pagination is assumed: the route has none.
- **Detail.** A separate read per selected report, with its facts (about,
  reported by, status, assignee, sent, closed), the reporter's details and
  the evidence snapshot. Notes, events and actions are B9-12's; the adapter
  drops them so they are not even kept in memory.
- **Evidence.** Only the returned snapshot, ordered around the reported
  message, as text: no link, embed, image, emoji or mention is rendered and
  nothing is fetched, so external media is suppressed by construction.
  Attachments show name, type and size "kept by reference only … may have been
  deleted"; the upload id is dropped in the adapter, so nothing can fetch or
  offer to restore the file.
- **Consent.** `NSFW_ACKNOWLEDGEMENT_REQUIRED` shows B9-7's own gate
  (`components/NsfwGate`, lazy) in place of the evidence. Continue records
  the acknowledgement with the server (`PUT .../nsfw-acknowledgement`) and
  only then re-reads the report; Go back closes the report. Returned evidence
  is still withheld when this client holds no consent for its channel (a
  revoke raced the read), and withdrawing consent anywhere (`nsfw_ack`)
  removes shown evidence at once. The client only ever narrows the server's
  answer.
- **Authority and lifetime.** A 403 on any read clears every report on
  screen and says the permission is gone; a 404 says the report is no longer
  available and re-reads the queue, without probing. Every request is bound to
  the view's signal and to the filter or selection it was made for, so a late
  answer is dropped. `mod_queue` (now registered in `dispatcher.ts`, report
  frames only) and a reconnect re-read the queue and the open report; the
  frame carries no data and the feature store is a counter. A selected report
  that leaves the list closes with a message and focus stays in the view.
  Role loss, sign-out and profile switch go through B9-4's navigator, which
  aborts the view: the DOM is emptied and the state dropped.

### Implementation decisions and file-table amendments

- **The view builder gets the API client.** B9-4's `FeatureViewContext` had
  only `signal` and `close`, so it gains `api`; `contentView.ts` passes the
  one it is given and `MainPage.ts` hands it over in the navigator's options
  (one line). The tests that build a navigator pass a stub.
- **Files beyond the table**, each a narrow part of the wiring:
  `features/moderation/{view,wsHandlers}.ts` (the lazy destination shim, as
  B9-5's `message-requests/view.ts`; the handler body the dispatcher door
  requires), `i18n/moderation.ts` (catalog), `features/reports/myReports.ts`
  (exports its target and reason labels for reuse),
  `styles/app/chat-area.css` (the feature-view fragment that owns B9-4/B9-5's
  view rules; tokens only, no import change),
  `tests/e2e/b9-moderation-queue.spec.ts` (the Q1 checks, mocked),
  `tests/e2e/b9-navigation.spec.ts` (its "no Moderation entry yet" check now
  expects the real entry), and the navigator stubs in `navigation.test.ts`
  and `tests/unit/sidebar-area.test.ts`. Unit tests are
  `features/moderation/{queue,evidence}.test.ts`.
- **Budget.** The queue, the evidence renderer and the catalog load on first
  open. Measured at the base: startup 93,952 B, MainPage 63,300 B; with this
  change 94,576 B of 95,000 B and 63,437 B of 64,000 B, no budget change;
  after merging `dev` `6b3af8d4` (B9-6 #1770, B9-21 #1773), 94,788 B and
  63,627 B. The unit suite (304 files, 6,614 passed), both Playwright specs and
  the fullstack spec were re-run green on the merge. The
  startup growth is the view CSS, the two API methods and the `mod_queue`
  handler. Importing `formatFileSize` from `message-list/attachments` made
  Rolldown split four shared modules out of the entry (+700 B), so the size
  uses `lib/connectionStats`'s `formatByteSize` with the same arguments.
  After merging `dev` `6671f228` (B9-8 #1771, 2026-09-24) the startup closure
  measured 95,204 B, over the 95,000 B budget; MainPage 63,805 B. The view
  CSS costs 486 B gzip and cannot load with the lazy chunk (`vite.config.ts`
  sets `cssCodeSplit: false`), and a compacted rewrite saved only 74 B, so
  Firstmate raised the shared startup budget to 95,500 B (decision
  2026-09-24, re-baseline at B9-26); MainPage stays 64,000 B.
- **Review fixes.** The validation review found three focus and race gaps in
  `Queue.ts`, fixed with a test each in `queue.test.ts`: a failed background
  re-read of the open report no longer drops focus to `<body>`; a queue
  refresh that replaces a pending read keeps the open's focus intent; and
  accepting the NSFW gate reloads only if the accepted report is still the
  selected one.

### Evidence

Base `64a41b3a`; Node 26.9.0, vitest 4.1.11, Playwright Chromium, Go 1.26.7,
Linux.

| Check                                                                                            | Result                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `npx vitest run --maxWorkers=4` (whole client)                                                   | 302 files, 6,572 passed, 152 expected-fail  |
| `src/features/moderation/queue.test.ts`, `evidence.test.ts`                                      | 26 passed                                   |
| `npm run typecheck`, `typecheck:build`, `typecheck:e2e`, `npm run lint` (oxlint, cycles, eslint) | clean                                       |
| `npm run build:budget && npm run check:budgets`                                                  | all ok; startup 94,576 B, MainPage 63,437 B |
| Playwright (dev server): `b9-moderation-queue`, `b9-navigation`                                  | 12 and 3 passed                             |
| Playwright fullstack (real Go server): `fullstack/b9-moderation-queue`                           | 2 passed                                    |
| `npx prettier --check .`, `npm run check:docs`                                                   | clean (tracked files), passed               |

The real-server journey uses synthetic accounts: alice (owner, and the
subject), carol (reporter, through the server's route) and bob (moderator in
the client, then demoted). It proves: the entry and view from the keyboard;
the view's count equals the server's queue; a report's snapshot shows as text
with its attachment by reference and no `img`/`a`; Escape closes the report
onto its row, then the view; evidence from a channel labelled after filing is
withheld behind B9-7's gate until bob's own acknowledgement, which is sent
before the re-read; revoking consent from another device removes the shown
evidence; a new report reaches the open view through `mod_queue`; nothing
scrolls sideways at 940×500; bob's traffic holds no file, attachment or
labelled-channel history read and no moderation route but the queue and
report reads (plus B9-15's own-history read); demoting bob closes the view,
hides the entry, empties the view's DOM and the server answers 403. The second
test shows alice's queue, the server's and the view's, excludes the report
about her, and a member has no entry and a 403.

**Failing controls.** Each guard was removed in turn and the suite re-run;
each failed and was restored: the local consent narrowing in the adapter
(`evidence.test.ts`), 403 handling as a refusal (two `queue.test.ts` authority
tests), the consent-revoke subscription and the late-detail drop
(`queue.test.ts`). The 24×24 target check failed on the unstyled 18 px filter
before it took the shared `form-input` class.

### Accessibility (Q1)

- **Keyboard:** the filter is a native `select` with a label; each report is
  a native button; Tab and Shift+Tab move filter → rows in reading order;
  Enter opens a report, Escape closes it onto its row, a second Escape
  closes the view onto the channel with focus back on the entry
  (`b9-moderation-queue.spec.ts`, keyboard test). No hover-only action.
- **Screen reader:** the view is a region named "Moderation"; each row's
  accessible name is its full sentence (target, reason, people, status,
  date); the selected row has `aria-current`; the count and loading are
  `role="status"`, refusals and failures `role="alert"`, both present before
  their text changes; the report is a section named by its heading, facts a
  description list. Every focusable control has a name
  (`findUnnamedControls`). A refusal, closed view or withdrawn consent
  removes the private text from the tree. **NVDA and Orca recordings are
  owner-run and pending.**
- **Focus:** the view heading on open; the report heading once a report
  loads (only if the reader is still on its row); its row on Escape or Go
  back; the first row or the filter when an open report disappears; the view
  heading after a refusal. The ring passes Q1 on the rows and the filter in
  every theme.
- **Contrast:** measured in dark, neon-glow, midnight and light, each with
  and without High Contrast: intro, filter label, count, selected and plain
  row text, state, date, report title, facts, headings, reporter detail,
  evidence author, text, marker and attachment, all ≥ 4.5:1; focus ≥ 3:1
  (JSON attached per theme). The selected row and the reported message carry
  a border as well as a colour.
- **Motion:** the view has no animation or transition
  (`animation-name: none`, `transition-duration: 0s` on rows, report and
  evidence), so OS and in-app reduced motion have nothing to stop.
- **Zoom/reflow:** at 940×500 with 20 px Large Font every control and
  evidence line scrolls into view and neither the view nor the queue scrolls
  sideways (screenshot attached); long unbroken text wraps. The OS 200 %
  zoom check is owner-run and pending with the native recordings.
