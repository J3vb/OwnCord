# Plan: B7-12 — Compatible update and incompatible state

> **Milestone:** B7-12 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-12-compatible-update-incompatible-state`.
> **Worktree:** `.claude/worktrees/b7-12`.
> **Drafted:** 2026-09-21. **Base commit:** `b15cc97b` (`dev`).
> **Amended 2026-09-21 (owner decisions on review round 2):** all three open
> questions are answered, and two claims and the connected-path assertion are
> corrected. The answers are in [Decisions](#decisions-resolved-2026-09-21) at
> the end; **read that section before Task 0.**

## Summary

The PRD outcome is: "A connected user gets a clear update notice when the
server says a newer compatible release exists, and lands in a safe, exitable
state when the server's epoch is incompatible"
(`b7-shared-client-platform-desktop-parity.prd.md:324`). The PRD also records
the milestone's two preconditions as _already satisfied_: `GET
/api/v1/server-info` exists and answers `name`, `protocol_epoch` and
`browser_client_enabled`, and the `protocol_epoch_unsupported` path exists end
to end (`:269-281`). Read against that, B7-12 is not "build the mechanism" — it
is **the first client caller of `server-info`** (roadmap workstream 14:
workstream 8 "consumes … the `GET /api/v1/server-info` endpoint B6 workstream
16 adds" and "defines no new contract",
`repo-health-roadmap-2026-08-23.md:971-974`) plus the two presentation gaps
that endpoint and the WS refusal leave open.

**What the server already exposes, re-derived at `639d5bb3` and re-checked at
`b15cc97b` (the two differ only by sibling plan files).** The server holds
one wire epoch, generated from `protocol/schema.json`:
`ws.ProtocolEpoch = 1` (`Server/ws/message_types.go:11`) and the client mirror
`PROTOCOL_EPOCH = 1` (`Client/src/lib/protocolTypes.ts:12`). `server-info`
returns that epoch and the server name (`Server/api/router.go:651-655`,
`:729-748`), deliberately with no version (C-2, pinned by
`TestAPIV1ServerInfoOmitsVersion`, `Server/api/router_test.go:226-231`). The
auth handshake accepts `epoch` in `[min_epoch, server_epoch]`
(`minClientEpoch = 0`, `Server/ws/messages.go:388`) and refuses outside it with
`auth_error {code: "protocol_epoch_unsupported", client_epoch, server_epoch,
min_epoch}` (`:397-414`, emitted at `Server/ws/serve_auth.go:67-70`). The
client-update endpoint advertises **only a release whose epoch is no newer than
the server's** — a newer declared epoch, or an unverifiable manifest, is
withheld with `204` (`Server/api/client_update.go:62-70`,
`Server/api/client_update_epoch_test.go:58-73`). That filter protects a
_compatible_ client from updating into a refusal; it is not the release a
refused, older client needs. On the refusal path the client-update endpoint
still offers the compatible release (epoch equal to the server's), so silence
there comes only from a missing or unverifiable manifest, or a missing target
asset (`client_update.go:76-82`) — **not** from the epoch branch.

**What the client already does.** The dispatcher reacts to the refusal: it sets
`uiStore.updateRequiredHost` only when `server_epoch > PROTOCOL_EPOCH` and
clears auth with reason `"protocol_epoch"`
(`Client/src/lib/dispatcher.ts:299-313`). `main.ts` keeps the stored
credential on that reason, navigates to the connect page, and mounts an
`UpdateNotifier` there (`Client/src/main.ts:782-793`; credential retention at
`:985-1001`). A connected user already gets the update notice:
`MainPage` mounts the notifier immediately (`:874-883`), and the notifier's own
`mount` starts a 3 s delay before it calls `checkForUpdate`
(`Client/src/components/UpdateNotifier.ts:177-181`; `Client/src/lib/updater.ts:41-43`
→ `Client/src/platform/desktop/updater.ts:55-70` → the Rust
`check_client_update`, `src-tauri/src/update_commands.rs:212`), then renders
"Update vX available" with `[Update Now] [Later]`
(`Client/src/components/UpdateNotifier.ts:85-117`).

**What is actually missing — two gaps, both re-derived here.** First,
`server-info` has **no client caller**: `git grep -n "server-info"
-- 'Client/**'` returns nothing, and no `getServerInfo` method exists on the
API client (`Client/src/lib/api.ts` has no such method; its only pre-login
probe is `getHealth`, `:633-669`). The incompatible state is therefore only
ever entered by a _failed WebSocket handshake_, never deliberately before it.
Second, the incompatible state's only guaranteed message is the generic
transient-error banner (`Client/src/pages/ConnectPage.ts:275-289` renders
`uiStore.transientError`, which the dispatcher set to the server's own
`message`). There is **no "update required" state**: `UpdateNotifier` knows
"available", "manual upgrade", download states and failure
(`UpdateNotifier.ts:38-165`), but nothing that says "this server cannot speak to
this client". When no compatible installer is offered — a missing or
unverifiable manifest, or a missing target asset (`client_update.go:76-82`) —
the banner stays silent and the user is left with a one-line error and no
stated requirement.

**The shape of the work.** Add the `server-info` caller (a `getServerInfo`
method in the `getHealth` shape) and use its `protocol_epoch` as an
**advisory** _preflight_ on the connect path (Decision 1): it badges the profile
row but never disables Connect, and the WebSocket `auth_error` stays
authoritative. Turn a mismatch into an explicit, actionable, exitable
`IncompatibleNotice` (Decision 2) naming which side updates, independent of
whether an installer is offered. Keep the already-working notice on the
connected path, and make the whole path testable for B7-17's smoke matrix
(`prd.md:350-352`) with one browser scenario, per the owner's e2e decision
(`prd.md:390`).

**No new protocol message, and one small server edit.** The epoch is already on
the wire and on `server-info`; B7-12 reads it. `protocol/schema.json` is
untouched, so the `protocol-change` skill does not apply. No `#[tauri::command]`
is added. The only server change is the 5 s response cache on `handleServerInfo`
(Decision 7), mirroring the `healthCacheTTL` precedent — the response shape is
unchanged, so `docs/architecture/platform-contracts.md`'s counts (21 importers /
30 invoke names / 35 handlers) and its guard test
(`Client/tests/unit/platform-contracts-counts.test.ts:57-59`) are unchanged.

## Verify before you implement

Every row was re-derived at `639d5bb3` (and re-checked at `b15cc97b`) with the
command shown. If a row is false at your HEAD, **stop that task and record it**;
do not improvise around it.

| #   | Claim                                                                                                                                                                                                                                                                              | How to re-check                                                                                                                                                | Verified |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `server-info` has **no** client caller and the API client has no `getServerInfo`                                                                                                                                                                                                   | `git grep -n "server-info" -- 'Client/**'` → empty; `grep -n "getServerInfo" Client/src/lib/api.ts` → empty                                                    | yes      |
| 2   | `getHealth` is the only pre-login probe, in an explicit-host `SessionScope` shape                                                                                                                                                                                                  | `Client/src/lib/api.ts:633-669`; callers `Client/src/main.ts:331` and `Client/src/lib/connectionDiagnostics.ts:166`                                            | yes      |
| 3   | The server epoch is generated; client and server constants are both `1`                                                                                                                                                                                                            | `Client/src/lib/protocolTypes.ts:12`; `Server/ws/message_types.go:11`                                                                                          | yes      |
| 4   | `server-info` returns `name`/`protocol_epoch`/`browser_client_enabled` and **no version** (C-2)                                                                                                                                                                                    | `Server/api/router.go:651-655`, `:729-748`; `Server/api/router_test.go:226-231`                                                                                | yes      |
| 5   | The refusal frame carries `code`/`client_epoch`/`server_epoch`/`min_epoch`; `minClientEpoch = 0`                                                                                                                                                                                   | `Server/ws/messages.go:388,392,397-414`; `Server/ws/serve_auth.go:67-70`                                                                                       | yes      |
| 6   | The client already reacts to the refusal and sets `updateRequiredHost` only when the server is newer                                                                                                                                                                               | `Client/src/lib/dispatcher.ts:299-313`; oracle `Client/tests/unit/dispatcher.test.ts:291-339`                                                                  | yes      |
| 7   | `main.ts` mounts the notifier on the connect page and keeps the credential on `"protocol_epoch"`                                                                                                                                                                                   | `Client/src/main.ts:782-793`, `:985-1001`; oracle `Client/tests/unit/main.test.ts:450-534`                                                                     | yes      |
| 8   | A connected user's notice comes from `checkForUpdate`, which `MainPage` mounts immediately and `UpdateNotifier.mount` delays 3 s, not from `server-info`                                                                                                                           | `Client/src/pages/MainPage.ts:874-883`; `Client/src/components/UpdateNotifier.ts:38-52,177-181`                                                                | yes      |
| 9   | `UpdateNotifier` has no "update required"/incompatible state; unknown cases are silent                                                                                                                                                                                             | `Client/src/components/UpdateNotifier.ts:38-165`; `Client/tests/unit/update-notifier-manual-upgrade.test.ts:102-115`                                           | yes      |
| 10  | The client-update epoch filter withholds releases **newer than the server** (`client_update.go:62-70`); a refused older client is still offered the compatible release, so silence on that path comes only from a missing/unverifiable manifest or missing target asset (`:76-82`) | `Server/api/client_update.go:62-82`; `Server/api/client_update_epoch_test.go:58-73`; `Server/api/client_update_test.go:136-152`                                | yes      |
| 11  | `HealthResponse` carries no `version` server-side, so `health.version` reads `undefined` today                                                                                                                                                                                     | `Server/api/router.go:585-593` (no `Version` field); `Client/src/lib/types.ts:873-879`; readers `Client/src/lib/profiles.ts:281-282`, `Client/src/main.ts:337` | yes      |
| 12  | The connect-page profile rows already have a per-row status hook (`updateHealthStatus`) B7-12 can extend                                                                                                                                                                           | `Client/src/pages/connect-page/ServerPanel.ts:264-289`; `Client/src/main.ts:304-354`                                                                           | yes      |
| 13  | BPR-033's closure row carries **no** evidence block today, unlike BPR-055 one row down                                                                                                                                                                                             | `docs/plans/beta-requirements-traceability-2026-08-23.md:82` (cell ends at "user-deferral cases pass.")                                                        | yes      |
| 14  | BG-07 is the register row B7-12 closes, re-verifying the B2 slice at HEAD                                                                                                                                                                                                          | `docs/plans/repo-health-issue-register-2026-08-23.md:301`; `prd.md:373`                                                                                        | yes      |
| 15  | The owner already decided the evidence shape: one browser scenario per B7-12/13/14/15 flow in the existing `client-e2e` job                                                                                                                                                        | `prd.md:390`                                                                                                                                                   | yes      |
| 16  | The mocked e2e harness can serve `server-info` over `httpRoutes` and inject a WS `auth_error` frame                                                                                                                                                                                | `Client/tests/e2e/helpers.ts:443-455` (`httpRoutes`), `:811-813` (`ROUTE_HEALTH`), `:997` (`emitWsEvent`)                                                      | yes      |
| 17  | No `#[tauri::command]` and no protocol type is added by this milestone, so the counts test is untouched                                                                                                                                                                            | `Client/tests/unit/platform-contracts-counts.test.ts:57-59` → 21 / 30 / 35                                                                                     | yes      |
| 18  | The client suite is green before any change, at a countable baseline                                                                                                                                                                                                               | `npm --prefix Client test` → 242 files, 5734 passed \| 140 expected fail                                                                                       | yes      |

**Rows 9 and 10 are the pair that makes this milestone real.** Row 9 says there
is no required-state presentation; row 10 says the updater cannot carry the
requirement — the epoch filter is a _compatible-client_ guard, and the refusal
path can go silent for reasons that have nothing to do with the epoch. A
preflight `server-info` check is the source that can state the requirement when
no installer is offered. It is advisory (Decision 1); the WS refusal remains
authoritative.

## Patterns to Mirror

- **The `getHealth` probe shape.** `Client/src/lib/api.ts:633-669` is the
  template for `getServerInfo`: an explicit host, a `SessionScope` owner when
  the host differs from the signed-in server, `ensureHttpProxy` through the
  desktop seam (`Client/src/lib/httpProxy.ts:14-15`), a timeout that disposes
  the scope, and `owner.assertCurrent()` around every await. Do not invent a
  second transport.
- **The contract-suite shape.** `Client/tests/unit/platform/updater.suite.ts:1-5`
  and `Client/tests/unit/platform/externalContent.suite.ts` assert only what the caller receives (no
  command name, no argument shape). `getServerInfo` is not a `Platform` member —
  it rides the existing `HttpClient` — so its unit test is an ordinary
  `Client/tests/unit/api.test.ts`-style test, not a platform suite.
- **The epoch oracle is already written.** `Client/tests/unit/dispatcher.test.ts:291-339`
  pins "newer server → update required; older server → no update offer"; and
  `Client/tests/unit/main.test.ts:450-534` pins the connect-page mount, the
  consumed host, the IPv6 URL, and the credential retention. Extend these; do
  not write a parallel oracle.
- **The mocked e2e scenario.** `Client/tests/e2e/updater.spec.ts:95-176` is the
  shape: `buildTauriMockScript` with `httpRoutes`, then `emitWsEvent` to drive
  frames. A B7-12 spec serves a `server-info` route with a newer
  `protocol_epoch` and asserts the state renders, is actionable and is
  exitable.
- **Prove a state can fail.** B7-3's null-subject probe and B7-7's lowered-budget
  step (`b7-7-bundle-runtime-budgets.plan.md:99-101`) are the house rule: every
  new assertion is observed red before it is trusted green. For B7-12 that means
  showing the incompatible-state test fails when the epoch comparison is
  inverted, and the "exitable" test fails when the dismiss/back path is removed.
- **A state that names its owner.** `docs/protocol.md:236-261` is the written
  compatibility policy; the client's message must name which side updates, the
  same wording the server builder already chooses
  (`Server/ws/messages.go:398-403`). Do not invent a second phrasing.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                     | Change                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `Client/src/lib/api.ts`                                                  | new `getServerInfo(host, timeoutMs, signal)` in the `getHealth` shape                     |
| `Client/src/lib/types.ts`                                                | new `ServerInfoResponse { name; protocol_epoch; browser_client_enabled }`                 |
| `Client/src/lib/profiles.ts`                                             | `HealthStatus` gains the resolved compatibility (or a sibling check); `pingHost` calls it |
| `Client/src/pages/connect-page/ServerPanel.ts`                           | render the **advisory** per-row compatibility badge                                       |
| `Client/src/pages/connect-page/IncompatibleNotice.ts`                    | **new**: the actionable, exitable incompatible state (Decision 2)                         |
| `Client/src/pages/ConnectPage.ts`                                        | expose `showIncompatible(…)`; mount/destroy the notice                                    |
| `Client/src/main.ts`                                                     | preflight via `server-info` in `runHealthChecks`; host snapshot; refusal feeds the notice |
| `Client/src/lib/dispatcher.ts`                                           | keep the epoch block; the refusal stays authoritative (Decision 1)                        |
| `Client/src/stores/ui.store.ts`                                          | reuse `updateRequiredHost` + the two epochs; **no** second fact (Decision 2)              |
| `Server/api/router.go`                                                   | `handleServerInfo` gains a **5 s response cache** (Decision 7), mirroring `handleHealth`  |
| `Server/api/router_test.go`                                              | a case pinning the cache (two calls within the TTL do not re-read `cfg`)                  |
| `Client/tests/unit/api.test.ts`                                          | `getServerInfo` cases                                                                     |
| `Client/tests/unit/profiles.test.ts`                                     | the compatibility derivation and its unreachable/older/newer cases                        |
| `Client/tests/unit/connect-page.test.ts`                                 | the incompatible state renders, is actionable and is exitable                             |
| `Client/tests/unit/dispatcher.test.ts`, `Client/tests/unit/main.test.ts` | extend the existing epoch oracles                                                         |
| `Client/tests/e2e/incompatible-epoch.spec.ts`                            | **new**: the browser scenario (row 15)                                                    |
| `docs/architecture/ux/connection-and-auth.md`                            | the connect-page incompatible state, beside the health table (`:44-56`)                   |
| `docs/architecture/ux/settings-and-admin.md`                             | the "update required" state beside the updater table (`:177-190`)                         |
| `docs/plans/beta-requirements-traceability-2026-08-23.md`                | the BPR-033 evidence block (`:82`) — see the dependency note below                        |
| `docs/plans/repo-health-issue-register-2026-08-23.md`                    | BG-07's B7 re-verify note (`:301`) — see the dependency note below                        |

**One server change, and only one.** `server-info` already carries
`protocol_epoch` (`Server/api/router.go:651-655`), and "which side updates" is
derivable from `protocol_epoch` versus `PROTOCOL_EPOCH`; **no `min_epoch` field
is added** (Decision 1). The single server edit is the **5 s response cache** on
`handleServerInfo` (Decision 7), mirroring the `healthCacheTTL` pattern
(`Server/api/router.go:610-614,657-693`); the response shape is unchanged, so
`docs/api.md`'s `server-info` field table (`:2786-2812`) still reads true and is
not touched.

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `protocol/schema.json`, `gendocs:*` blocks,
`CHANGELOG.md`, or any status row. No field is added to `server-info`, so
`docs/api.md` is **not** touched on the response-shape side; its route index
(`:176`) is gendocs-owned and its prose is B6-7's.

### Dependency conflicts to expect

- **B7-15 extends `server-info`, and lands after B7-12.** It owns adding
  `registration_mode` and a `retention` summary to `serverInfoResponse`
  server-side, and a `stores/serverInfo.store.ts` snapshot, but its plan already
  defers the client read to B7-12's shape (it says "Land the read once, in a
  shape both can use"). **B7-12 lands first** with the explicit-host
  `getServerInfo(host, timeoutMs, signal)`, a per-host snapshot fed by
  `runHealthChecks` (Decision 7), and a **5 s server-side response cache** on
  `server-info`; B7-15 only adds its two fields to `ServerInfoResponse` and reads
  the snapshot. Keep both edits in `types.ts`/`api.ts`.
- **B7-10 decomposes `dispatcher.ts`, and lands after B7-12.** The epoch block is
  `Client/src/lib/dispatcher.ts:299-313`; the review's ordering puts B7-12
  before B7-10 (`dispatcher.ts` is decomposed only after both of its editors
  have landed). If B7-10 somehow lands first, re-point the extracted module;
  B7-12 must not be the PR that moves it.
- **B7-13 owns profile isolation.** B7-12 touches `profiles.ts`'s health probe
  and `ServerPanel.ts`'s rows. B7-13 touches profile/cache isolation. Different
  functions in the same files — keep both edits.
- **B7-17's smoke matrix exercises this update path** (`prd.md:350-352`), which
  is why the path gets one e2e scenario (row 15) and a unit oracle, not only a
  mocked banner.
- **The traceability row and the register row are shared with B7-18.**
  `prd.md:373` assigns BG-07's B7 re-verify to B7-12, and
  `beta-requirements-traceability-2026-08-23.md:82` is the BPR-033 evidence
  home. B7-18 does the final reconciliation. Add the evidence and the re-verify
  note; do not rewrite the rows.

## Tasks

Commit after every task — conventional subject, scope `b7-12`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Baseline and recount

- **Action:** confirm the worktree is on the implementation branch at
  `b15cc97b` or later; run every Verify row that is a one-liner (1–7, 9–11, 13,
  14, 16, 17) and record the output. Record `npm --prefix Client test` totals at
  HEAD — row 18's 242 files / 5734 passed | 140 expected fail are a floor to
  re-measure, not a constant to assert.
- **Why:** the milestone's acceptance is stated against what already exists;
  rows 1 and 9 are the two facts that decide how much work is left.
- **Validate:** the client suite is green; the count must never drop below what
  this task measured.

### Task 1: The `server-info` client caller and its 5 s server cache

- **Action:** add `ServerInfoResponse` to `Client/src/lib/types.ts` and
  `getServerInfo(host?, timeoutMs?, signal?)` to `Client/src/lib/api.ts`,
  mirroring `getHealth` (`:633-669`) — explicit-host `SessionScope`,
  `ensureHttpProxy`, a timeout that disposes the scope, `assertCurrent` around
  every await, and a typed `ApiClientError` on a non-OK response. It reads
  `name`, `protocol_epoch` and `browser_client_enabled`; unknown fields are
  ignored so B7-15's additions do not break it. Keep the explicit-host shape
  (`host, timeoutMs, signal`) — B7-15 adapts to it, not the reverse
  (Decision 7, cross-plan collision 1). On the server, give `handleServerInfo`
  a **5 s response cache** mirroring `handleHealth`
  (`Server/api/router.go:610-614,657-693`): the preflight runs for every
  profile every 15 s, so the endpoint should not re-derive `cfg` per call. The
  response shape does not change.
- **Why:** row 1 — the endpoint has no caller, and the PRD names B7-12 as the
  first (`prd.md:269-281`). The cache is Decision 7 and matches the `health`
  precedent for an unauthenticated, rate-limit-exempt endpoint.
- **Validate:** `npm --prefix Client test -- tests/unit/api.test.ts` green, with
  cases for a 200, a non-OK status, and an aborted/timed-out probe; a case
  observed red with the epoch field renamed. `( cd Server && go test ./api/ )`
  green including a cache case observed red with the TTL set to 0. Commit.

### Task 2: The compatibility preflight (advisory)

- **Action:** derive a compatibility result from `getServerInfo`'s
  `protocol_epoch` versus `PROTOCOL_EPOCH`: `compatible` when equal,
  `client-older` when the server is newer (the client must update),
  `server-older` when the server is older (the server must update), and a
  distinct `unreachable` for a failed probe. Run it on the connect path beside
  the existing per-profile probe (`Client/src/main.ts:304-354`), fed from a
  per-host snapshot, and badge the profile row through `ServerPanel`'s
  `updateHealthStatus` (`ServerPanel.ts:264-289`). **The badge is advisory: it
  never disables Connect.** Do **not** change `getHealth`'s `/health` call.
- **Why the preflight is only advisory (Decision 1):** today `protocol_epoch ==
PROTOCOL_EPOCH` is exactly the server's rule, but the WS `auth_error` carries
  `min_epoch` and stays the authority; a future compatibility window can then
  only produce a wrong label, never a wrong refusal. Adding `min_epoch` to
  `server-info` becomes the trigger work for whoever adopts a window.
- **Gotcha (row 11):** `health.version` is `undefined` by design (C-2); do not
  "fix" it by adding a version to `/health`. The epoch, not a version, is what
  the preflight compares.
- **Gotcha:** an older server is not the same state as an unreachable one —
  both are "cannot connect", but only one names the operator as the side to
  update. Keep the four results distinct so the notice can say which.
- **Validate:** `Client/tests/unit/profiles.test.ts` (or the probe's own test)
  green over all four cases; the `client-older` case observed red with the
  comparison inverted. Commit.

### Task 3: The incompatible state — safe, actionable, exitable

- **Action:** add `Client/src/pages/connect-page/IncompatibleNotice.ts`, a
  small component rendered by `ConnectPage` (exposed as
  `showIncompatible(...)`), that states the requirement in the server's own
  terms — which side updates, with the two epoch numbers — and offers exactly
  two exits: **update** (mount the existing `UpdateNotifier`, exactly as
  `main.ts:782-793` does) and **leave** (dismiss or choose another server,
  leaving the profile list usable). **Reuse `uiStore.updateRequiredHost` for the
  host and carry the two epochs through it; do not add a second `ui.store` fact**
  (Decision 2). The credential stays retained on `"protocol_epoch"`
  (`main.ts:985-1001`); do not change that.
- **Where it appears (Decision 2):** the 15 s background probe
  (`main.ts:796-798`) only sets the row badge. The notice appears **only** for
  the host the user selects or attempts to connect to, and for the WS refusal
  (`dispatcher.ts:299-313`, which already has `server_epoch`/`min_epoch`). It
  must never appear for a background profile.
- **Deferrable (Decision 3):** the notice is dismissible and does not block
  another attempt; `ws.ts:323-329` already stops reconnecting on `auth_error`,
  so nothing needs a retry guard.
- **Why:** rows 9 and 10. When no compatible installer is offered the state must
  still state the requirement; and BPR-033 requires the incompatible case be
  "actionable non-destructive" with "user-deferral" passing
  (`beta-requirements-traceability-2026-08-23.md:82`).
- **Gotcha:** the existing generic error banner (`ConnectPage.ts:275-289`) still
  receives the server's `message`. The notice is the actionable state beside it,
  not a replacement; do not double-render the same sentence.
- **Validate:** `Client/tests/unit/connect-page.test.ts` green: the notice
  renders for `client-older`, stays hidden for `compatible`, stays hidden for a
  background-probe profile, `server-older` gets its own wording, the update exit
  mounts the notifier, and the leave exit clears the notice and leaves the
  server rows clickable. Each observed red when its branch is removed. Commit.

### Task 4: The connected update notice

- **Action:** verify the connected path already satisfies the first clause and
  pin it: `MainPage` mounts the notifier immediately (`:874-883`; the 3 s delay
  is inside `UpdateNotifier.mount`, `UpdateNotifier.ts:177-181`), a compatible
  newer release renders "Update vX available" with `[Update Now] [Later]`
  (`UpdateNotifier.ts:85-117`), "Later" is the user-deferral
  (`Client/tests/e2e/updater.spec.ts:106-115`). **On the connected path a 204 is
  correct silence and must NOT be turned into an incompatible state:** a 204
  there is either "already latest" (`client_update_test.go:120-152`) or the
  server withholding a release newer than itself — the latter protects this
  compatible client from updating into a refusal. A connected client is
  compatible by definition. Change `UpdateNotifier` only if a case genuinely
  requires it; its existing states are the oracle.
- **Gotcha:** `checkForUpdate` resolves a "nothing available" default on a
  failed check rather than rejecting (`Client/src/platform/desktop/updater.ts:66-69`,
  pinned by `updater.suite.ts:54`). Both an offline check and a 204 must remain
  "no notice", never "update required". Commit only tests here unless a real gap
  appears.
- **Validate:** `Client/tests/unit/update-notifier*.test.ts` and the e2e
  updater spec green; a new assertion that `offline`/`204` yields no notice,
  observed red if the incompatible path were wired in. Commit.

### Task 5: The browser scenario, docs and the evidence rows

- **Action:** add `Client/tests/e2e/incompatible-epoch.spec.ts` in the mocked
  shape (`updater.spec.ts` + `helpers.ts:443-455,997`): serve a `server-info`
  route with a newer `protocol_epoch` and, separately, inject an `auth_error`
  with `protocol_epoch_unsupported`, then assert the notice states which side
  updates, the update exit is present, and the state is exitable. Update
  `docs/architecture/ux/connection-and-auth.md` (the connect-page state beside
  the health table, `:44-56`) and `docs/architecture/ux/settings-and-admin.md`
  (the "update required" row beside the updater table, `:177-190`). Append the
  B7-12 evidence block to BPR-033's closure cell
  (`beta-requirements-traceability-2026-08-23.md:82`), naming the new tests and
  the existing ones that already cover BPR-033's tampered / missing / offline /
  rollback / deferral cases (`client_update_epoch_test.go:58-73`; the
  `manual_upgrade` tests; `updater.suite.ts:54`; `client_update_test.go:120-152`;
  `updater.spec.ts:106`). Add BG-07's B7 re-verify note
  (`repo-health-issue-register-2026-08-23.md:301`) pointing at the epoch tests
  at HEAD.
- **Gotcha (the parallel-plan rule):** the brief for B7-12 forbids the PRD and
  the roadmap; the traceability and register rows are not those. Edit **one row
  each**, quote the cell before and after in the PR description, and confirm
  B7-18 still owns the final reconciliation (`prd.md:373`).
- **Why:** row 15 (the owner's e2e decision) and row 13 (the evidence cell is
  empty today).
- **Validate:** `npx playwright test --config=playwright.config.ts
tests/e2e/incompatible-epoch.spec.ts` green; `npx tsc -p tsconfig.e2e.json
--noEmit` clean; prettier clean on the changed docs. Commit.

### Task 6: Final gate

- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  npx tsc -p Client/tsconfig.e2e.json --noEmit
  npx playwright test --config=Client/playwright.config.ts tests/e2e/incompatible-epoch.spec.ts
  ( cd Server && go test ./api/ )
  npm run check:docs
  npm run check:hygiene
  ```

  Then the `ci-check` skill. The PR touches `Client/src/**`, `Client/tests/**`
  and one `Server/api/router.go` cache (Decision 7), so expect the client jobs
  and the server job; no `Client/src-tauri/**` path is touched, so no
  `tauri-build`. Commit.

## Validation

```
npm --prefix Client test                          # count not lower than Task 0's
npm --prefix Client test -- tests/unit/api.test.ts tests/unit/profiles.test.ts tests/unit/connect-page.test.ts
npm --prefix Client test -- tests/unit/dispatcher.test.ts tests/unit/main.test.ts
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
npm --prefix Client run lint
npx tsc -p Client/tsconfig.e2e.json --noEmit
npx playwright test --config=Client/playwright.config.ts tests/e2e/incompatible-epoch.spec.ts
npm run check:docs
npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The preflight duplicates the WS refusal's detection and the two disagree on which side is older      | Medium     | Medium | One derivation: the notice takes its epochs from whichever source fired, and the comparison is a single pure function tested at both entry points (Task 2, Task 3)                                               |
| The preflight is treated as authoritative and a future window breaks a refusal                       | Low        | High   | Decision 1: the badge is advisory and never disables Connect; the WS `auth_error` (which carries `min_epoch`) stays authoritative                                                                                |
| The new `server-info` probe widens the connect path's traffic or adds a visible failure mode         | Medium     | Low    | It rides the existing per-profile probe (`main.ts:304-354`) with the same timeout/dispose shape as `getHealth`, plus the new 5 s server cache (Decision 7); a failed probe is `unreachable`, not an error banner |
| The incompatible state is presented as a dead end rather than exitable                               | Medium     | High   | Task 3's test asserts the leave exit leaves the server rows usable; BPR-033's "user-deferral" case is pinned explicitly                                                                                          |
| An offline server, or a 204 on the connected path, is misreported as "update required"               | Medium     | High   | Task 4: `unreachable`, `compatible` and any 204 all suppress the requirement; only a newer/older epoch from the preflight or the WS refusal raises it                                                            |
| `server-info`'s shape changes under B7-15 (`registration_mode`, retention) and breaks the new caller | Medium     | Low    | B7-12 lands first with the shared shape; `ServerInfoResponse` ignores unknown fields and reads only `name`/`protocol_epoch`; B7-15 adds fields and reads the snapshot (dependency note)                          |
| The background probe raises a notice for an unselected profile                                       | Medium     | Medium | Decision 2: the probe only badges the row; the notice appears only for the selected/attempted host or the WS refusal (Task 3)                                                                                    |
| B7-10 moves the dispatcher's epoch block and this plan's rebase drops it                             | Medium     | Medium | The block at `dispatcher.ts:299-313` is named as B7-12's; B7-12 re-points it and never moves it, and Task 0 re-runs the dispatcher oracle after any rebase                                                       |
| The 5 s `server-info` cache serves a stale epoch across a server upgrade                             | Low        | Low    | 5 s is the `healthCacheTTL` precedent; the WS refusal stays authoritative, so a stale label is corrected on the connect attempt                                                                                  |
| The traceability/register edit conflicts with a parallel B7 plan                                     | Low        | Low    | One row each, quoted before/after; B7-18 owns final reconciliation (`prd.md:373`)                                                                                                                                |

## Out of scope

- **A `min_epoch` field on `server-info`, and any other response-shape change.**
  Decision 1: no field; the preflight is advisory and the WS refusal stays
  authoritative. The only server edit is the 5 s `handleServerInfo` cache
  (Decision 7). `docs/api.md` and `protocol/schema.json` are untouched.
- **A wider epoch window** (`N-1`/`N-2`). B2-2 shipped one epoch by policy
  (`Server/ws/messages.go:385-388`); a window is a separate decision, and
  adopting one is when `min_epoch` returns to `server-info`.
- **B7-15's `registration_mode`/retention fields**, its `serverInfo.store.ts`
  and its server PR. B7-12 lands first with the shared `getServerInfo` shape and
  the per-host snapshot; B7-15 extends the type and reads the snapshot.
- **The updater's download/install internals** — B7-5 moved them behind
  `platform/desktop/updater.ts`; B7-12 does not change them.
- **B7-17's artifact matrix and smoke plumbing** — B7-12 only makes the update
  path testable (the one browser scenario).
- **Decomposing `dispatcher.ts`, `profiles.ts` or `api.ts`** — B7-10/B7-13.
- **Any browser/PWA surface** — B8, deferred post-beta.

## Decisions (resolved 2026-09-21)

The review of all five B7 plans answered the three open questions and found two
wrong claims plus one self-contradiction. All are applied above.

### Decision 1 — no `min_epoch` field; the preflight is advisory

**Decided:** option (a). `server-info` gains no field; the connect preflight
compares `protocol_epoch` with `PROTOCOL_EPOCH`, but it is **advisory** — it
badges the profile row and **never disables Connect**. The WS `auth_error`,
which already carries `min_epoch` (`Server/ws/messages.go:397-414`), stays
authoritative. → Task 2, Out of scope.

**Why:** today `protocol_epoch == PROTOCOL_EPOCH` is exactly the server's rule
(one accepted epoch, `Server/ws/messages.go:385-388`), now and after the next
bump. Making the preflight advisory means a future compatibility window can only
produce a wrong _label_, never a wrong refusal; adding `min_epoch` to
`server-info` is the trigger work for whoever adopts a window.

### Decision 2 — a dedicated `IncompatibleNotice`, shown for the selected host only

**Decided:** option (a), placed precisely. A dedicated
`IncompatibleNotice` on the connect page (not an `UpdateNotifier` state, which
would teach "install" to say "update the _server_"; not the generic
transient-error banner, which conflates a refusal with a session error). The 15 s
background probe (`main.ts:796-798`) **only badges the row**; the notice appears
only for the host the user selects or tries to connect to, and for the WS
refusal. **Reuse `uiStore.updateRequiredHost` plus the two epochs; no second
`ui.store` fact.** → Task 3, File table (`ui.store.ts`).

### Decision 3 — deferrable

**Decided:** option (a). A connected client is compatible by definition, so the
state is effectively pre-login; after a refusal `ws.ts:323-329` stops
reconnecting on `auth_error` and there is nothing to guard. The notice is
dismissible and does not block another attempt. → Task 3.

### Decision 4 — row 10 and the Summary corrected

**Corrected:** `client_update.go:62-70` withholds releases whose epoch is
**newer than the server's** — the release a refused, _older_ client does **not**
need. The compatible release (epoch equal to the server's) is still offered on
the refusal path, so silence there comes only from a missing or unverifiable
manifest, or a missing target asset (`client_update.go:76-82`). The Summary and
Verify row 10 now say this. → Summary, Verify row 10.

### Decision 5 — Task 4's connected-path assertion dropped

**Corrected:** a 204 on the connected path is _correct_ silence: "already
latest", or the server withholding a newer release to protect this compatible
client from updating into a refusal. It must **not** render the incompatible
state. Task 4 now asserts only "offline or 204 → no notice". → Task 4.

### Decision 6 — the 3 s delay is inside `UpdateNotifier.mount`

**Corrected:** `MainPage` mounts the notifier immediately (`MainPage.ts:874-883`);
the 3 s delay is inside `UpdateNotifier.mount` (`UpdateNotifier.ts:177-181`).
→ Summary, Verify row 8.

### Decision 7 — `getServerInfo` keeps the explicit-host shape, with a per-host snapshot and a 5 s server cache

**Decided:** `getServerInfo(host, timeoutMs, signal)` keeps the explicit-host
shape from the `getHealth` template; a per-host snapshot is fed by
`runHealthChecks` (`main.ts:304-354`). The server gets a **5 s response cache**
on `handleServerInfo`, mirroring the `healthCacheTTL` precedent
(`Server/api/router.go:610-614`). **B7-12 lands before B7-15 and before B7-10:**
B7-15 adds `registration_mode?`/`retention?` to `ServerInfoResponse` and reads
the snapshot (cross-plan collision 1); B7-10 decomposes `dispatcher.ts` only
after B7-12's epoch block lands (collision 8). → Task 1, Task 2, dependency
notes.

## Acceptance

- [ ] `GET /api/v1/server-info` has a client caller (`getServerInfo`), with
      `name`, `protocol_epoch` and `browser_client_enabled`; unknown fields are
      tolerated; the endpoint carries a 5 s response cache
- [ ] The connect path derives compatibility from the server's epoch and
      distinguishes `compatible`, `client-older`, `server-older` and
      `unreachable` — **advisory only**: it badges the row and never disables
      Connect
- [ ] An incompatible epoch produces an actionable `IncompatibleNotice` naming
      which side updates, **only for the selected/attempted host or the WS
      refusal** — never for a background profile — and it appears even when no
      installer is offered (rows 9/10)
- [ ] The state is exitable (deferrable): the update exit mounts the notifier;
      the leave exit dismisses it and leaves the server list usable; the
      credential is still retained on `"protocol_epoch"`
- [ ] `uiStore.updateRequiredHost` is reused with the two epochs; no second
      `ui.store` fact is added
- [ ] A connected user on a compatible server still gets the update notice with
      `[Update Now] [Later]`; an offline check **and** a 204 (already-latest or
      newer-than-server) both yield no notice
- [ ] One browser scenario (`tests/e2e/incompatible-epoch.spec.ts`) exercises
      the flow in the existing `client-e2e` job (row 15)
- [ ] New assertions were observed red before being trusted green (the epoch
      comparison inverted; the leave exit removed)
- [ ] `docs/architecture/ux/connection-and-auth.md` and
      `settings-and-admin.md` describe the new state; BPR-033's evidence cell
      (`beta-requirements-traceability-2026-08-23.md:82`) and BG-07's B7
      re-verify note (`repo-health-issue-register-2026-08-23.md:301`) are
      updated, one row each
- [ ] The **only** server change is the 5 s `handleServerInfo` cache; no
      `min_epoch` field, no response-shape change, no `protocol/schema.json`
      change, no new `#[tauri::command]`; the contracts counts test is green
      (21 / 30 / 35)
- [ ] `npm --prefix Client test` count is not lower than Task 0's;
      `typecheck`, `typecheck:build`, `lint`, `check:docs`, `check:hygiene` and
      the `ci-check` skill are green
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle
      ceiling not raised
