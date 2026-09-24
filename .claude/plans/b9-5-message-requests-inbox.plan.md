# Plan: B9-5 — Show the Message Requests inbox and safe text preview

**Status:** IMPLEMENTED — OS-zoom check pending owner; native AT recordings declined by owner 2026-09-24 — 2026-09-23 on branch `fm/b9-5-impl` from `dev` `166d71e4`, carried to `fm/b9-5-impl-v2` with `dev` `5682b410` merged in; the outcome and evidence are in [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-5 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-5-message-requests-inbox`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 1, 8. **Requirements:** BPR-060, BPR-091.
> **Dependencies:** B9-4. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Show the Message Requests inbox and safe text preview. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Open a first-contact request, read sender and plain text, leave and reconnect without accepting or fetching media.

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

| #   | Verified current state                                                                                                           | Evidence at planning commit                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | B5 exposes an authenticated pending inbox with sender profile, optional text preview and no media bytes.                         | `Server/api/dm_request_handler.go:20-28`; `Server/api/dm_request_handler.go:44-99` |
| 2   | The generated event name exists, while dispatcher currently wires DM channel open/close without a request handler in that group. | `Client/src/lib/protocolTypes.ts:46-60`; `Client/src/lib/dispatcher.ts:154-160`    |
| 3   | The current DM sidebar section renders conversation rows and a View all messages button.                                         | `Client/src/pages/main-page/SidebarDmSection.ts:37-74`                             |

### Drift at the implementation base (2026-09-23)

Re-read at `166d71e44ce5dfde6455e3f108ce88a8def9c88f` (B9-4 merged). Rows 1 and
2 hold: `git log 0beee8e4..166d71e4` does not touch
`Server/api/dm_request_handler.go`, `protocolTypes.ts` or `dispatcher.ts`.
Row 3 drifted: B9-4 changed `SidebarDmSection.ts`. The factory now starts at
line 40, and it takes a `pendingRequests` count that it badges on the DM
header, apart from unread. The "Message Requests (N)" entry at the top of DM
mode is in `SidebarArea.ts`. Both render only once
`NAVIGATION_DESTINATIONS.requests` exists, so this milestone registers that
entry and edits neither file. The entry preconditions hold: B9-4 is merged,
and Q1 and Q2 were decided on 2026-09-23.

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

GET /api/v1/dm-requests; recipient-only dm_request. HP-5/B5 decision 4: one-to-one only, safe text preview, trust only after acceptance. Sender gets no rejection/read signal.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Client/src/features/message-requests/{api,store,wsHandlers,Inbox}.ts (new)`           | Typed inbox, snapshot/event reconciliation and text-only view |
| `Client/src/lib/api.ts; Client/src/lib/types.ts; Client/src/lib/dispatcher.ts`         | Minimal API/type/registration edits, serialized               |
| `Client/src/pages/main-page/SidebarDmSection.ts; B9-4 navigation composition`          | Inbox entry with no ordinary-DM acceptance side effect        |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan | Dated implementation status and exact-SHA evidence            |

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

### Task 1: Add the inbox adapter and state

Mirror the REST fields exactly and add a feature-owned account/server-scoped request store. Reconcile GET snapshots and dm_request events through dispatcher-owned handlers; ignore late responses from an abandoned session.

### Task 2: Render text without rich-content side effects

Show sender name and inert message text through a dedicated safe-preview renderer. Do not mount the normal message renderer, automatic avatar loads, attachments, embeds, oEmbed, provider search or broker calls. A profile avatar URL is not permission to fetch it.

### Task 3: Integrate the read-only inbox

Mount through B9-4; handle empty, loading, unavailable and reconnect states. Recover authoritative pending state after reconnect and session handover. Keep unaccepted channels outside the ordinary conversation view.

### Task 4: Prove safe preview

Spy on broker, server file/history, and browser resource loads while opening and scrolling requests. Use link/GIF/attachment-looking text, a null preview and sender erasure; all automatic content fetch counts remain zero.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Proposed: Client/src/features/message-requests/inbox.test.ts; Client/tests/e2e/b9-message-requests.spec.ts
- Existing contract evidence: Server/api/dm_request_handler_test.go; Server/ws/dm_request_test.go

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

Reusing a rich renderer or avatar helper performs work before the inbox action; test fetch absence, not just hidden DOM.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record (2026-09-23)

### What shipped

- `Client/src/features/message-requests/`:
  - `api.ts` maps the B5-6 wire shape to the inbox model and drops the
    sender's `avatar` there, so no later code can load it.
  - `store.ts` is the account-scoped inbox and `pendingRequestCount`.
  - `wsHandlers.ts` holds the inbox refetch (on `ready` and on a resumed
    `auth_ok`) and the `dm_request` handler.
  - `view.ts` is the destination's builder. It loads the text-only view in
    `Inbox.ts` on first open, as B9-15's Safety tab does, and closes the view
    if that chunk cannot load.
  - `inbox.test.ts` is the unit suite.
- `destinations.ts` registers `requests: { build: buildInbox, pending: pendingRequestCount }`, where `buildInbox` comes from `view.ts`
  (a one-line edit, the B9-4 plug-in rule). That turns on "Message Requests
  (N)" at the top of DM mode and the DM header's pending badge.
- Single-writer files, each a minimal edit: `lib/api.ts` (`listDmRequests`),
  `lib/types.ts` (the wire types and the `dm_request` union entry) and
  `lib/dispatcher.ts` (one `ws.on`, one call in the `ready` order after
  blocks, and one call in the `auth_ok` handler on a resume). MainPage, `ui.store` and the
  navigator are unchanged. SidebarDmSection only turns the DM header's
  pending badge into a button into DM mode, and SidebarArea only moves focus
  into DM mode when that switch came from inside the sidebar, so the badge
  never drops focus to `<body>` (see Implementation decisions).
- Files beyond the table: `features/connection/dispatchContext.ts` (adds
  `listDmRequests` to `DispatchApi`, as in the dispatcher's signature),
  `i18n/messageRequests.ts` (the feature's catalog), `styles/app/chat-area.css`
  (the inbox rules, in the fragment that owns the content view; no import order
  change), `tests/e2e/b9-message-requests.spec.ts`, and
  `tests/e2e/b9-navigation.spec.ts`. B9-4's absence check there covered the
  Requests entry, which now ships by design. It keeps covering Moderation and
  Safety, and a zero count still shows no badge.

### Implementation decisions

- **Reconciliation.** Every `ready` fetches `GET /api/v1/dm-requests`, since
  `dm_request` is unsequenced and never replayed. A tier-1/2 resume
  (`auth_ok` with `replay_source` `buffer` or `db`) gets no `ready`, so the
  dispatcher's `auth_ok` handler fetches it then; a full flow (`none`) leaves
  it to the `ready` that follows, so no connection fetches twice (review fix,
  2026-09-23; unit test "refetches on a resume, which gets no ready", which
  fails without the call). The newest snapshot wins
  (`snapshotSeq`). A frame that lands while a snapshot is in flight keeps its
  word for that id (`touched` rev), so a request decided mid-fetch is not
  brought back, and a request that arrived mid-fetch is not dropped. A
  `pending` frame adds a request. Any other state (accepted, ignored,
  deleted, blocked) removes it.
- **Session scope.** `onAuthCleared` empties the store, and the reset keeps
  `snapshotSeq` rising. A snapshot from the previous account therefore cannot
  land, even after the next account's first fetch has started. The API
  client's session scope also rejects it (AbortError, which the handler
  ignores).
- **Safe preview.** Every field is text (`textContent`). The view uses no
  message renderer, avatar, link, embed, attachment, emoji or mention
  lookup, and it opens no request channel. A null preview reads "This message
  has no text to preview.", and an erased sender reads "Unknown user".
- **Q2 badge meaning.** The count is the store's own. Requests never enter
  `dmStore`/`channelsStore`, so they add nothing to unread or mentions, and
  they trigger no notification or taskbar flash.
- **Way in with no DMs.** The DM header's pending badge is a button that
  enters DM mode, where "Message Requests (N)" sits. Without it, a user with
  no accepted DMs has no DM row and no "View all" to click, so a
  first-contact request could not be opened (live test fix, 2026-09-23; unit
  test "opens DM mode from the badge for a user with no DMs"). Pressing it
  from the keyboard lands focus in DM mode (review fix, 2026-09-23).
- **States.** The status region reads loading, empty, unavailable (the GET
  failed or the server is older) or reconnecting. It speaks only when its
  text changes. It is never `hidden`: when silent it is empty and taken out
  of the layout by CSS, so it stays in the accessibility tree and its next
  change is announced (review fix, 2026-09-23). B9-6 owns decisions, and with them a retry path.
- **Bundle.** At base `166d71e4` the eager inbox fit. After B9-15 merged,
  dev `5682b410` left 55 B of MainPage headroom (59,945 B of 60,000 B) and
  711 B in the startup closure (90,289 B of 91,000 B). With the eager inbox,
  the merged branch measured 60,642 B and 91,017 B, over both budgets. The
  inbox view now loads lazily. That brings startup to 90,938 B (it fits) and
  MainPage to 60,073 B, still 73 B over. The owner raised the MainPage budget
  from 60,000 B to 60,512 B for B9-5 (firstmate relay, 2026-09-23). The reason
  is recorded in `Client/bundle-budgets.json`.

### Evidence

Implementation on `fm/b9-5-impl` from base `166d71e4`: Node 26.9.0, vitest
4.1.11, Playwright Chromium, Linux. The e2e runs used a private Vite server on a
free port with no global teardown, because the machine is shared.

| Check                                                                                                                                                                                                                                                         | Result                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Affected unit files before the change (`src/features`, `main-page`, `sidebar-area`, `ui-strings`, `dispatcher`, `sidebar-dm-section`)                                                                                                                         | 35 files, 734 passed                     |
| `src/features/message-requests/inbox.test.ts`                                                                                                                                                                                                                 | 17 passed                                |
| `npx vitest run --maxWorkers=4` (whole client)                                                                                                                                                                                                                | 6,401 passed, 149 expected-fail (exit 0) |
| `typecheck`, `typecheck:build`, `typecheck:e2e`, `lint` (oxlint, cycles, eslint), Tauri version check                                                                                                                                                         | clean                                    |
| `build:budget` + `check:budgets`                                                                                                                                                                                                                              | all ok (figures above)                   |
| Playwright: `b9-message-requests` (journey, live/reconnect, contrast in 4 themes × High Contrast, 940×500 at 20 px Large Font)                                                                                                                                | 4 passed                                 |
| Playwright regression: `b9-navigation`, `main-layout`, `profile-switch`, `a11y-smoke`, `sidebar-header`, `settings-overlay`, `dm-system`, `b9-primitives`, `b9-text-expansion`, `logout-flow`, `channel-sidebar`, `reconnection`, `sidebar-menus`, `dm-calls` | 109 passed (with the B9-5 spec)          |

**Failing controls.** Each guard below was removed in turn and its suite
re-run, and every one failed. Each was restored before commit.

- `inbox.test.ts`: the latest-snapshot guard; the frame-over-snapshot rev
  guard; the sign-out reset; `snapshotSeq` rising across a reset; dropping the
  avatar at the adapter; the text-only preview (swapped for `innerHTML`); the
  view's unsubscribe on abort; the status region speaking once; the dispatcher
  registration; and the quiet cancelled fetch.
- `b9-message-requests.spec.ts`: an `innerHTML` preview (caught by the
  plain-text and zero-load assertions) and removing the `ready` refetch (the
  reconnect no longer restores the server's inbox).

### Accessibility (Q1)

- **Keyboard:** the entry is a `<button>`, and Enter opens it. Tab order is
  heading, Close, then the request list. The list scrolls and is focusable
  (`tabindex="0"`, named "Pending message requests"). Escape and Close go back
  to the channel the user came from (e2e). No action is hover-only, and the
  inbox has no other controls (decisions are B9-6).
- **Screen reader:** the view is a `region` named by its `h2`. Each request
  is a list item whose `h3` is the sender, so heading navigation walks the
  requests. The status is one `role="status"` that speaks only on change
  (unit), and the badge reads "N pending message requests". No avatar URL
  reaches the DOM. **NVDA and Orca recordings were declined by the owner
  2026-09-24.**
- **Focus:** the heading takes focus on open, and the Close and list rings
  meet Q1 at 2px and 3:1 or better (e2e `focusIndicator`). The list keeps
  focus and its element through live updates (unit). On close, focus goes to
  the returned channel's composer, because the opener leaves with DM mode
  (e2e). Entering DM mode from a focused control (the pending badge, "View
  all") moves focus to the first DM-mode control, "Message Requests (N)",
  instead of dropping it to the page (review fix, 2026-09-23; unit test
  "opens DM mode from the badge for a user with no DMs", which fails without
  it).
- **Contrast:** intro, sender, username, time, preview and the no-text line
  meet 4.5:1 in neon-glow, dark, midnight and light, each with and without
  High Contrast (e2e `textContrast`). They use only the qualified tokens
  `--header-primary`, `--text-normal` and `--text-muted`. No information
  depends on colour. The custom-accent fallback does not apply, because no
  inbox text or indicator uses the accent (the focus ring is the shared
  `--focus-ring`).
- **Reduced motion:** nothing in the inbox animates (e2e `getAnimations`
  returns 0, with the app's reduced-motion setting on). No media autoplays.
- **Zoom/reflow:** at 940×500 with 20 px Large Font, every request's text is
  reachable and in view. The long unbroken string wraps, and neither the list
  nor the page scrolls sideways (e2e, screenshot attached). The OS 200 % zoom
  check is still owner-run and pending.
