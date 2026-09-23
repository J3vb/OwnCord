# Plan: B9-15 — Show authorized warnings, restrictions and action status to recipients

**Status:** IMPLEMENTED — native AT recordings pending owner — 2026-09-23 on branch `fm/b9-15-impl` from `dev` `166d71e44ce5dfde6455e3f108ce88a8def9c88f`; drift, decisions and evidence are in [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-15 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-15-moderation-notices`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 5, 8. **Requirements:** BPR-072, BPR-073, BPR-091, BPR-092.
> **Dependencies:** B9-4, B9-3. Q6 prerequisite for complete closure: the separate B5 contract-completion PR adding `GET /api/v1/users/me/moderation` (decided 2026-09-23; not yet implemented). All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Show authorized warnings, restrictions and action status to recipients. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Receive and acknowledge a warning, observe a timeout, reconnect after missing a live update and review a removal/kick/ban explanation.

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

| #   | Verified current state                                                                                             | Evidence at planning commit                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | ready includes unacknowledged warnings with id/kind/reason/time but no actor or report link.                       | `Server/ws/serve_ready.go:416-440`; `Server/ws/serve_ready.go:445-465`         |
| 2   | The live mod_action frame is targeted and unsequenced; missed timeout frames are enforced on the next send.        | `Server/ws/moderation_actions.go:9-36`                                         |
| 3   | Warning acknowledgement is caller-owned. The existing general actions list is moderator-only.                      | `Server/service/moderation.go:880-890`; `Server/service/moderation.go:905-920` |
| 4   | Client connection/session-replacement state already has a shared owner; avoid a second disconnected-state machine. | `Client/src/stores/ui.store.ts:8-24`                                           |

### Drift at the implementation base (2026-09-23)

Re-read at `166d71e4` (`dev`, after B9-4 #1750):

1. Row 1 holds; `readyNotices` moved to `Server/ws/serve_ready.go:476-490`.
2. Row 2 holds. A lift is `id: 0, kind: "timeout", expires_at: null`, and
   the maintenance sweep sends the same frame at natural expiry. Neither an
   issued nor a lifted timeout re-sends `can_send`; only `ready` carries it.
3. Row 3 holds, and the Q6 read is merged (#1730):
   `GET /api/v1/users/me/moderation` (`Server/api/moderation_handler.go`
   `handleOwnModeration`) with `api.getOwnModeration` already in
   `Client/src/lib/api.ts`. The prerequisite is met.
4. Row 4 holds; B9-4 added `activeView`, `settingsTab` and the Safety
   destination slot (`features/navigation/destinations.ts`).
5. New: a resumed connection (`auth_ok.replay_source` `buffer`/`db`) gets no
   `ready`, and `mod_action` is never replayed, so `ready.notices` alone
   cannot recover a warning missed during a short disconnect.
6. New: ledger `created_at`/`lifted_at` are SQLite `datetime('now')` text
   (`2026-09-23 12:56:05`, UTC, no zone), while the frames carry RFC 3339.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

ready.notices, mod_action, POST /api/v1/users/me/notices/{id}/ack; current channel can_send. Recipient-safe history/expiry needs the Q6 `GET /api/v1/users/me/moderation` contract; never use moderator ListActionsForTarget as a member.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Client/src/features/safety/{Notices,store,wsHandlers,api}.ts (new)`                   | Recipient-only state and notice UI                 |
| `Client/src/lib/{types,dispatcher}.ts; Client/src/pages/MainPage.ts`                   | Serialized ready/live composition                  |
| `Client/tests/e2e/fullstack/b9-moderation-notices.spec.ts (new)`                       | Recipient privacy and reconnect evidence           |
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

### Task 1: Consume notices and live actions

Add typed ready.notices and mod_action handlers through the dispatcher. Dedupe live and ready warnings by action id; model acknowledgement pending/failure without losing the notice.

### Task 2: Implement the approved notice presentation

Use Q4 for persistent warning/restriction presentation. The acknowledgement must be explicit, keyboard accessible and accurately recorded by the server. Show only allowed reason, kind, expiry and status; no reporter, evidence or internal notes.

### Task 3: Reconcile restrictions

Honor server can_send and refusal codes; explain timeout effects without inventing an expiry from local time. A local countdown is advisory and must revalidate. Removal/kick/ban UX uses only received authorized facts; missing history/expiry is a Q6 prerequisite, not permission to read moderator endpoints.

### Task 4: Preserve across handover

Test warning arrives live, arrives in ready, acknowledgement fails, account is displaced, reconnect occurs and permission/ban changes. Refresh through approved authoritative reads; do not persist sensitive notices across profiles.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Existing: Server/ws/moderation_actions_ready_test.go; Server/service/moderation_actions_test.go
- Proposed: safety/notices.test.ts; fullstack/b9-moderation-notices.spec.ts

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

The current ready warning list is not a complete recipient action history. Do not mark all sanction journeys complete from live-frame tests alone.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

### Q4 — Warning and timeout presentation

**Decided 2026-09-23 by the owner:** persistent notice, never a blocking modal. Unacknowledged warnings render as a top-of-app banner (the existing banner slot pattern) with the reason, the date, and one "Acknowledge" button that calls `POST /api/v1/users/me/notices/{id}/ack`; the banner has no other dismiss and survives navigation until the server confirms the acknowledgement. Multiple warnings stack oldest first. Timeouts are not banners: the composer, reaction controls and voice join show the disabled state inline with the server-supplied expiry ("You can't send messages until 14:05"); a local countdown is advisory and re-validates on the server's refusal codes. A one-time toast announces a newly received warning or timeout for screen readers.

**Options and consequences:** Use a persistent dismiss-resistant notice with an explicit Acknowledge action; or a blocking modal before other navigation. The former preserves access to recovery and help; the latter is harder to miss but interrupts the whole app and has stronger focus/escape obligations.

**Drafting recommendation (historical):** Use a persistent notice with explicit acknowledgement; keep timeout state adjacent to disabled actions. The server acknowledgement requirement does not itself settle whether the UI blocks navigation.

### Q6 — Restart-safe recipient sanctions and appeal eligibility

**Decided 2026-09-23 by the owner:** option (a), as a separate B5 contract-completion PR. Add `GET /api/v1/users/me/moderation` (session auth) returning the caller's own ledger rows of kind warning, timeout, removal, and ban where the ban has lapsed or been reversed, newest first, bounded by the existing retention sweep. Each row: `id` (the ledger id appeals use), `kind`, `reason`, `created_at`, `expires_at`, `lifted_at`, `acknowledged_at`, `appealable` (computed by the same rules `Submit` applies: kind eligible, not already appealed), and `appeal` (`{id, state}` or null). Excluded by construction: actor, reporter, report link, evidence, internal notes. Keep `ready.notices` as the fast path for unacknowledged warnings. Currently banned users remain out of band under B5 policy. B9-15/16 stay blocked for complete closure until this contract is accepted.

**Options and consequences:** Add a member-safe own-action/restriction read with ids, reasons, expiry and eligibility; or use only existing live frames and ready warnings. The read needs a narrowly scoped server contract PR; live-only UX cannot recover removal/timeout action ids and all eligible history after restart and leaves BPR-072/073 incomplete. Currently banned users remain out-of-band under the existing B5 policy in either case.

**Drafting recommendation (historical):** Approve a separate B5 contract-completion PR for own-action/restriction discovery, with a DTO excluding reporter/evidence/internal notes. B9-15/16 remain blocked for complete closure until its exact contract is accepted.

## Implementation record (2026-09-23)

### What shipped

- **Store** (`features/safety/store.ts`): unacknowledged warnings (oldest
  first, deduped by action id, an in-flight acknowledgement survives a
  `ready`), the active timeout's server expiry with an advisory local expiry
  timer, and the latest `GET /users/me/moderation` answer (latest request
  wins; a late answer after sign-out is dropped). `main.ts` clears it through
  `onAuthCleared`, so nothing crosses a profile switch; nothing is persisted.
  `serverTime` reads both the ledger's zone-less SQLite times and RFC 3339
  (drift 6).
- **Handlers** (`features/safety/wsHandlers.ts`, registered in
  `lib/dispatcher.ts`): `ready` sets the notices and re-reads the history;
  `mod_action` adds a warning or sets/clears the timeout, and toasts once for
  a new warning or timeout (a lift is not announced; the inline states clear);
  `auth_ok` on a resume re-reads the history (drift 5); a `TIMED_OUT` refusal
  re-reads it without consuming the frame.
- **Clock:** expiries are compared on the server's clock as far as the client
  can tell. A live timeout frame is sent as its row is written, so the next
  history read measures the offset from that row's `created_at` (a fast or
  slow local clock both end the timeout at the server's expiry). A
  `TIMED_OUT` refusal that the local clock contradicts pulls the clock back
  only to 2 s inside the newest timeout row's expiry (by `created_at`; when
  that row is lifted, no offset is set), so a 3 s-fast
  clock unlocks within seconds of the real expiry, not a minute later. A
  badly skewed clock may unlock early and be refused again; each refusal
  re-pulls the offset. A fast clock never silently drops a
  server-confirmed timeout.
- **History as authority:** each read sets the timeout from the unlifted,
  unexpired row, drops notices acknowledged on another device, restores an
  unacknowledged warning whose frame was missed, and replaces a live
  notice's local receipt time with the server's issue time.
- **Banner** (`features/safety/Notices.ts`, mounted by `MainPage` above the
  app row, Q4): reason and date, one Acknowledge that POSTs
  `/users/me/notices/{id}/ack` and a "View in Safety settings" link. No other
  dismiss, no modal. A notice leaves only on the server's 204, or on a 404
  (already acknowledged elsewhere). Pending is `aria-busy`/`aria-disabled`
  (focus stays), failure keeps the notice with a `role="status"` error, and
  removal moves focus to the next notice or the composer.
- **Safety tab** (the B9-4 destination, `destinations.ts`; its body is
  `features/safety/SafetyTab.ts`, loaded on first open so the MainPage chunk
  stays inside its 60,000 B budget): the current
  restriction and the member-safe history (kind, date, reason, acknowledged /
  active until / lifted / ended, appeal state). It re-reads on open and offers
  Try again on failure. No actor, reporter, report link, evidence or note is
  rendered; the unit test feeds those fields and asserts they stay off screen.
- **Timeout inline (Q4):** the composer shows "You can't send messages until
  14:05" (`ChannelController`), a voice channel row is `aria-disabled` with
  "You can't join voice until …" when not joined (leaving stays available,
  `ChannelSidebar`) and the same text shown under the row, and the reaction
  chips, the add-reaction chip and the message React button are
  `aria-disabled`, not clickable, with "You can't add reactions until …" as
  their tooltip (`message-list/reactions.ts`; `MessageList` re-renders when
  the timeout starts or ends). The time is the server's `expires_at`.

### Implementation decisions and file-table amendments

- `lib/api.ts` gained `acknowledgeNotice`: `ApiClient` exposes no generic
  request, so the planned `features/safety/api.ts` would have had to wrap it
  anyway. No `features/safety/api.ts` was added.
- Outside the file table, each minimal: `ChannelController.ts`,
  `ChannelSidebar.ts`, `MessageList.ts` and `message-list/reactions.ts` /
  `renderers.ts` (Q4's inline timeout states, styled in `messages.css` and
  `sidebar.css`), `main.ts` (sign-out
  reset), `features/navigation/destinations.ts` (the Safety entry, the B9-4
  plug-in point), `features/connection/dispatchContext.ts`
  (`getOwnModeration` in `DispatchApi`), `styles/app/overlays.css` (rules
  beside the existing reconnect banner; no import-order change),
  `i18n/safety.ts` (catalog), `tests/e2e/helpers.ts` (`readyOverrides.notices`)
  and `tests/e2e/b9-navigation.spec.ts` (the Safety tab now exists after
  Account).
- Review round 1 (owner, Q4 as written): reactions are rendered disabled
  inline instead of refusing a click with a toast; the voice-join expiry is
  visible text in the voice row, not only a tooltip; the "Your timeout has
  ended." toast was removed (not asked for); a fast local clock no longer
  drops a live or refused-send-confirmed timeout (see **Clock**).
- Kick and a current ban keep their existing handling (the server's message
  on the sign-in screen); currently banned users stay out of band under B5.
  Lifted or lapsed bans and removals appear in the Safety history.

### Follow-up (not in this PR)

- **Server:** issuing or lifting a timeout does not re-send `can_send`. A
  member who reconnects while timed out gets `can_send: false` in `ready`;
  after a later live lift the composer falls back to "You don't have
  permission to send messages here" until the next full reconnect. The fix
  belongs in the server (refresh the target's channel affordances on
  timeout issue/lift, as OC-0434 did for `ready`), in its own PR with the Go
  gates. The fullstack spec therefore proves the lift without a reconnect in
  between.

### Evidence

At `fm/b9-15-impl` (commit on the branch; exact-SHA CI in the PR):

| Check           | Command                                                                                                                                     | Result                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Types           | `npx tsc --noEmit`; `npx tsc -p tsconfig.e2e.json --noEmit`                                                                                 | clean                                                                                                                                |
| Lint            | `npm run lint` (oxlint, cycles, eslint)                                                                                                     | clean                                                                                                                                |
| Unit            | `npx vitest run --maxWorkers=4`                                                                                                             | all pass, incl. `src/features/safety/safety.test.ts` (25) and the new cases in `channel-controller`/`channel-sidebar`/`message-list` |
| Failing control | gates removed one at a time (composer/reaction/voice timeout checks, latest-read guard, pending-ack keep, focus-safe reorder, 404 handling) | 19 tests failed, all restored                                                                                                        |
| Budgets         | `npm run build:budget && npm run check:budgets`                                                                                             | MainPage 59,928 B / 60,000; startup 89,836 B / 91,000 (no budget raised)                                                             |
| Docs/hygiene    | `npm run check:docs`; `npm run check:hygiene`                                                                                               | pass                                                                                                                                 |
| Mocked e2e      | `npx playwright test tests/e2e/b9-moderation-notices.spec.ts tests/e2e/b9-navigation.spec.ts`                                               | pass                                                                                                                                 |
| Fullstack       | `npm run test:e2e:fullstack -- tests/e2e/fullstack/b9-moderation-notices.spec.ts`                                                           | 3 pass, twice                                                                                                                        |

### Accessibility (Q1)

Automated, in `tests/e2e/b9-moderation-notices.spec.ts`:

- **Names/roles:** `findUnnamedControls` is empty for the banner (a named
  `region`, each notice a `group` labelled by its title) and the Safety tab.
- **Keyboard/focus:** Acknowledge by Enter and Space; Tab/Shift+Tab between
  Acknowledge and the link; the Q1 ring (`focusIndicator`) in every theme;
  focus stays on a pending or failed Acknowledge and moves to the next notice,
  then the composer, when one leaves; Escape does not dismiss.
- **Announcements:** one toast per new live warning/timeout (a repeated frame
  is silent), "Warning acknowledged." through a persistent `role="status"`,
  the failure through the notice's own `role="status"`.
- **Contrast:** title, date, reason, Acknowledge and link ≥ 4.5:1 in dark,
  midnight, neon-glow, light, High Contrast and a light custom accent
  (`#fee75c`, which falls back under Q8); the error text ≥ 4.5:1. The matrix
  is attached to the run as `b9-15-contrast.txt`.
- **Reduced motion / reflow:** no animation or transition on a notice; at
  940×500 with 20px Large Font the banner has no horizontal overflow, scrolls
  within 40vh and leaves both notices' controls and the composer reachable.

**Owner-run, pending:** NVDA (Windows) and Orca (Linux) recordings of the
journey: a live warning announced once, the banner read with its reason and
date, Acknowledge and its result, the timeout reason on the composer and a
voice channel.
