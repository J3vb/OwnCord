# Plan: B9-6 — Accept, ignore, delete or block a Message Request

**Status:** IMPLEMENTED — 2026-09-23 on `fm/b9-6-impl`; NVDA/Orca recordings and the OS 200 % zoom check are owner-run and pending. See [Implementation record](#implementation-record-2026-09-23).

> **Milestone:** B9-6 of [b9-unified-experience-accessibility-polish.prd.md](../../docs/plans/b9-unified-experience-accessibility-polish.prd.md).
> **Branch:** `feat/b9-6-message-request-decisions`; branch from current `dev`, PR to `dev` only.
> **Drafted:** 2026-09-23. **Base commit:** `0beee8e4c50ca18823750e381d3a1d6e327029b8` (`dev`).
> **Roadmap workstreams:** 1, 8. **Requirements:** BPR-060, BPR-091.
> **Dependencies:** B9-5. All product work also requires the PRD entry gate.
> **Owner:** one assigned implementer for this PR; product decisions and HP signatures remain with the repository owner.
> **Priority/impact:** beta-blocking acceptance for the named requirements; no date deadline.

## Summary

Accept, ignore, delete or block a Message Request. The PR covers this journey and the bounded tasks below; upstream contract changes ship separately.

**User journey:** Accept one request; separately ignore, delete and block others; retry a failed action and hand the account to another device.

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

| #   | Verified current state                                                                              | Evidence at planning commit                                                            |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | There are four recipient transition endpoints and a response carrying id, state and decided_at.     | `Server/api/dm_request_handler.go:24-27`; `Server/api/dm_request_handler.go:103-108`   |
| 2   | Accept uses the service transition and then notifies a DM open; all actions notify recipient state. | `Server/api/dm_request_handler.go:135-156`; `Server/api/dm_request_handler.go:160-174` |
| 3   | The accepted policy keeps pending, ignored and deleted indistinguishable to the sender.             | `docs/plans/b5-community-content-moderation-2026-09-04.md:301-315`                     |

## Patterns to mirror

- Follow `Client/CLAUDE.md:44-56`: dispatcher registers server-event store writes;
  feature handlers do not subscribe on their own. Keep new/extracted feature code
  under `src/features/` with colocated unit tests.
- `Client/src/lib/modalFactory.ts:71-99` is the existing dialog/lifecycle pattern;
  use the shared B9-2 rules once accepted. Do not add independent global state.
- Server-dependent contract tests belong under `Client/tests/contract`, not unit
  (`Client/CLAUDE.md:22-25`). Preserve generated protocol ownership.

## Server contract, privacy and compatibility

POST /api/v1/dm-requests/{id}/{accept,ignore,delete,block}; only server acceptance establishes trust. Reuse B5 block/retention/deletion rules.

No schema migration or epoch change is assumed. If a dependency requires one,
settle and plan it before this milestone; do not silently extend a client PR.
Late asynchronous results cannot cross server/account/consent generations.
Evidence contains synthetic accounts and content; private advisories are named
only by their existing public identifiers, never reproduced here.

## Files to change

| File / bounded group                                                                   | Purpose                                              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Client/src/features/message-requests/**`                                              | Action state and dialogs                             |
| `Client/src/features/direct-messages/wsHandlers.ts; Client/src/lib/dispatcher.ts`      | Acceptance event integration only, serialized        |
| `Client/tests/e2e/fullstack/b9-message-requests.spec.ts (new)`                         | Real-server transition and no-sender-signal evidence |
| `docs/plans/b9-unified-experience-accessibility-polish.prd.md` and this milestone plan | Dated implementation status and exact-SHA evidence   |

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

### Task 1: Wire explicit decisions

Add the four actions to the inbox. Explain that Accept trusts this sender on this server, and that Ignore/Delete do not notify the sender. Use the approved destructive-action pattern for Block/Delete.

### Task 2: Reconcile rather than invent state

Disable duplicate submission; apply the server result, reconcile list/event races and refetch on conflict. Enter the ordinary DM only after confirmed acceptance. A request disappearing does not prove acceptance.

### Task 3: Test lifecycle and privacy

Cover competing actions from two signed-in devices with sequential active-socket handover, disconnect after commit, sender/recipient deletion, retention and block changes. Preserve ordinary DM trust behavior and do not add a second active socket.

### Task 4: Record the complete journey

Capture each transition and the sender view with a real server; prove Ignore/Delete add no sender-visible rejection. On removal move focus to the next request or inbox heading.

### Task 5: Validate and record the one-PR outcome

Run the affected gates using `.claude/skills/ci-check/SKILL.md` at implementation
time. Record commands, exact head, results and CI links; compare against the
base and preserve pre-squash head for structural evidence. Update the requirement
evidence row and status only for work actually qualified. Do not close a ledger
finding solely because this milestone was merged.

## Acceptance and required evidence

The following checks are **planned**, not reported as run by this planning PR:

- Proposed: message-requests/decisions.test.ts; fullstack/b9-message-requests.spec.ts
- Existing: Server/service/message_request_test.go; Server/api/dm_request_handler_test.go; Client/tests/e2e/dm-system.spec.ts

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

Optimistic navigation can expose a conversation before trust commits; wait for confirmed authority and make conflicting outcomes visible.

Rollback is a scoped revert of this PR plus dependent client changes where
necessary; preserve server data and current authorization. No new durable data
is assumed without an approved decision. Never restore a consent-bypassing
render path as a fallback; fail closed and record a blocker instead.

## Open questions

No new owner decision is introduced by this milestone. The PRD's unresolved entry decisions still apply; stop if implementation would require a new product, UX or scope choice.

## Implementation record (2026-09-23)

### Base and inventory drift

Branch `fm/b9-6-impl` (the brief's name; the plan's `feat/…` name was not
used) from `origin/dev` `1d37c034` (B9-5 merged), with `dev` merged in as it
moved (through the Refined Neon tokens, #1764). The server contract is on
`dev`; no server, schema, protocol or generated file changed.

| #   | Drift at `1d37c034`                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Holds. Routes at `Server/api/dm_request_handler.go:23-27`; the response type moved to `:104-108`.                                                                                                                                     |
| 2   | Holds. The transition handler is `:114-159` and `notifyDMRequestTransition` `:166-`: `dm_channel_open` on accept, then `dm_request` to all of the recipient's sockets, best-effort (a dropped frame is possible).                     |
| 3   | Holds, cited lines moved: the policy is decision 5 at `docs/plans/b5-community-content-moderation-2026-09-04.md:324` and `docs/api.md:1721-1729` (sender view byte-identical across pending/ignored/deleted; block is visible later). |

### What shipped

- `Client/src/features/message-requests/`:
  - `decisions.ts`: `decide()` posts one decision and applies only the
    server's 200, like a `dm_request` frame, so an in-flight snapshot cannot
    resurrect the request. A 409/404 refetches the inbox instead of guessing.
    Block also records the sender in `blocksStore`. `openAcceptedConversation`
    enters the ordinary DM only once the server has opened it: from
    `dm_channel_open`, or from `GET /dms` when that frame was lost (a warm
    resume gets no `ready` to carry it). `confirmDecision` is the
    DeleteChannelModal-shaped destructive confirm on `createModal`.
  - `Inbox.ts`: each request gets a named group of Accept, Ignore, Delete…,
    Block…; rows are keyed by id so a frame never re-renders a row holding
    focus; one extra `role="status"` region speaks each outcome.
  - `sync.ts` (new): the snapshot fetch moved out of `wsHandlers.ts`, plus the
    session's client for the inbox (forgotten on sign-out). The inbox cannot
    import a `wsHandlers` module (`dispatcherDoor.test.ts`).
  - `decisions.test.ts` (new, 14 tests).
- Single-writer files, minimal: `lib/api.ts` (`decideDmRequest` and its two
  types), `lib/dispatcher.ts` and `features/connection/dispatchContext.ts`
  (`decideDmRequest`, `getDmChannels` added to the `DispatchApi` pick). No
  navigation, MainPage, store, token, `types.ts` or CSS-import change.
- Also: `i18n/messageRequests.ts` (copy), `styles/app/chat-area.css` (three
  rules, Refined Neon `--space-*` tokens and the existing `--text-danger`;
  buttons reuse `btn-modal-save`/`btn-modal-cancel`/`btn-danger`),
  `tests/e2e/b9-message-requests.spec.ts` (B9-6 describe, reflow and Q8
  checks) and `tests/e2e/fullstack/b9-message-requests.spec.ts` (new).

### Implementation decisions

- **Server word only.** No optimistic removal or navigation. Buttons use
  `aria-disabled` while a decision is in flight (a `disabled` button drops
  focus to `<body>`) and a second press is ignored. A failed decision keeps
  the row, shows the error in it and in the status, and re-arms the buttons.
- **Copy.** The help line says Accept trusts the sender on this server and
  that Ignore and Delete do not tell the sender. The Block confirm says the
  block is not announced but a later message from them fails visibly, which
  is the server's documented behaviour.
- **Focus on removal.** When the row holding focus (or its open confirm)
  leaves, for any reason, focus moves to the next request's row (not its
  Accept, so a repeated Enter cannot decide another request), else the
  previous row, else the view heading; an open confirm for a request decided
  elsewhere closes. After Accept, focus goes to the conversation's composer.
- **Bundle.** A value import of `lib/api` (`ApiClientError`) from the lazy
  inbox chunk split shared chunks out of the startup closure (+1.1 kB); the
  409/404 check matches the error by name instead. Measured against the
  pre-change tree: startup +135 B (90,938 → 91,073 B), MainPage −40 B. After
  the Refined Neon merge: startup 91,579 B of the shared 93,000 B, MainPage
  60,069 B of 60,512 B. `bundle-budgets.json` is unchanged by this PR.

### Evidence

Node 26.9.0, vitest 4.1.11, Playwright 1.63.0 Chromium, Linux, head
`0cc53ab6` (pre-squash; the PR's CI run is the exact-SHA record). The
removal focus moved from the next request's Accept to its row after that
head; the unit, mocked and fullstack assertions for the row (and its focus
ring) are recorded by the PR's CI run, not by the counts below.

| Check                                                                                                                                                                                               | Result                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `src/features/message-requests` (inbox + decisions)                                                                                                                                                 | 32 passed                                |
| `npx vitest run --maxWorkers=4` (whole client)                                                                                                                                                      | 6,462 passed, 152 expected-fail (exit 0) |
| `typecheck`, `typecheck:build`, `typecheck:e2e`, `lint` (oxlint, cycles, eslint)                                                                                                                    | clean                                    |
| `build:budget` + `check:budgets`                                                                                                                                                                    | all ok (figures above)                   |
| Playwright mocked `b9-message-requests` (B9-5 four + B9-6 keyboard/dialog journey, contrast in 4 themes × High Contrast and two custom accents, 940×500 at 20 px Large Font with the Block confirm) | 6 passed                                 |
| Playwright fullstack `b9-message-requests` (real Go server): accept/ignore/delete/block with sender silence; other-device 409, lost `dm_request`/`dm_channel_open`, reconnect after commit          | 2 passed                                 |
| Playwright regression: `dm-system`, `b9-navigation`, `a11y-smoke`                                                                                                                                   | 17 passed                                |
| Server, unchanged: `go test -count=1 -run 'MessageRequest\|DMRequest' ./service/ ./api/`                                                                                                            | ok                                       |

The fullstack spec's senders are scripted over REST and their own
WebSocket; the "other device" is a second REST session for bob with no
socket, so bob never holds two active sockets. It raises the server's auth
rate multiplier for its four sign-ups (`OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER`).
It proves, against the real server, that after Ignore and Delete the sender
gets no frame about the conversation and an identical `GET /dms` and DM
history. Screenshots (after Ignore, the Delete confirm, the accepted
conversation, 940×500 inbox and Block confirm) are attached to the Playwright
reports.

**Not covered by new evidence.** Sender or recipient account deletion and
retention are server-side (`Server/service/message_request_test.go`,
`Server/api/dm_request_handler_test.go`); on the client they reach the inbox
only as a 404 or a vanished row, which the unit suite covers (404 refetch,
"Unknown user", removal focus). No real-server deletion or retention run was
added.

**Failing controls.** Each guard was removed and its suite re-run; every one
failed, and each was restored: the local apply of the 200 (4 tests), the
409/404 refetch (2), opening the DM before the server does (1), the removal
refocus (2), the in-flight guard (1), closing the confirm with its row (1),
and the `GET /dms` fallback (1). The fullstack lost-frame step failed before
the `GET /dms` fallback existed.

### Accessibility (Q1)

- **Keyboard:** all four decisions and both confirm buttons are native
  `<button>`s reached by Tab in visual order and operated by Enter or Space;
  Escape closes the confirm only (the inbox stays open) and returns focus to
  its opener (e2e). No hover-only action; pointer and keyboard share handlers.
- **Screen reader:** each request's decisions are a `group` named "Request
  from {name}"; outcomes and errors speak once through a dedicated
  `role="status"`; the busy row carries `aria-busy`. The confirm is a modal
  `dialog` named by its heading, with Cancel focused first. No stranger
  content beyond the B9-5 text reaches the tree. **NVDA and Orca recordings
  are owner-run and pending.**
- **Focus:** every decision and confirm button's ring, and the request
  row's ring after a removal, meets Q1 (2px, 3:1; e2e `focusIndicator`); Tab stays inside the confirm; removal moves focus to
  the next request's row or the heading (unit and e2e); Accept lands on the
  conversation's composer (fullstack).
- **Contrast:** button labels, the help line, the outcome, the in-row error
  and the confirm's heading, body and buttons meet 4.5:1 in neon-glow, dark,
  midnight and light, each with and without High Contrast, and Accept's label
  and ring hold under two low-contrast custom accents (Q8; e2e). Busy and
  error states are carried by text, not colour.
- **Reduced motion:** no animation in the inbox or the confirm with the app
  setting on (e2e `getAnimations`); the OS setting follows the shared B9-2
  path. No media.
- **Zoom/reflow:** at 940×500 with 20 px Large Font every decision is whole
  in view and at least 24×24 px, and the Block confirm's buttons fit (e2e,
  screenshots). The OS 200 % zoom check is owner-run and pending.
