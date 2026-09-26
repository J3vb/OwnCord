# Plan: B7-14 — Multi-device session management

> **Milestone:** B7-14 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-14-multi-device-sessions`.
> **Worktree:** `.claude/worktrees/b7-14`.
> **Drafted:** 2026-09-21. **Base commit:** `639d5bb3` (`dev`).

## Owner decisions (2026-09-21) — these override the plan below

- **"Active" means signed in**, not holding a live connection. The server
  keeps one live WebSocket per user and the last connect wins. That exposed a
  reproduced fight: the displaced device got a bare 1000 close, took it for a
  network drop, reconnected at the 1 s floor (a successful `auth_ok` resets the
  backoff) and kicked the other device, forever. The one approved **server
  change**: the hub's replacement branch (`Server/ws/hub_registry.go`) queues
  an error frame `SESSION_REPLACED` ("signed in on another device") before the
  close, and the client treats it like `BANNED` — stop, no reconnect — but
  keeps the credential and shows "Signed in elsewhere" with "Use here". This
  overrides "no server change" in Files to Change and Out of scope.
- **Revoke-one does not disconnect.** With one live socket per user, a revoked
  device cannot also hold a live socket while you revoke from a connected one,
  and calling `DisconnectRevokedUser` would kick the caller's own device. REST
  enforcement is immediate, so the UI says plainly that the device is signed
  out and can no longer connect — no ~30 s caveat. The exception is a device
  showing "Signed in elsewhere" revoking the device that holds the live
  socket: that socket stays up until the hub's 30 s session sweep or the
  per-message recheck, so from that state the toast says its connection
  closes within about 30 seconds (owner decision in review: accepted, wording
  made honest, no server change).
- **The notice** is a main-page toast naming the sign-in (device, IP, time),
  pointing to Settings > Account, and worded as a sign-in **not yet reviewed**
  rather than "new": `MarkSessionsSeen` excludes the caller, so a device may be
  told about another device's older sign-in.
- **No per-row revoke on the current device**; sign-out-everywhere covers it.
- **This milestone writes the BPR-035 evidence row** in the beta traceability
  doc (overrides Task 6's "leave it to B7-18").
- **Device labels:** both desktop User-Agents (`OwnCord-Client/<version>` and
  tauri-plugin-http's default) show as "OwnCord desktop"; IP and last-used
  tell devices apart. A per-device name is out of scope.

## Summary

The PRD's outcome is one sentence — "A user sees every device signed into
their account, is told about a new sign-in, and can revoke one device or all
of them" (`b7-shared-client-platform-desktop-parity.prd.md:326`) — and the
PRD's own gap cell says the server is done and the client is missing three
things: "Server API and wire shape complete; no client `unseen` field, no
revoke-all, no UI (`Client/src/lib/api.ts:57-74`)" (`:187`).

Recounted at `639d5bb3`, that cell is **half stale and half right**, and
which half matters reshapes the work:

- The **three endpoints exist and are mounted** — list, revoke-one and
  revoke-all (`Server/api/profile_handler.go:160-162`), with handlers at
  `:501`, `:550` and `:583`. Nothing on the server side needs adding.
- `SessionInfo` in the client still omits `unseen`, and the client has **no
  revoke-all method** (`Client/src/lib/api.ts:65-74, 372-384`). That half of
  the cell is true.
- There is **no UI at all**: `getSessions`/`revokeSession` have exactly one
  caller each, and it is their own declaration — a grep over
  `Client/src/**` finds no consumer (`:372`, `:382`). The Account tab has no
  session section (`Client/src/components/settings/AccountTab.ts:1091-1221`).

**This is a feature milestone, not a migration milestone.** B7-4/B7-5/B7-16
moved existing client call sites behind the platform seam; B7-14 adds a
surface that does not exist yet, plus a poll and a notice. The plan is
therefore shaped like a feature: a thin client-API change, one new UI section,
one lifecycle-scoped poll, and an e2e row.

**The security properties the plan relies on** (all re-derived below, none
assumed). This is the part the plan must state plainly, because "revoke"
sounds instantaneous and is not:

1. **Revoke-one deletes the row and nothing else.** `handleRevokeSession`
   (`:550-568`) calls `UserService.RevokeSession` and returns 204. It does
   **not** call `DisconnectRevokedUser` — unlike revoke-all. The target
   device's live WebSocket is dropped only when the hub's periodic sweep
   notices the missing row: `sessionSweepTicker` at 30 s
   (`Server/ws/hub.go:212`), or sooner if the connection sends
   `SessionCheckInterval = 10` messages (`Server/ws/client.go:21`,
   `Server/ws/handlers.go:124-150`). So revoke-one is "immediate against the
   next REST call, up to ~30 s for a live socket". **The plan must not claim
   or test instantaneous disconnect for revoke-one.**
2. **Revoke-all is immediate on both axes.** `handleRevokeAllSessions`
   (`:598-610`) revokes every session including the caller's, and calls
   `DisconnectRevokedUser` in the same request, so live sockets go now
   (`Server/ws/hub_broadcast.go:258`). The caller's own token stops working
   with the response, so the client must re-authenticate; the response says
   so via `current_session_revoked` (`:575-578`).
3. **The row is the only authority.** `AuthMiddleware` resolves the bearer
   against the `sessions` table on every REST request
   (`Server/api/middleware.go:98-176`), so a revoked row fails the next
   request regardless of any client state. The sweep and the per-message
   recheck are backstops for sockets, not the enforcement point.
4. **Revoked means gone, not marked.** `DeleteSessionByID` is a `DELETE`
   scoped `WHERE id = ? AND user_id = ?` (`Server/db/queries/sqlite/sessions.sql:27-30`),
   so one account can never revoke another's row.

**`unseen` is an acknowledgement counter, not a push.** The server sets it on
every login's new session (`Server/db/auth_queries.go:463`, `CreateSession` →
`insertSession(..., true)`) and clears every other row when the account lists
its sessions from one device (`Server/db/profile_queries.go:89-100`,
`MarkSessionsSeen`). **Listing is itself the acknowledgement.** There is no
WebSocket frame for it, and the owner decision recorded in the PRD is explicit:
"poll the sessions list on connect and on window focus and surface `unseen`;
no new WebSocket frame in B7"
(`b7-shared-client-platform-desktop-parity.prd.md:383`). That decision is
owner-delegated, dated 2026-09-19, and binds this milestone — a push frame is
a B9 candidate, not B7 work.

**The trap that shapes the poll task.** Listing acknowledges, so it is easy to
write this the wrong way and have it never fire: the acknowledge write
(`MarkSessionsSeen`) and the response body are built in the same request, and a
client that assumed "the flags are already cleared by the time I read them"
would wait for a second poll that never sees them again. It happens to work
because the response is built from the pre-clear rows
(`Server/api/profile_handler.go:518-531`) and written after the clear (`:540`,
`:545`) — but the client must surface the notice from
that single response and keep no state that depends on a later poll seeing
`unseen` again. The task and its falsifiability check below pin this: the test
must prove the notice appears from a response whose flags the server is, in the
same request, already clearing.

**The current device's own row is never cleared by its own listing.**
`MarkSessionsSeen` excludes the caller's own session id
(`sessions.sql:52-56`), and `CreateSession` sets `unseen` on the login's own row
(`auth_queries.go:463`). So a device's own listing always shows its own row
`unseen`, until some _other_ device lists. The notice **must** ignore the
`is_current` row, or every device would announce the user's own sign-in. That
exclusion is also what makes the feature work: when B logs in, B's row is
`unseen`; A's next poll sees it (not current) and notifies, and A's poll clears
it — one notice per new sign-in, the device that signed in excluded.

**Server-hosted content stays server-hosted.** The `device` string is the
login request's `User-Agent`, truncated to 512 bytes (`Server/api/auth_handler.go:374-380`,
`truncateDevice`), and the IP is the request IP. Both are already returned by
the list endpoint. The plan does not add a device-naming model, a fingerprint,
or a place to store one.

## Verify before you implement

Every row was re-derived at `639d5bb3` by the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                                                                                            | How to re-check                                                                                                                                                     | Verified |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Three session routes are mounted on the authenticated `/users/me` group: list, revoke-all, revoke-one                                                                                            | `grep -n "sessions" Server/api/profile_handler.go` → `:160` `:161` `:162` (handlers `:501` `:583` `:550`)                                                           | yes      |
| 2   | `sessionResponse` carries `unseen`; the list handler builds the response with the flags **before** the acknowledge write, so one listing can see them                                            | read `Server/api/profile_handler.go:92-103`; `resp` is built at `:518-531`, `MarkSessionsSeen` runs at `:540`, `writeJSON` at `:545`                                | yes      |
| 3   | The client `SessionInfo` omits `unseen`, and there is no client revoke-all method                                                                                                                | `grep -n "export interface SessionInfo" -A 12 Client/src/lib/api.ts` → no `unseen`; `grep -n "revokeAllSessions" Client/src/lib/api.ts` → empty                     | yes      |
| 4   | `getSessions`/`revokeSession` have no production consumer — the only references are their own declarations, plus tests                                                                           | `grep -rn "getSessions\|revokeSession" Client/src --include=*.ts` → `api.ts:372,382` only; same grep over `Client/tests` → `api.test.ts` only                       | yes      |
| 5   | The Account tab has no session/device section today                                                                                                                                              | `grep -n "^function build\|export function buildAccountTab" Client/src/components/settings/AccountTab.ts` → profile, avatar, password, TOTP, status, delete-account | yes      |
| 6   | Revoke-one does **not** disconnect the live socket; revoke-all does                                                                                                                              | `sed -n '549,568p' Server/api/profile_handler.go` (no disconnect); `:598-610` calls `DisconnectRevokedUser`                                                         | yes      |
| 7   | A revoked live socket is dropped within one 30 s sweep tick, or after 10 messages, whichever first                                                                                               | `grep -n "30 \* time.Second" Server/ws/hub.go` → `:212`; `Server/ws/client.go:21` (`SessionCheckInterval = 10`); `Server/ws/handlers.go:124-150`                    | yes      |
| 8   | Revoke-one is scoped to the caller's own rows                                                                                                                                                    | `Server/db/queries/sqlite/sessions.sql:27-30` (`WHERE id = ? AND user_id = ?`)                                                                                      | yes      |
| 9   | A login's session starts `unseen`; `MarkSessionsSeen` clears every row but the caller's                                                                                                          | `Server/db/auth_queries.go:463`; `Server/db/profile_queries.go:89-100`; SQL at `sessions.sql:52-56`                                                                 | yes      |
| 10  | The owner decision is recorded and binds B7: poll on connect/focus, no WS frame                                                                                                                  | `b7-shared-client-platform-desktop-parity.prd.md:383`                                                                                                               | yes      |
| 11  | `SettingsOverlayOptions` is the only seam the Account tab and MainPage/ConnectPage share; every option is passed by both callers                                                                 | `Client/src/components/SettingsOverlay.ts:29-64`; `Client/src/pages/MainPage.ts:496`; `Client/src/pages/ConnectPage.ts:238`                                         | yes      |
| 12  | A `visibilitychange`/`focus` listener pattern already exists to copy, and lifecycle ownership goes through `AbortSignal`/`Disposable`                                                            | `Client/src/lib/media-visibility.ts:171,184`; `Client/src/lib/disposable.ts:9`; `Client/src/components/settings/AccountTab.ts` takes a `signal`                     | yes      |
| 13  | The client unit suite is green before any change                                                                                                                                                 | `npm --prefix Client test` (Task 0 records the count; it must not drop)                                                                                             | yes      |
| 14  | _Stale at merge:_ B7-13 has since merged (https://github.com/J3vb/OwnCord/pull/1651). Originally: the PRD's B7-14 row has no server work and no plan yet, and B7-12/13/15 plans do not exist yet | `ls .claude/plans/ \| grep 'b7-1[2-5]'` → empty; `b7-shared-client-platform-desktop-parity.prd.md:326` (`Plan` cell `—`)                                            | yes      |
| 15  | The B7-14 register close-out is BG-08, whose closure line is the multi-device journey; BPR-035 is the traceability row                                                                           | `docs/plans/repo-health-issue-register-2026-08-23.md:302`; `docs/plans/beta-requirements-traceability-2026-08-23.md:84`                                             | yes      |
| 16  | e2e specs are the "harness" capability in `ci-select`, so a change there widens the dev browser run to the full suite, not the smoke set; the production run is unaffected                       | `scripts/ci-select.mjs:113` (`HARNESS_PREFIXES`); `.github/workflows/ci.yml:837-842`                                                                                | yes      |
| 17  | No WebSocket message type carries a new-login signal, and adding one would be a protocol change (both generators, fixtures)                                                                      | `grep -n "unseen" Server/ws/message_types.go Client/src/lib/protocolTypes.ts` → empty; `b7-shared-client-platform-desktop-parity.prd.md:383`                        | yes      |
| 18  | The account-list ordering is `created_at DESC` (newest first), which the UI may rely on for "newest device first"                                                                                | `Server/db/queries/sqlite/sessions.sql:46-50`                                                                                                                       | yes      |
| 19  | The `PartialSuccessResponse` warning path (change-password partial failure) tells the user to revoke sessions "from the sessions list", so that list must be reachable                           | `Server/api/profile_handler.go:489-492`; `Client/src/lib/types.ts:861-869`; `Client/src/lib/toast.ts:48-60`                                                         | yes      |
| 20  | The design doc already specifies the Account tab's sessions section, with the list fields and the optimistic-removal/ toast behaviour, but not sign-out-everywhere or the notice                 | `docs/architecture/ux/settings-and-admin.md:87-93` (§2.4)                                                                                                           | yes      |
| 21  | A device's own listing never clears its own row: `MarkSessionsSeen` excludes the caller's session id, and the login's own row is `unseen` from creation                                          | `Server/db/queries/sqlite/sessions.sql:52-56` (`id != ?`); `Server/db/auth_queries.go:463`                                                                          | yes      |

**Row 6 is the one that governs the acceptance wording.** It is the difference
between "revoke-one kicks the device immediately" (false) and "revoke-one makes
the device's next request fail, and a live socket is swept within ~30 s"
(true). A test asserting immediate disconnect on revoke-one would fail against
the real server and would push someone to add a disconnect the milestone did not
decide to add.

## Patterns to Mirror

- **API client method shape:** `getSessions` (`Client/src/lib/api.ts:372-380`)
  already unwraps the `{sessions: [...]}` envelope and asserts session ownership
  via `owner.assertCurrent()`. `revokeAllSessions` copies `revokeSession`'s
  one-line shape (`:382-384`) and returns the typed response rather than `void`,
  because the caller must read `current_session_revoked`.
- **The section's target behaviour is already written down:**
  `docs/architecture/ux/settings-and-admin.md:87-93` §2.4 specifies "List
  sessions — `GET /users/me/sessions`; show device/IP/last-used; current
  session marked" and "Revoke a session — `DELETE /users/me/sessions/{id}`;
  optimistic removal + toast". Follow it; the plan adds the two things §2.4
  does not yet name (sign out everywhere, the new-login notice) and updates
  that table in Task 6.
- **Section builder shape:** `buildDeleteAccountSection`
  (`AccountTab.ts:947-1083`) — a `settings-section-title`, a muted description,
  an action button, an inline confirm area, and a `{ signal }` on every
  listener. The sessions section is that shape with a list instead of a form.
- **Destructive-action confirmation:** `withConfirmation`
  (`Client/src/components/AdminActions.ts:99`) is the existing two-click
  confirm for a destructive menu item (Force Logout). For "sign out
  everywhere" the plan uses a confirm area like the delete-account section's,
  because the action is account-wide and must say what it will do.
- **Lifecycle-scoped listeners:** `media-visibility.ts:171,184` shows the
  `visibilitychange` + `focus` pair; the poll registers both through an
  `AbortSignal` (the same `signal` a section builder receives), so closing the
  overlay or leaving the page tears them down. No new lifecycle primitive.
- **Toast for the notice:** `showToast(message, type, durationMs)`
  (`Client/src/lib/toast.ts:36`) with a long duration, the way
  `PARTIAL_SUCCESS_TOAST_MS = 12_000` (`:20`) already handles a message the
  user must have time to read. No new notification component.
- **A gate that cannot fail is not a gate:** the poll's notice test must be
  observed **red** with the `unseen` read removed — B7-3's null-subject rule,
  which found nine vacuous tests three reviews missed
  (`b7-5-adapter-media-shell.plan.md:114-115`).

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                             | Change                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `Client/src/lib/api.ts`                          | `SessionInfo.unseen`; new `revokeAllSessions()` returning the typed response                       |
| `Client/src/lib/types.ts`                        | new `RevokeAllSessionsResponse` (`sessions_revoked`, `current_session_revoked`)                    |
| `Client/src/components/settings/AccountTab.ts`   | new "Devices & Sessions" section (list, per-row Revoke, Sign out everywhere)                       |
| `Client/src/components/SettingsOverlay.ts`       | new `SettingsOverlayOptions` methods the section consumes                                          |
| `Client/src/pages/MainPage.ts`                   | wire the new options to `api`; own the notice poll                                                 |
| `Client/src/pages/ConnectPage.ts`                | no-op the new options (unauthenticated), like every existing option                                |
| `Client/src/lib/session-notice.ts`               | new: the connect/focus poll that surfaces `unseen` (one small module, one caller)                  |
| `Client/tests/unit/api.test.ts`                  | `unseen` in the fixture; `revokeAllSessions` endpoint + envelope tests                             |
| `Client/tests/unit/session-notice.test.ts`       | new: the poll fires on `unseen`, does not re-fire, tears down on abort                             |
| `Client/tests/unit/account-tab-sessions.test.ts` | new: list rendering, current-device marking, revoke-one calls only its id, revoke-all confirmation |
| `Client/tests/unit/settings-overlay.test.ts`     | the new options in the fixture (it builds every tab)                                               |
| `Client/tests/unit/account-tab-profile.test.ts`  | the new options in `makeOptions` (the shared fixture helper)                                       |
| `Client/tests/e2e/sessions.spec.ts`              | new: the BPR-035 journey, one scenario                                                             |
| `docs/architecture/ux/settings-and-admin.md`     | §2.4's table gains sign-out-everywhere and the new-login notice (the section it already specifies) |

**Never** edit `Server/**`, `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `protocol/**`, `gendocs:*` blocks,
`docs/plans/*`, `CHANGELOG.md`, or any status row. **This milestone adds no
server code and no protocol change** — the server half is complete (row 1)
and the owner decision forbids a frame (row 10).

**B7-13 overlaps two of these files by ownership, not by line.**
`Client/src/pages/MainPage.ts` and `Client/src/lib/api.ts` are named in
B7-13's scope (one connection, isolated profiles, quick switch — PRD `:325`),
which has since merged (https://github.com/J3vb/OwnCord/pull/1651). B7-13 owns the profile-switch
teardown path in `MainPage.ts`; this milestone's poll in the same file is a
sibling concern and must be registered/cleared through the same mechanism the
page already uses for teardown (`MainPage.ts:1006-1014` destroys unsubscribers
and children). A merge conflict there is expected; keep both edits. Nothing in
B7-14 changes `api.ts`'s session-scope machinery.

## Tasks

Commit after every task — conventional subject, scope `b7-14`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-14-multi-device-sessions`
  at `639d5bb3` or later. Run the one-liner Verify rows (1, 3, 4, 6, 8, 9, 10,
  11, 18) and record their output. Record `npm --prefix Client test` totals
  **at your HEAD** — the counts in the PRD and in the other B7 plans were
  taken at earlier commits and are a floor to re-measure, not a constant to
  assert.
- **Why:** the milestone's whole premise is which half of the PRD's gap cell
  is true; record it before touching anything.
- **Validate:** the client suite is green. Record the count — it must never
  drop from what Task 0 measured.

### Task 1: The client API — `unseen` and revoke-all

- **Action:** add `readonly unseen: boolean` to `SessionInfo`
  (`Client/src/lib/api.ts:65-74`); add `RevokeAllSessionsResponse` to
  `Client/src/lib/types.ts` next to `PartialSuccessResponse`; add
  `revokeAllSessions(signal?): Promise<RevokeAllSessionsResponse>` beside
  `revokeSession` (`:382`), `DELETE /users/me/sessions`, returning the body.
- **Why:** the list already carries `unseen` (row 2) and the endpoint already
  exists (row 1); this is the client catching up to the wire shape. Returning
  the body, not `void`, is what lets the caller know
  `current_session_revoked` (row 6) and tell the user to sign in again rather
  than let the next 401 look like an error.
- **Gotcha:** `getSessions` returns the flags from _before_ the server
  acknowledges them (row 2). Do not add a second flag, a `seen` parameter, or a
  local filter — the wire shape is the contract (`docs/api.md:882-916`).
- **Validate:** `npm --prefix Client run typecheck` clean; the three
  `api.test.ts` session tests green, with new cases for the `unseen` field and
  `revokeAllSessions`'s endpoint and body. Commit.

### Task 2: The sessions section in the Account tab

- **Action:** add `buildSessionsSection(options, signal)` to
  `AccountTab.ts`, in `buildDeleteAccountSection`'s shape (row 5, Patterns):
  a title and a muted description; a list where each row shows the `device`
  string (empty → a neutral "Unknown device", row 3's `SessionInfo` doc says
  `""` is possible), the `ip`, and a human-formatted `last_used`; the
  `is_current` row marked and offered no revoke (the caller's own row is
  revoke-all's job); a per-row Revoke button; and a "Sign out everywhere"
  button below with an inline confirm area that states the caller is included.
  Call it from `buildAccountTab` (`AccountTab.ts:1091`) next to the other
  section builders.
- **New options** (Task 3 wires them): `onListSessions(): Promise<SessionInfo[]>`,
  `onRevokeSession(id: number): Promise<void>`,
  `onRevokeAllSessions(): Promise<RevokeAllSessionsResponse>`.
- **Gotcha:** `AccountTab.ts` takes a `signal` and every listener passes it
  (row 12). The list is fetched on build, so it re-reads when the tab is
  rebuilt on reopen (`SettingsOverlay.ts:184-196` `show()` → `renderActiveTab`)
  — no separate refresh path is needed for the section itself.
- **Gotcha:** after a successful revoke-one, remove the row optimistically and
  toast, per §2.4 (`settings-and-admin.md:92`); the server has already deleted
  it (row 8). A later rebuild of the tab re-reads the list, so no explicit
  refresh call is needed — but do not render a row the server refused to
  delete: on a failed revoke, put it back and toast the error.
- **Validate:** `npm --prefix Client test -- tests/unit/account-tab-sessions.test.ts`
  green: renders two rows, marks the current one, Revoke on the other calls
  `onRevokeSession` with **only** that id, revoke-all requires the confirm step
  and then calls `onRevokeAllSessions`. Observed red with the per-row id
  hard-coded to the current session. Commit.

### Task 3: Wire the options and sign out everywhere

- **Action:** add the three options to `SettingsOverlayOptions`
  (`SettingsOverlay.ts:29-64`), implement them in `MainPage.ts:496` against
  `api` (Task 1), and add no-op/rejecting stubs to `ConnectPage.ts:238` the
  way every other option is stubbed for the unauthenticated page. For
  revoke-all, on a response whose `current_session_revoked` is true, clear
  local auth (`clearAuth` via the existing logout path) so the app returns to
  the connect screen — the token is dead with the response (row 6).
- **Why:** the settings overlay is the only seam the Account tab has (row 11);
  both pages construct it and must stay constructible.
- **Gotcha:** do **not** route revoke-all through `logout()` — that sends
  `POST /auth/logout` for one session and then clears auth. Revoke-all is
  `DELETE /users/me/sessions` and must report the count (row 6). The two are
  different server actions with different effects on other devices.
- **Gotcha:** the change-password partial-success warning already tells the
  user to revoke sessions "from the sessions list"
  (`Server/api/profile_handler.go:489-492`, row 19). This task is what makes
  that instruction true; do not weaken the warning instead.
- **Validate:** `npm --prefix Client test` count not lower;
  `settings-overlay.test.ts` and `account-tab-profile.test.ts` fixtures
  updated and green; `typecheck` and `typecheck:build` clean. Commit.

### Task 4: The new-sign-in notice

- **Action:** add `Client/src/lib/session-notice.ts` exporting one function
  that, given a sessions fetcher and a notify callback, polls on connect and
  on `focus`/`visibilitychange`, surfaces the notice when a row has
  `unseen: true`, and returns a teardown. Register it from `MainPage` mount and
  tear it down in the existing unsubscriber list (`MainPage.ts:1006-1014`).
  Surface the notice with `showToast(..., "info", …)` at a read-able duration
  (rows 10, 11).
- **Why:** this is the milestone's "is told about a new sign-in" outcome, and
  the owner decision fixes the transport (row 10). A module of its own keeps
  `MainPage.ts` — already an orchestrator and on B7-13's list — from growing a
  second concern inline.
- **Gotcha (the trap):** listing acknowledges (row 9), so the notice may be
  visible in exactly one response. Fire the notice from that response and keep
  no "already seen" state that depends on a second poll seeing `unseen` again.
  The test must prove the notice appears from a response the server is already
  clearing — observe it red with the `unseen` read removed.
- **Gotcha:** the caller's own row is `unseen` on its own listing by design
  (row 21), so the notice must ignore the `is_current` row or every device
  announces the user's own sign-in. Say so in a test.
- **Gotcha:** no busy loop. Connect plus `focus`/`visibilitychange` only; the
  listener is `visibilitychange` on `document` and `focus` on `window` as the
  existing pair is (row 12). Do not add a timer.
- **Validate:** `npm --prefix Client test -- tests/unit/session-notice.test.ts`
  green: fires on an `unseen` row; does not fire for the current row; does not
  fire twice for one response; the listener is removed on teardown. Observed
  **red** with the `unseen` read removed. Commit.

### Task 5: The BPR-035 e2e scenario

- **Action:** add `Client/tests/e2e/sessions.spec.ts` — one scenario that
  signs in, opens Account, sees the device list with the current device
  marked, revokes a second device, and signs out everywhere (asserting the
  app returns to the connect screen). Add the sessions route to the mock in
  `Client/tests/e2e/helpers.ts`.
- **Why:** the PRD's own decision records that the BPR-035 evidence is one
  scenario in the existing `client-e2e` job — "the existing default Playwright
  config plus one scenario per B7-12/13/14/15 flow"
  (`b7-shared-client-platform-desktop-parity.prd.md:390`).
- **Gotcha:** `Client/tests/e2e/` is a `harness` path (row 16), so adding a
  spec widens the **development** browser run from the smoke set to the full
  suite for this PR. That is correct and intended — a new spec is exactly the
  "specs or fixtures moved" case the smoke selection exists to widen for
  (`.github/workflows/ci.yml:831-836`). Do **not** add the spec to
  `playwright.config.smoke.ts`'s `testMatch` list: that list is a deliberate
  sample, not the home for a new journey, and the smoke run is a _subset_ that
  will not pick the spec up (the full dev suite is what runs it).
- **Validate:** `npm --prefix Client run test:e2e -- sessions.spec.ts` (the
  plain `playwright test` script, which uses the base config's `testDir`) is
  green. Commit.

### Task 6: Docs and the final gate

- **Action:** update §2.4 of `docs/architecture/ux/settings-and-admin.md`
  (`:87-93`) — its table already specifies List sessions and Revoke a session
  but not the two things this milestone adds: a "Sign out everywhere" row and a
  "New sign-in" row (the notice, its transport being the list, not a frame).
  Correct anything in that table this milestone makes false. Per the owner
  decision above, this milestone also writes the BPR-035 evidence row in
  `docs/plans/beta-requirements-traceability-2026-08-23.md` itself.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  npm run check:docs
  npm run check:hygiene
  ```

  Then the `ci-check` skill. Commit.

## Validation

```
npm --prefix Client test -- tests/unit/session-notice.test.ts      # the poll, red-first
npm --prefix Client test -- tests/unit/account-tab-sessions.test.ts
npm --prefix Client test                                           # count not lower than Task 0's
npm --prefix Client run typecheck
npm --prefix Client run typecheck:build
npm --prefix Client run lint                                       # 0 warnings, cycles <= ceiling
npm --prefix Client run test:e2e -- sessions.spec.ts               # the new spec (the smoke set does not include it)
npm run check:docs
npm run check:hygiene
# → then the ci-check skill; this PR touches Client/tests/e2e/, so expect the
#   development browser run to widen to the full suite (Verify row 16), and no
#   server or rust job is selected.
```

## Risks

| Risk                                                                                                   | Mitigation                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plan claims instantaneous disconnect for revoke-one, which is false                                | Verify row 6/7 is the acceptance wording: revoke-one fails the next request, a live socket is swept within ~30 s. The e2e scenario must not assert an immediate kick |
| The notice never fires because listing acknowledges, so `unseen` is cleared by the poll itself         | The server returns flags as they were before the clear (row 2); Task 4 fires from that single response and its test is observed red with the `unseen` read removed   |
| The caller's own `unseen` row re-notifies on every listing                                             | Task 4 ignores the `is_current` row and tests exactly that                                                                                                           |
| Revoke-all is wired through `logout()`, sending the wrong request and leaving other devices alone      | Task 3's gotcha names the two actions apart; a test asserts `DELETE /users/me/sessions` is what the button calls                                                     |
| `MainPage.ts` / `api.ts` conflict with B7-13, which owns the profile-switch teardown in the same files | Expected. B7-13 has merged (row 14); the poll registers through the page's existing teardown list so both edits coexist. Keep both edits                             |
| The new e2e spec silently only runs in the full dev suite, never in CI                                 | `Client/tests/e2e/` is the `harness` prefix (row 16), which forces the full dev-suite run in CI for this PR; the production run is complete regardless               |
| The device string is attacker-controlled (a login's `User-Agent`) and is rendered in the UI            | The server truncates it to 512 bytes and the client renders it as text through `createElement` (never `innerHTML`), the same posture every other server string gets  |
| A UI surface is added without the `unseen` half being genuinely wired                                  | Task 4 exists as its own task with its own falsifiable test; Task 6's acceptance requires a row with `unseen` to produce a notice, observed red first                |

## Out of scope

- **Any server change.** The endpoints, `unseen` and the revoke semantics all
  exist (rows 1, 2, 9); the milestone consumes them.
- **A WebSocket new-login frame.** Forbidden by the owner decision (row 10);
  a push frame is a B9 candidate.
- **A device-naming model** (rename a device, a friendly platform label, a
  stored fingerprint). The `device` string is the login `User-Agent` today
  (`Server/api/auth_handler.go:374-380`); inventing a label is its own
  decision.
- **Instant disconnect on revoke-one.** Not decided, and the sweep is the
  existing backstop (row 7). If the owner wants it, it is a server change and
  belongs to a decision, not this plan.
- **A dedicated sessions settings tab or a new overlay.** The Account tab is
  the existing home for account-scoped actions.
- **Admin "Force Logout"** (`Client/src/components/AdminActions.ts:283`) — a
  different actor and endpoint; untouched.
- **B7-13's profile isolation and B7-15's account flows** — they share files
  at most, not behaviour.

## Open questions for the owner

Keep this list short; each is a real choice with materially different work.

- [ ] **Revoke-one immediacy.** Revoke-one deletes the row but does not
      disconnect the live socket; the device's next REST call fails, and its
      socket is dropped within one 30 s sweep or after 10 messages (rows 6, 7).
      The PRD outcome says "can revoke one device" without stating the timing.
      **Options:** (a) accept the sweep's ~30 s as the contract and say so in
      the UI, the plan's default; (b) have the server call `DisconnectRevokedUser`
      on revoke-one too, making it immediate like revoke-all, which is a small
      server change this client-phase milestone would then own. **Recommend
      (a)** — the enforcement point is the row (row 8) and the sweep is the
      existing, tested backstop; (b) widens a client phase into server work for
      a latency the user cannot observe (the device is already unable to act).
- [ ] **What the notice says and where it lives.** The outcome is "is told
      about a new sign-in". **Options:** (a) a toast on the main page, the
      plan's default, consistent with the existing partial-success warning
      (`toast.ts:36,48`); (b) a persistent banner until dismissed, like
      `UpdateNotifier`; (c) a marker on the Account tab only, no interruption.
      **Recommend (a)** — it is the least new surface, it uses an existing,
      tested component, and the Account tab list carries the durable record
      either way. (b) is a new component for a message the user can act on in
      one click; (c) makes "is told" depend on the user having opened settings.
- [ ] **Does the current device get a Revoke button?** The current row is
      marked and the plan offers it no revoke (revoke-all covers it, and its
      response says the caller was included). **Options:** (a) no per-row
      revoke on the current device, the plan's default; (b) allow it, treating
      it as a single-device logout. **Recommend (a)** — `logout()` already owns
      that action with its own wiring, and two buttons for one effect invites
      the user to wonder which one signs them out.

## Acceptance

- [ ] `SessionInfo` carries `unseen` and the client has a `revokeAllSessions`
      method returning `{ sessions_revoked, current_session_revoked }`
- [ ] The Account tab lists every session with device, IP and last-used, marks
      the current one, revokes one device by id, and signs out everywhere after
      a confirmation that states the caller is included
- [ ] Sign-out-everywhere clears local auth when the server reports the current
      session revoked, so the next screen is the connect page rather than a 401
- [ ] A new sign-in is surfaced from the sessions list on connect and on
      window focus, with no WebSocket frame and no polling timer
- [ ] The notice is observed **red** with the `unseen` read removed; the
      current session's flag never re-notifies
- [ ] One `sessions.spec.ts` scenario covers the BPR-035 journey end to end
- [ ] No server file, no protocol file and no generated file is touched; no
      status row is edited
- [ ] `npm --prefix Client test` count is not lower; `typecheck`,
      `typecheck:build`, `lint`, `check:docs`, `check:hygiene` and the
      `ci-check` skill are green
- [ ] No new `ts-ignore` / `.skip` / `.only`; no loosened assertion; cycle
      ceiling not raised
- [ ] The BPR-035 traceability row records this milestone's evidence
