# Plan: B7-13 — One connection, isolated profiles, quick switch

> **Milestone:** B7-13 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-13-one-connection-isolated-profiles`.
> **Worktree:** `.claude/worktrees/b7-13`.
> **Drafted:** 2026-09-21. **Base commit:** `639d5bb3` (`dev`).

## Summary

The PRD outcome has three clauses
(`b7-shared-client-platform-desktop-parity.prd.md:325`). Two are already true
in the tree and simply unproven; one has a real gap.

1. **"Exactly one live connection and one live media session at a time."** True
   by construction: the app builds exactly one socket client
   (`Client/src/main.ts:141`; `createWsClient` is defined at `lib/ws.ts:163` and
   instantiated nowhere else) and that client takes exactly one transport
   (`lib/ws.ts:167`; `desktop.socket.create()` has no other caller), whose
   contract says so in its own words (`platform/contracts/socket.ts:23-27`);
   the Rust proxy displaces a prior handshake as "superseded by a newer
   connection" (`platform/desktop/socket.ts:210-215`). The voice session is a
   module singleton holding at most one room
   (`lib/livekitSession.ts:1563`, state union `:95-117`). **Nothing measures
   it.** `git grep` for a live-transport or live-room count in `Client/tests`
   is empty (Verify row 14), which is exactly the gap the PRD records: "Profile
   UI exists; no BPR-034 instrumented evidence test"
   (`b7-shared-client-platform-desktop-parity.prd.md:186`), against BPR-034's
   evidence clause "Instrumented unit/E2E tests prove only one live server
   transport/media session exists"
   (`docs/plans/beta-requirements-traceability-2026-08-23.md:83`).

2. **"Switching profiles tears the old one down completely."** The switch path
   is `clearAuth()` from the quick-switch overlay
   (`pages/main-page/SidebarArea.ts:793-795`, target consumed at
   `main.ts:854-864`). `clearAuth` resets the domain stores and the notification
   audio (`stores/auth.store.ts:109-149`), and the `isAuthenticated` subscriber
   disconnects the socket (`main.ts:982`) and navigates to the connect page
   (`:1002`), whose `renderPage` destroys `MainPage` — calling
   `voiceCleanupAll()` (`MainPage.ts:950`) and clearing the attachment caches
   (`:958`). That is structurally complete for transport, media and stores, but
   no test drives login → switch → login end to end and asserts nothing from
   the first profile survives.

3. **"Isolates the new one's credentials and cache."** Credentials are keyed by
   host alone (`Client/src-tauri/src/credentials.rs:144`) and identity keys by
   `userId@host` (`lib/identity.ts:136-138`), so two _different servers_ are
   isolated. The **cache is not**: `memoryCache`, the durable IndexedDB store
   `owncord-image-cache` and `mediaObjectUrls` are keyed by bare URL
   (`message-list/attachments.ts:141`, `:235`/`:279`/`:298`, `:394`), the
   durable store is never evicted by the app — the only delete is the manual
   Settings action (`settings/AdvancedTab.ts:304`) — and `clearAuth` clears no
   image cache at all. `community-services.md` states the consequence outright:
   "IndexedDB survives app restart, account switch and server switch, and
   nothing in the app evicts it"
   (`docs/architecture/community-services.md:315`). **This is the milestone's
   one real defect**, and it is the cache half of clause 3.

**The B7-16 hand-off is real at this base.** B7-16's Decision 4 split cache
ownership by content, not by age: B7-16 owns every cache of _external_ content,
B7-13 owns every cache of _server_ content (`.claude/plans/b7-16-external-content-broker.plan.md:99-111`,
Decision 4 `:633-653`). B7-16's implementation is the base commit itself
(`639d5bb3`), and `fetchImageAsDataUrl` now routes external URLs to the broker
while `fetchServerFile` refuses them (`attachments.ts:321-322`, `:219-220`), so
`memoryCache`, IndexedDB and `mediaObjectUrls` hold **server content only**. That
is what makes this milestone's cache work a clean profile-isolation problem
rather than a shared-ownership argument. B7-13 does not touch the broker or the
external caches.

**What this milestone delivers:** the instrumented evidence BPR-034 requires
(unit transport/media invariants plus one Playwright scenario, per the
2026-09-19 browser-smoke decision at `prd.md:390`), the cache-isolation fix,
the `community-services.md` correction it forces, and the evidence row. It
does not re-decide the cache split, does not add a pipeline, and does not
change the credential store.

## Verify before you implement

Every row was re-derived at `639d5bb3` by the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                                | How to re-check                                                                                                                                           | Verified  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | The socket client is instantiated exactly once; `lib/ws.ts` only defines the factory                                                 | `git grep -n "createWsClient()" -- Client/src` → `lib/ws.ts:163`, `main.ts:141`                                                                           | yes       |
| 2   | Exactly one transport is created, by that one client                                                                                 | `git grep -n "socket.create()" -- Client/src` → `lib/ws.ts:167` only                                                                                      | yes       |
| 3   | `disconnect()` bumps a generation, cancels reconnect and stops the heartbeat                                                         | `lib/ws.ts:559-583` (`wsGeneration++` `:565`, `intentionalClose` `:566`, `transport.disconnect` `:555`/`:572`)                                            | yes       |
| 4   | The native proxy refuses a displaced handshake ("superseded by a newer connection"); the factory is one-transport-per-call by design | `platform/desktop/socket.ts:210-215`; `platform/contracts/socket.ts:23-27`                                                                                | yes       |
| 5   | Logout disconnects the socket and navigates to the connect page                                                                      | `main.ts:948` subscriber, `:982` `ws.disconnect()`, `:1002` `navigate("connect")`                                                                         | yes       |
| 6   | The LiveKit session is a module singleton holding at most one room, and reports liveness for connecting/reconnecting/connected       | `lib/livekitSession.ts:1563`; state union `:95-117`; `hasActiveSession` `:1546-1548`                                                                      | yes       |
| 7   | Voice teardown exists and `MainPage` calls the deep `cleanupAll`                                                                     | `lib/livekitSession.ts:1257` (`leaveVoice`), `:1310` (`cleanupAll`); `MainPage.ts:32`,`:950` (`voiceCleanupAll()`)                                        | yes       |
| 8   | Quick switch sets a sessionStorage target and calls `clearAuth()`; the target is consumed on the connect page                        | `pages/main-page/SidebarArea.ts:793-795`; `main.ts:854-864`                                                                                               | yes       |
| 9   | `clearAuth` resets voice/messages/channels/blocks stores and the notification AudioContext, and imports no image cache               | `stores/auth.store.ts:109-149`; `git grep -n "attachments" Client/src/stores/auth.store.ts` → none                                                        | yes       |
| 10  | The image caches are keyed by bare URL, not by profile, account or server                                                            | `message-list/attachments.ts:141` (`memoryCache`), `:235` (`IDB_NAME`), `:279`/`:298` (get/put by url), `:394`/`:427` (`mediaObjectUrls`)                 | yes       |
| 11  | The durable IndexedDB store is never evicted by the app; the only delete is the manual Settings action                               | `settings/AdvancedTab.ts:304` (`indexedDB.deleteDatabase("owncord-image-cache")`); `docs/architecture/community-services.md:296`,`:315` (data class S2-f) | yes       |
| 12  | External content is already broker-owned at this base; the server caches cannot receive external bytes                               | `attachments.ts:321-322` (`isExternalUrl` → broker), `:219-220` (`fetchServerFile` throws for external), `:501` (`clearExternalImageCache`)               | yes       |
| 13  | Credentials are keyed by host alone; identity keys by `userId@host`                                                                  | `Client/src-tauri/src/credentials.rs:144`; `lib/identity.ts:136-138`                                                                                      | yes       |
| 14  | No instrumented "exactly one live transport/media session" proof exists anywhere in the client tests                                 | `git grep -n "exactly one live\|live transport\|transportCount\|liveSessionCount" -- Client/tests` → no output                                            | confirmed |
| 15  | The platform-contract counts test pins 21 importers / 30 invoke names / 35 handlers and fails on drift                               | `Client/tests/unit/platform-contracts-counts.test.ts:57-59`                                                                                               | yes       |
| 16  | The browser-smoke evidence is one e2e scenario per flow in the existing client-e2e jobs — no new pipeline                            | `prd.md:390` (2026-09-19 decision); `.github/workflows/ci.yml:801` (`client-e2e`), `:906` (`client-e2e-parity`)                                           | yes       |
| 17  | BPR-034's evidence clause and the register's "no background aggregation" boundary                                                    | `beta-requirements-traceability-2026-08-23.md:83`; `repo-health-issue-register-2026-08-23.md:355`                                                         | yes       |
| 18  | The client suite baseline this milestone must not drop                                                                               | npm --prefix Client test → 242 files, 5734 passed \| 140 expected fail; platform subset 29 files, 202 passed \| 140 expected fail                         | measured  |

**Row 14 is the one that changes the milestone.** The connection and media
singletons already deliver clauses 1 and 2 structurally; the milestone's work
is to _instrument_ them and to _fix_ the cache half of clause 3. Do not rebuild
a single-connection mechanism that already exists.

## Patterns to Mirror

- **Instrument an ordering, do not add a production counter.** `tests/unit/connection.model.test.ts:1-36`
  drives the REAL `createWsClient()` + `wireDispatcher()` into the real stores
  and mocks only the Tauri IPC (`./helpers/ws-mocks`) and the media layer. The
  isolation test copies that harness and counts transports from the mock, so
  nothing is added to `lib/ws.ts` or `lib/livekitSession.ts` — both are B7-9's
  and B7-10's decomposition targets and a counter there would collide.
- **Scope a module-global to the connection on mount.** `MainPage.ts:159-169`
  already does exactly this for other module state: `setServerHost`,
  `setLiveKitServerHost`, `setChannelMutesHost`, `setNsfwGateHost`,
  `setAudioVolumeHost`. The server-content cache scope follows the same shape.
- **Partition by scope + epoch.** B7-16's broker cache is the precedent
  (`attachments.ts:481-485`, `externalPartition()` and `externalEpoch`); the
  server caches mirror it with a profile/server scope instead of a host string,
  rather than inventing a new mechanism.
- **Lifecycle primitives before ad-hoc teardown.** `lib/disposable.ts` and
  `lib/sessionScope.ts` exist for this; the PRD names them as satisfied
  preconditions (`prd.md:295-297`) and B7-11 extends them. Reuse, do not add a
  third.
- **Prove the assertion can fail.** B7-3's null-subject probe and B7-7's
  "prove a gate can fail" both require the new isolation assertion be observed
  **red** before it is trusted green. Task 3 exists to produce that red.
- **Reuse the e2e Tauri mock, count IPC rather than DOM.** `tests/e2e/helpers.ts:515`,`:563`
  records every IPC call in `window.__invokeLog`, and `:653-690` makes
  `ws_connect`/`ws_disconnect` no-ops; `logout-flow.spec.ts` is the closest
  existing journey.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                      | Change                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Client/tests/unit/session-isolation.test.ts`             | new: transport invariant, switch-teardown evidence, credential isolation                    |
| `Client/tests/unit/livekit-session.test.ts`               | extend: at most one live room across a profile switch                                       |
| `Client/tests/unit/attachments-cache.test.ts`             | extend: cross-profile cache isolation (written red in Task 3, green in Task 4)              |
| `Client/src/components/message-list/attachments.ts`       | scope `memoryCache`, the IndexedDB key and `mediaObjectUrls` by profile/server; prune scope |
| `Client/src/pages/MainPage.ts`                            | set the cache scope on mount beside the existing host setters (`:159-169`)                  |
| `Client/src/stores/auth.store.ts`                         | expire/clear the previous scope in `clearAuth` so isolation survives a page-teardown gap    |
| `Client/tests/e2e/profile-switch.spec.ts`                 | new: one scenario — switch tears down A, isolates B, preserves the profile list             |
| `docs/architecture/community-services.md`                 | the S2-f "Delete"/"Retention" cells (`:296`,`:315`): the store is now scoped and pruned     |
| `docs/plans/beta-requirements-traceability-2026-08-23.md` | the BPR-034 evidence row (`:83`) — subject to Open Question 3                               |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, the PRD, the register,
the roadmap, `CHANGELOG.md`, or any status row. No generated file changes: this
milestone adds no native command, so the platform counts (Verify row 15) stay
21 / 30 / 35.

## Tasks

Commit after every task — conventional subject, scope `b7-13`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-13-one-connection-isolated-profiles`
  at `639d5bb3` or later; run the Verify rows that are one-liners (1, 2, 8, 9,
  10, 11, 13, 14, 15) and record their output. Record `npm --prefix Client test`
  totals **at your HEAD** — the rows 18 figures are a floor to re-measure, not a
  constant to assert.
- **Validate:** the client suite is green; record the count — it must never drop
  from what Task 0 measured.

### Task 1: The one-live-transport invariant

- **Action:** add `tests/unit/session-isolation.test.ts` mirroring
  `main.test.ts`'s harness (mock `@tauri-apps/api/core` `invoke` and
  `@tauri-apps/api/event` `listen` through `./helpers/ws-mocks`, mock
  `@lib/livekitSession`, `@lib/notifications`, `@lib/screenShare`, `@lib/toast`
  as `connection.model.test.ts` does) and drive login A → `auth_ok` → `ready` →
  quick-switch → login B. From the mock's invoke log, assert: at every observed
  step at most one transport is live; while authenticated exactly one is; the
  switch produces `ws_disconnect` before the next `ws_connect`; and no third
  connection is opened while authenticated.
- **Why:** BPR-034's first clause (`beta-requirements-traceability-2026-08-23.md:83`),
  which row 14 proves nothing currently checks.
- **Gotcha:** count at the seam (the mocked `ws_connect`/`ws_disconnect` and
  `desktop.socket.create`), never by instrumenting `lib/ws.ts`. B7-9/B7-10
  decompose `livekitSession.ts` and the dispatcher/stores; a production counter
  there is a guaranteed conflict for a test-only need.
- **Validate:** `npm --prefix Client test -- tests/unit/session-isolation.test.ts`
  green, and observed **red** after a temporary second `ws.connect` is issued
  with no intervening switch. Commit.

### Task 2: The one-live-media-session invariant

- **Action:** extend `tests/unit/livekit-session.test.ts` (it already mocks
  `livekit-client`'s `Room` and asserts `leaveVoice`/`cleanupAll` behaviour,
  `:30-56`, `:671-701`, `:1901`) with a cross-session case: join voice, tear
  down the session the way a profile switch does (`cleanupAll`, the same call
  `MainPage.destroy` makes), then join again, asserting exactly one live `Room`
  at every step and that the first room was disconnected before the second was
  constructed. Assert the voice liveness predicate is false between the two
  (`livekitSession.ts:1546-1548`).
- **Why:** the media half of BPR-034's first clause; the singleton already
  enforces one room in state, and this pins that a switch cannot leak a live
  room into the next profile.
- **Gotcha:** voice sessions are **superseded, not cancelled** (`Client/CLAUDE.md`,
  Gotchas): the transient coexistence of rooms during a retry is deliberate and
  `disconnectSupersededLocalRoom` (`livekitSession.ts:749`) scopes cleanup to the
  superseded attempt. Assert on the _live_ room, never by forbidding a second
  construction during a supersession.
- **Validate:** the extended suite green; observed **red** when `cleanupAll` is
  skipped between the two joins. Commit.

### Task 3: The switch-teardown evidence, and the red cache assertion

- **Action:** extend `tests/unit/session-isolation.test.ts` with the teardown
  half: after a switch, assert the domain stores are reset (`messages`,
  `channels`, `blocks`, `voice` — the resets `clearAuth` performs at
  `auth.store.ts:133-136`), the notification AudioContext was cleaned up, no
  transport and no room remain, and the credential for the old host was not
  readable for the new host. Then extend `tests/unit/attachments-cache.test.ts`
  with the assertion this milestone exists to fix: a second profile on a
  _different server_ must not be served the first profile's cached server image
  from `memoryCache` or IndexedDB, and the durable store must not retain the
  first profile's entries after a switch.
- **Why:** the second and third BPR-034 clauses. The cache half is expected to
  be **RED** at this commit: the caches are keyed by bare URL
  (`attachments.ts:141`,`:235`,`:394`) and `clearAuth` clears none of them
  (`auth.store.ts:109-149`). The red is the reproduced defect Task 4 fixes, in
  the same shape as a written-first contract test.
- **Gotcha:** this file already mocks `@tauri-apps/plugin-http` and stubs
  `indexedDB` with a `putSpy` (`attachments-cache.test.ts:3-60`); assert through
  `putSpy`/the mocked fetch rather than reaching into the module.
- **Validate:** the transport/store/credential assertions green; the cache
  assertion observed **red**, and record the exact URL and cache it leaked
  through. Commit.

### Task 4: Scope the server-content caches by profile

- **Action:** give `memoryCache`, the IndexedDB key and `mediaObjectUrls` a
  profile/server scope — host plus account, the thing that actually differs
  between two profiles — mirroring `externalPartition()`'s scope-plus-epoch
  shape (`attachments.ts:481-485`). Set the scope on `MainPage` mount beside the
  existing host setters (`MainPage.ts:159-169`) and expire/clear the previous
  scope in `clearAuth` (`auth.store.ts:109`) so isolation does not depend on
  `MainPage.destroy` running. Prune the previous profile's durable entries on a
  scope change.
- **Why:** closes the red from Task 3 and the third BPR-034 clause. It is the
  server-content half of B7-16's Decision 4 hand-off
  (`.claude/plans/b7-16-external-content-broker.plan.md:104-111`).
- **Gotcha:** the durable store is data class S2-f and the doc says nothing
  evicts it (`community-services.md:315`); the fix changes that, so Task 6 must
  update the doc in the same PR. Do **not** clear the _current_ profile's entries
  — the cache is still meant to survive a restart for the same profile. The
  manual full clear (`AdvancedTab.ts:304`) stays.
- **Validate:** Task 3's cache assertion green; `attachments-cache.test.ts`
  green; observed **red** with the scope reverted to a bare URL. Commit.

### Task 5: The profile-switch e2e scenario

- **Action:** add `tests/e2e/profile-switch.spec.ts` with one scenario: seed two
  profiles (`mockTauriFullSession`'s `get_settings` seed,
  `tests/e2e/helpers.ts:461-463`,`:852-885`), connect to A, open the quick-switch
  overlay (`QuickSwitchOverlay.ts:40`,`:73` — `data-testid="quick-switch-overlay"`
  and `"server-item"`), switch to B, and assert the app returns to the connect
  page, the profile list still shows both servers (profiles are preserved), and
  the `window.__invokeLog` shows A's `ws_disconnect` before B's `ws_connect` with
  no second live connection. No new pipeline and no new required check.
- **Why:** the PRD's own browser-smoke decision — "the existing default
  Playwright config plus one scenario per B7-12/13/14/15 flow, run in the
  existing `client-e2e` job" (`prd.md:390`).
- **Gotcha:** a spec under `Client/tests/e2e/` selects the `harness` capability
  (`scripts/ci-select.mjs:113`), so CI widens the dev run to the full suite by
  itself; the smoke `testMatch` list (`playwright.config.smoke.ts:39-59`) does
  not need editing.
- **Validate:** `npx playwright test tests/e2e/profile-switch.spec.ts` green
  locally. Commit.

### Task 6: The evidence row, the S2-f doc and the final gate

- **Action:** add the BPR-034 evidence to
  `docs/plans/beta-requirements-traceability-2026-08-23.md`'s row (`:83`) naming
  the new unit and e2e tests — subject to Open Question 3. Update
  `docs/architecture/community-services.md`'s S2-f cells (`:296` "Delete" and
  `:315` "Retention default") to state that the durable store is now scoped to
  the profile and pruned on a profile switch, naming the code that does it. Keep
  the three table headers and the `Tested at` cell intact —
  `TestCommunityServicesDocIsCurrent` (`Server/migrations/community_services_doc_test.go:91`)
  fails on an emptied or evasive cell.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  npm --prefix Client test -- tests/unit/platform-contracts-counts.test.ts
  npm run check:docs && npm run check:hygiene
  npx prettier --check .claude/plans/b7-13-one-connection-isolated-profiles.plan.md
  ```

  Commit.

## Validation

```
npm --prefix Client test                          # count not lower than Task 0's
npm --prefix Client test -- tests/unit/session-isolation.test.ts
npm --prefix Client test -- tests/unit/livekit-session.test.ts
npm --prefix Client test -- tests/unit/attachments-cache.test.ts
npm --prefix Client run typecheck
npm --prefix Client run typecheck:build
npm --prefix Client run lint                      # 0 warnings, cycles not above the ceiling
npx playwright test tests/e2e/profile-switch.spec.ts
npm run check:docs && npm run check:hygiene
npx prettier --check .claude/plans/b7-13-one-connection-isolated-profiles.plan.md
# → then the ci-check skill; this PR touches Client/src/** and Client/tests/e2e/**,
#   so expect the client, browser and native jobs
```

## Risks

| Risk                                                                                   | Likelihood | Impact | Mitigation                                                                                                      |
| -------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Instrumentation drifts into production code and collides with B7-9/B7-10 decomposition | Medium     | Medium | Counts live only in tests, at the mocked IPC seam; `lib/ws.ts` and `lib/livekitSession.ts` are not instrumented |
| Scoping the durable cache wipes the current profile's cross-restart cache              | Medium     | Medium | Key by profile/server scope and prune only the previous scope; the same profile keeps its entries               |
| The switch's async `leaveVoice` races the new session and a room outlives the teardown | Low        | High   | Supersession guards stay untouched; Task 2 asserts the live-room count, not the construct count                 |
| The e2e scenario flakes on overlay/auto-login timing                                   | Medium     | Low    | Reuse the `logout-flow` fixtures and count `__invokeLog` IPC rather than asserting on DOM timing                |
| Editing `community-services.md` trips `TestCommunityServicesDocIsCurrent`              | Low        | Medium | Keep the table headers and a concrete `Tested at` cell; run the test before committing                          |
| `MainPage.ts` / `auth.store.ts` are also B7-11's lifecycle territory                   | Medium     | Low    | Different functions in the same files; keep both edits and re-run on rebase                                     |
| The traceability row conflicts with B7-12/14/15's parallel evidence rows               | Medium     | Low    | One row only, or defer to B7-18 — Open Question 3                                                               |
| The credential store is host-keyed, so two profiles on one host share a secret         | Low        | Medium | Prove cross-server isolation only; record the caveat — Open Question 1                                          |

## Out of scope

- Any browser adapter, `build:web`, PWA or mobile — B8, deferred
  (`prd.md:253-254`).
- Re-keying the credential store by username, and its migration — Open
  Question 1 decides; it is a credential-store change, not this milestone's.
- Decomposing `livekitSession.ts` (B7-9), `dispatcher.ts`/`messages.store.ts`
  (B7-10), or moving timers and listeners onto the lifecycle primitives
  (B7-11).
- The device/session list, new-login notice and revocation UI — B7-14, BPR-035
  (`prd.md:326`).
- The external-content broker and every external cache — B7-16, landed at this
  base.
- A new CI job, required check or evidence pipeline — the 2026-09-19 decision
  runs the new scenario in the existing `client-e2e` job (`prd.md:390`).
- The PRD, the register and the roadmap — the orchestrator's, and B7-18
  reconciles.

## Open questions for the owner

- [ ] **Credential isolation across two profiles on one host.** Credentials are
      keyed by host alone (`Client/src-tauri/src/credentials.rs:144`), so two
      profiles for the same server (different accounts) share one stored secret,
      while two servers are isolated. Option A (recommended): keep host-keying,
      prove cross-**server** isolation, and record the same-host caveat — the
      BPR-034 clause is "credentials never cross", which host-keying already meets
      for different servers, and re-keying is a Rust credential-store change with
      a migration and its own security review. Option B: re-key to host +
      username now, migrating stored secrets, which changes the `CredentialStore`
      contract and both credential suites. **Recommendation: A.**
- [ ] **What happens to the durable store on a profile switch.** It is data
      class S2-f and never evicted today (`community-services.md:315`). Option A
      (recommended): scope the key by profile/server and prune the _previous_
      profile's entries on a switch, keeping the current profile's entries across
      restarts. Option B: delete the whole database on every switch — simplest,
      but throws away the current profile's cache too. Option C: namespace and
      let old scopes persist — isolated on read but the old server's bytes stay
      on disk, which is the privacy defect the doc records. **Recommendation:
      A.**
- [ ] **Where the BPR-034 evidence row is written.** The PRD records B7-13 as
      closing "BPR-034 evidence" (`prd.md:374`), but B7-12, B7-14 and B7-15 are
      being planned in parallel and their traceability rows
      (`beta-requirements-traceability-2026-08-23.md:82-84`) are adjacent, so all
      four would edit near-neighbours of the same table. Option A (recommended):
      B7-13 adds only its own one row now, as B6-15/B6-16 did. Option B: no
      milestone touches the traceability doc and B7-18 records all four rows
      after the parallel plans land. **Recommendation: A**, unless the owner
      prefers the conflict-free batch.

## Acceptance

- [ ] An instrumented unit test proves at most one live transport and, while in
      voice, exactly one live `Room`, across a login → quick-switch → login
      sequence; each assertion observed red before green
- [ ] A test proves a profile switch resets the domain stores and notification
      audio and leaves no transport, room or credential from the prior profile
- [ ] The server-content caches (`memoryCache`, the durable IndexedDB store,
      `mediaObjectUrls`) are scoped to the profile/server, the previous scope is
      pruned on a switch, and a second profile is never served the first's
      cached bytes; Task 3 observed red before Task 4 fixed it
- [ ] One Playwright scenario in the existing `client-e2e` job switches
      profiles, tears A down, isolates B, and preserves the profile list — no new
      pipeline or required check
- [ ] `docs/architecture/community-services.md`'s S2-f cells state the scoping
      and pruning, and `TestCommunityServicesDocIsCurrent` is green
- [ ] The BPR-034 evidence row is recorded (Open Question 3) or explicitly
      deferred to B7-18
- [ ] `npm --prefix Client test` count is not lower than Task 0's; `typecheck`,
      `typecheck:build`, `lint`, `check:docs`, `check:hygiene` and the `ci-check`
      skill are green
- [ ] No native command is added, so the platform counts stay 21 / 30 / 35 and
      the counts test is untouched
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle
      ceiling not raised
