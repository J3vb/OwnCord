# Plan: B7-5 — Adapter migration, media and shell

> **Milestone:** B7-5 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-5-adapter-media-shell`.
> **Worktree:** `.claude/worktrees/b7-5`.
> **Drafted:** 2026-09-20. **Base commit:** `3634cb0d` (`dev`).

## Summary

B7-4 moved eight capabilities behind the seam and left the rest where they were.
At `3634cb0d`, eleven production files under `Client/src/` still import
`@tauri-apps` outside `platform/desktop/` (`git grep` row 1 below), and nine of
the seventeen contract files still have at least one unbound `Platform` member —
ten members in all, since `nativeProxies` and `updater` each hold two:

| Contract row              | Capability in the PRD outcome         | Seam today                                                        | Suite today                      | This milestone must                  |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| `deepLinks.ts`            | deep links                            | exported `initDeepLinks` (`lib/deep-link.ts:121`)                 | **yes** (`deepLinks.suite.ts`)   | move; re-bind the suite to `desktop` |
| `pushToTalk.ts`           | push-to-talk                          | four exports (`lib/ptt.ts:167,330,372,429`)                       | **yes**                          | move; re-bind the suite to `desktop` |
| `updater.ts` (Updater)    | updater                               | three exports (`lib/updater.ts:38,67,89`)                         | **yes**                          | move; re-bind the suite to `desktop` |
| `nativeProxies.ts` (HTTP) | LiveKit's native proxy (HTTP half)    | exported `ensureHttpProxy` (`lib/httpProxy.ts:33`)                | **yes** (`ensureHttpProxy` half) | move; re-bind the suite to `desktop` |
| `nativeProxies.ts` (LKV)  | LiveKit's native proxy (LiveKit half) | class `LiveKitUrlResolver` (`lib/livekitUrlResolver.ts:9`)        | **no**                           | **write the suite first**, then move |
| `notifications.ts`        | notifications                         | private helpers (`lib/notifications.ts:145,180`)                  | **no**                           | **write the suite first**, then move |
| `window.ts`               | window state                          | private `initWindowState` orchestration (`:57`)                   | **no**                           | **write the suite first**, then move |
| `updater.ts` (Autostart)  | updater (autostart half)              | private `buildAutostartRow` (`settings/AdvancedTab.ts:218`)       | **no**                           | **write the suite first**, then move |
| `opener.ts`               | the shell opener                      | private `openAdminPanel` body (`lib/admin-panel.ts:38`)           | **no**                           | **write the suite first**, then move |
| `appMetadata.ts`          | app metadata                          | inline in a DOM builder (`settings/LogsTab.ts:135`)               | **no**                           | **write the suite first**, then move |
| `devTools.ts`             | (not named)                           | inline in two event listeners (`main.ts:86`, `AdvancedTab.ts:69`) | **no**                           | **write the suite first**, then move |

The oracle is the same one B7-4 used, and the reason this step is mechanical
rather than exploratory. Each existing suite states its own contract
(`deepLinks.legacy.test.ts:1-4`): "B7-5 re-runs `deepLinks.suite.ts` against
`platform/desktop` instead of this file." **Do not weaken a suite to make a move
land.** If a suite goes red, the move is wrong, not the suite.

**The asymmetry that shapes the task list.** Four of the eleven rows above have
a suite today (`deepLinks`, `pushToTalk`, the `AppUpdater` half of `updater`,
and the `ensureHttpProxy` half of `nativeProxies`). The other seven are
`no-seam` or `no-suite`: their native call is buried in a private function or a
class, so the suite must be written against a seam lifted in place first, proven
falsifiable, and only then re-bound to `desktop`. Writing it against the new
code instead proves nothing — it would assert whatever the new code happens to
do.

**Media/devices is not a native capability.** The PRD outcome names it, but
B7-3's plan recorded the correction (`b7-3-platform-contracts-desktop-shell.plan.md:59`):
"No `@tauri-apps` import exists for media devices". Every media-device call site
is the Web API `navigator.mediaDevices` (`lib/deviceManager.ts:102`,
`components/settings/VoiceAudioTab.ts:367,468,515`,
`lib/connectionDiagnostics.ts:42`), which needs no Tauri seam. This milestone
records that finding; it does not invent a contract for it. See Open Question 2.

## Verify before you implement

Every row was checked at `3634cb0d`. If a row is false at your HEAD, **stop
that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                        | How to re-check                                                                                                                                                                  | Verified |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | 19 files under `Client/src/` import `@tauri-apps/*`; 11 of them outside `platform/desktop/`                                  | `git grep -l "@tauri-apps" -- 'Client/src/**' \| wc -l` → 19; same piped through `grep -v platform/desktop` → 11                                                                 | yes      |
| 2   | 5 of those 11 have a **static** import; the eslint rule only sees those, and they are the 5 `ignores` entries                | `grep -rln "^import .*@tauri-apps" Client/src --include="*.ts" \| grep -v platform/desktop` → `AdvancedTab.ts`, `main.ts`, `httpProxy.ts`, `livekitUrlResolver.ts`, `updater.ts` | yes      |
| 3   | 28 distinct `invoke` names by the doc's recipe; the tree calls 29 (nested-generic blind spot, `platform-contracts.md:83-86`) | `git grep -hoE '(tauriInvoke\|invoke)(<[^>]*>)?\(\s*"[a-z_]+"' -- 'Client/src/**' \| sed … \| sort -u \| wc -l` → 28                                                             | yes      |
| 4   | 27 files under `Client/src/platform/`: 18 contracts (17 + `index.ts`) and 9 desktop files (8 + `index.ts`)                   | `find Client/src/platform -type f \| wc -l` → 27; split across `contracts/` and `desktop/`                                                                                       | yes      |
| 5   | `Platform` has 18 readonly members; `desktop` registers 8 of them as `Partial<Platform>`                                     | `grep -c "^  readonly" Client/src/platform/contracts/index.ts` → 18; `desktop/index.ts:14-23`                                                                                    | yes      |
| 6   | 12 `*.suite.ts`, 8 `*.legacy.test.ts`, 8 `*.desktop.test.ts` under `Client/tests/unit/platform/`                             | `ls Client/tests/unit/platform/*.suite.ts \| wc -l` → 12; same for the other two globs → 8 each                                                                                  | yes      |
| 7   | The four B7-5 suites exist and pass; the platform suite is green at baseline                                                 | `npx vitest run tests/unit/platform` → 18 files, 146 passed \| 96 expected fail                                                                                                  | yes      |
| 8   | `platform-contracts-counts.test.ts:57-59` hard-codes 19 / 28 / 33 and the doc table must match                               | read the file; `docs/architecture/platform-contracts.md:54-56`                                                                                                                   | yes      |
| 9   | No contract exposes `relaunch`, and none exposes the tray `status-change` event                                              | `grep -rn "relaunch\|status-change" Client/src/platform/contracts/*.ts` → only `updater.ts`'s `subscribeToInstall` comment                                                       | yes      |
| 10  | `Client/CLAUDE.md:19-24` still says "No call site has moved yet"; it was last touched by B7-3 and B7-4 did not update it     | `git log --oneline -1 -- Client/CLAUDE.md` → `89c9741e` (B7-3); `git show --stat 3634cb0d \| grep CLAUDE` → nothing                                                              | yes      |
| 11  | Register row L-02 still reads open; B7-4's closure column is blank and B7-5 owns "L-02 (implementation half)"                | `docs/plans/b7-shared-client-platform-desktop-parity.prd.md:360`; `repo-health-issue-register-2026-08-23.md:268`                                                                 | yes      |
| 12  | Rust handler count is 33 and no Rust change is planned by this milestone                                                     | `Client/tests/unit/platform-contracts-counts.test.ts:59`; every remaining capability is a TS call site                                                                           | yes      |

**Row 2 is the one that moves under you.** Every capability you move should
_remove_ an entry from the eslint `ignores` list (`Client/eslint.config.js:125-129`).
A migration that leaves the list unchanged has not actually moved the static
import. Removing all five is the acceptance for "0 native imports outside the
seam".

## Patterns to Mirror

- **Suite shape:** `Client/tests/unit/platform/deepLinks.suite.ts` — exports
  `describeDeepLinksSuite(subjectFactory, opts)`, asserts **only what the caller
  receives** (no command name, no invoke argument shape), and takes a
  `NativeControl` handle with `succeedWith` / `failWith` / `unavailable` so the
  suite never knows how the native call is wired.
- **Legacy binding:** `deepLinks.legacy.test.ts` — binds the suite to today's
  `lib/` exports with **no cast**. The null-subject casts in
  `suites-are-falsifiable.test.ts` are the only casts allowed in these suites.
- **Falsifiability:** every new suite gets a null-subject entry in
  `suites-are-falsifiable.test.ts`. A suite test that passes against a subject
  that does nothing asserts nothing. The probe caught nine vacuous tests in
  B7-3 alone (`b7-3….plan.md:236`).
- **Re-bind, do not rewrite:** for a capability whose suite already exists,
  copy the legacy binding's `NativeControl` half into a `.desktop.test.ts` that
  imports `platform/desktop/<name>` and drop the legacy file when the `lib/`
  export becomes internal (`deepLinks.legacy.test.ts:2-4`).
- **Counts maintenance:** `docs/architecture/platform-contracts.md` counts and
  `platform-contracts-counts.test.ts`'s hard-coded numbers are guarded by the
  test; update both in the same commit that changes the tree.
- **Verbatim lift:** for every capability that is security- or
  behaviour-relevant (`nativeProxies`'s cert pin, `updater`'s install guard),
  lift the native call **verbatim** — same command, same arguments, same error
  handling, same log lines. A behavioural "improvement" is out of scope.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                                                               | Change                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `Client/src/platform/desktop/index.ts`                                                                             | grows to the full 18-member `Platform`      |
| `Client/src/platform/desktop/*.ts`                                                                                 | new: one implementation file per capability |
| `Client/src/platform/contracts/{updater,notifications,window,opener,devTools}.ts`                                  | amend only where a seam needs one method    |
| `Client/src/lib/deep-link.ts`, `ptt.ts`, `updater.ts`, `httpProxy.ts`                                              | → contract                                  |
| `Client/src/lib/livekitUrlResolver.ts`, `notifications.ts`, `window-state.ts`                                      | → contract                                  |
| `Client/src/lib/admin-panel.ts`                                                                                    | → contract                                  |
| `Client/src/components/settings/AdvancedTab.ts`                                                                    | autostart + devtools + relaunch halves      |
| `Client/src/components/settings/LogsTab.ts`                                                                        | app metadata half only                      |
| `Client/src/main.ts`                                                                                               | opener, tray `status-change`, devtools      |
| `Client/tests/unit/platform/{deepLinks,pushToTalk,updater,nativeProxies}.desktop.test.ts`                          | new: the re-bound runs                      |
| `Client/tests/unit/platform/{notifier,window,opener,appMetadata,devTools,autostart,livekitProxies}.suite.ts`       | new                                         |
| `Client/tests/unit/platform/{notifier,window,opener,appMetadata,devTools,autostart,livekitProxies}.legacy.test.ts` | new                                         |
| `Client/tests/unit/platform/suites-are-falsifiable.test.ts`                                                        | new null subjects                           |
| `Client/tests/unit/platform-contracts-counts.test.ts`                                                              | recount the pinned numbers                  |
| `Client/eslint.config.js`                                                                                          | shrink the `ignores` list as imports move   |
| `Client/knip.json`                                                                                                 | remove the `src/platform/**` ignore         |
| `docs/architecture/platform-contracts.md`                                                                          | counts + the moved rows                     |
| `Client/CLAUDE.md`                                                                                                 | the stale "no call site has moved" bullet   |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `docs/plans/*`,
`CHANGELOG.md`, or any status row.

## Tasks

Commit after every task — conventional subject, scope `b7-5`, one task per
commit, no `Co-Authored-By` trailer. This step is long: a commit per capability
means a compaction loses at most one.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-5-adapter-media-shell` at
  `3634cb0d` or later; run the recount commands from rows 1–6 and 8 above and
  record their output.
- **Validate:** `npm --prefix Client test -- tests/unit/platform` green before
  you change anything: 18 files, 146 passed | 96 expected fail. Record the test
  count — it must never drop. Also record the full `npm --prefix Client test`
  count (5672 passed | 96 expected fail at `3634cb0d`).

### Tasks 1–4: Move the four capabilities that already have a suite

In this order — `deepLinks`, `pushToTalk`, `updater` (AppUpdater),
`nativeProxies` (ensureHttpProxy). These go first so the migration pattern is
established against the strongest oracle.

For each capability:

- **Action:** add `Client/src/platform/desktop/<name>.ts` implementing the
  contract with the native calls lifted verbatim from the `lib/` file; register
  it on `desktop`; change the `lib/` call site to consume the contract; delete
  the now-dead native import; remove that file from the eslint `ignores` list
  where it had a static import (`updater.ts`, `httpProxy.ts`,
  `livekitUrlResolver.ts`).
- **Add** `<name>.desktop.test.ts` running the same suite against the desktop
  binding. **Keep** `<name>.legacy.test.ts` until the `lib/` export is gone.
- **Gotcha (`updater`):** the install guard `installation !== null`
  (`lib/updater.ts:90,115`) is behaviour, not wiring — lift it with the code, and
  keep the existing `tests/unit/updater.test.ts` and
  `tests/integration/client-updater-lifecycle.test.ts` green.
- **Gotcha (`nativeProxies`):** `ensureHttpProxy` re-invokes
  `start_http_proxy` on every call deliberately (`httpProxy.ts:25-31`); the
  contract half moves, the module-level `pending` map moves with it, and the
  LiveKit half stays until Task 8.
- **Validate, every task:** the capability's suite green against **both**
  bindings; `npm --prefix Client run typecheck` and `typecheck:build` clean;
  `npm --prefix Client run lint` exits 0 with no new cycle. Commit.

### Tasks 5–7: Write the missing suites against the legacy bindings

- **Action:** for `notifier`, `window`, `opener`, `appMetadata`, `devTools`,
  autostart and the LiveKit half of `nativeProxies`, lift a seam **in place,
  verbatim** in the `lib/`/`components/` file (an exported function or a thin
  wrapper the caller already reaches), write `<name>.suite.ts` mirroring
  `deepLinks.suite.ts`, bind it in `<name>.legacy.test.ts` with no cast, and add
  a null subject for each to `suites-are-falsifiable.test.ts`.
- **Why:** none of these has an oracle. Written after the move they would assert
  the new behaviour rather than the old, which is the failure mode this whole
  milestone exists to avoid.
- **Gotcha (`window`):** `initWindowState` is a fire-and-forget orchestrator, not
  a seam (`window.ts:2-6`). The seam is the `WindowControl` operations it calls
  (`isMaximized`, `availableMonitors`, `outerPosition`, `outerSize`, `center`);
  factor them so the suite binds the operations, not the orchestrator.
- **Gotcha (`devTools`):** `open_devtools` is invoked inline in two event
  listeners (`main.ts:86-88`, `AdvancedTab.ts:69`); the seam is
  `DevTools.open()` and both call sites consume it.
- **Validate:** `npm --prefix Client test -- tests/unit/platform` green, and
  `suites-are-falsifiable` green — which is what proves the new suites can fail.
  Commit per capability or per small group.

### Tasks 8–14: Move the remaining capabilities

In this order — LiveKit proxies, notifications, window state, autostart,
opener, app metadata, dev tools.

For each capability:

- **Action:** as Tasks 1–4.
- **Gotcha (LiveKit proxies):** `LiveKitUrlResolver` is a class
  (`livekitUrlResolver.ts:9`); the contract mirrors its methods one-for-one
  (`nativeProxies.ts:7-11`). `livekitSession.ts:196,699` owns the instance;
  it consumes the contract, it is not replaced.
- **Gotcha (notifications):** the desktop implementation keeps the Web
  Notification fallback (`notifications.ts:162-174`) — the contract describes the
  seam, the fallback is the caller's.
- **Gotcha (autostart):** the read-back race guard `touched`
  (`AdvancedTab.ts:235,264`) is behaviour; keep it with the UI half and give the
  contract only `isEnabled`/`enable`/`disable`.
- **Validate, every task:** the capability's suite green against **both**
  bindings; `npm --prefix Client run typecheck` and `typecheck:build` clean;
  `npm --prefix Client run lint` exits 0 with no new cycle. Commit.

### Task 15: Counts, docs and the final gate

- **Action:** update `docs/architecture/platform-contracts.md` — the counts
  table, the "Measured against" line, and the rows for every capability that
  moved; recount the hard-coded 19 / 28 / 33 in
  `platform-contracts-counts.test.ts` against the tree; remove
  `src/platform/**` from `Client/knip.json`'s ignore (B7-5 owns that,
  `platform-contracts.md:255-263`); update `Client/CLAUDE.md:19-24`.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  npm --prefix Client run knip
  npm run check:hygiene
  ```

  `platform-contracts-counts.test.ts` must be green — it fails if the doc
  disagrees with the tree. Commit.

## Validation

```
npm --prefix Client test -- tests/unit/platform    # both bindings, every suite
npm --prefix Client test                           # count not lower than Task 0's
npm --prefix Client run typecheck
npm --prefix Client run typecheck:build
npm --prefix Client run lint                       # 0 warnings, cycles <= 29
npm --prefix Client run knip
git grep -l "@tauri-apps" -- 'Client/src/**' | grep -v "platform/desktop"   # empty
npm run check:docs
npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                                                      | Mitigation                                                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A move changes behaviour silently                                                         | The suite runs against both bindings; green-before-and-after is the acceptance                                       |
| A new suite is vacuous                                                                    | Null subject in `suites-are-falsifiable.test.ts` — B7-3's reviews missed 9 vacuous tests that this probe then caught |
| The LiveKit proxy's cert pin or the updater's install guard is "improved" during the lift | Lift verbatim; any change is a separate, reviewed commit                                                             |
| Import cycles appear as `desktop/` grows                                                  | `lint` enforces the ceiling of 29; it must not rise                                                                  |
| The counts test's hard-coded numbers block the tree change                                | Update the doc and the test in the same commit (Task 15)                                                             |
| `main.ts` cannot reach zero native imports without a contract for `relaunch`/tray events  | Open Questions 1, 3 and 4 must be answered before Task 15, not during it                                             |

## Out of scope

- Any `browser/` implementation, `build:web`, PWA or mobile — B8, deferred
  post-beta (`prd.md:247-248`).
- A `MediaDevices` contract: there is no `@tauri-apps` surface for media devices
  (`b7-3….plan.md:59`); see Open Question 2.
- Decomposing any `lib/` file beyond what moving its native calls requires.
- Bundle budgets (B7-7), the Vite split (B7-6), and decomposition (B7-9/B7-10).
- An `isDesktop()` environment helper.

## Open questions for the owner

- [ ] **`main.ts` bootstrap boundary.** The success metric allows "native
      imports outside `platform/desktop` **+ bootstrap**" (`prd.md:217`), but
      `main.ts` still imports `plugin-opener` and `api/event` statically
      (`main.ts:47-48`) and invokes `open_devtools` inline (`:86`). Does
      `main.ts` keep those three, or move all three behind the seam and remain
      only the composition root? **Proposed default:** move all three
      (`urlOpener.open`, a tray-event subscription, `devTools.open()`) so the
      `@tauri-apps` count outside `platform/desktop` is genuinely zero, and
      record `main.ts` as a consumer of the registry rather than an exception.
- [ ] **Media/devices.** The PRD outcome names it; no `@tauri-apps` surface
      exists (`b7-3….plan.md:59`) and every call site is
      `navigator.mediaDevices` (`deviceManager.ts:102`, `VoiceAudioTab.ts:367`).
      **Proposed default:** record in `platform-contracts.md` that media devices
      need no adapter (web API), and close the PRD's "media/devices" clause with
      that note rather than inventing a contract. Confirm, or ask for a thin
      `MediaDevices` contract.
- [ ] **`relaunch` has no contract.** `lib/updater.ts:6,111` and
      `AdvancedTab.ts:191-192` both call `plugin-process`'s `relaunch`; the
      `AppUpdater` contract delivers the updater path's relaunch internally but
      exposes no method (`contracts/updater.ts`). **Proposed default:** add
      `relaunch(): Promise<void>` to `AppUpdater`, which already owns the process
      plugin, rather than a new `ProcessControl` contract — a one-method
      amendment B7-5 may make as the milestone creating the seam.
- [ ] **The tray `status-change` event has no contract.** `main.ts:295`
      subscribes with `listen<string>("status-change", …)`; the tray emits it
      (`Client/src-tauri/src/tray.rs:90`). **Proposed default:** add a minimal
      `AppEvents` contract (or a `subscribeStatusChange` member) so `main.ts`
      reaches it through the seam; the alternative is to leave this one static
      import in `main.ts` under the bootstrap exception. Owner call, because it
      decides whether the bootstrap exception exists at all.
- [ ] **Legacy bindings after a move.** Keep `*.legacy.test.ts` once a
      capability's `lib/` export is internal? **Proposed default:** delete it in
      the same commit that makes the export internal, mirroring B7-4
      (`b7-4….plan.md:223-226`), since it then tests nothing the desktop binding
      does not.

## Acceptance

- [ ] The ten remaining `Platform` members (across nine contract files) reach
      native APIs through `platform/desktop`: deep links, push-to-talk, updater
      (AppUpdater and Autostart), LiveKit proxies (HTTP half already moved in
      B7-4, LiveKit half here), notifications, window state, opener, app
      metadata, dev tools
- [ ] Seven new suites exist, each written against the legacy binding first and
      each with a null subject in `suites-are-falsifiable.test.ts` (four
      further capabilities re-bind the suite they already have)
- [ ] Every suite runs green against **both** the legacy and the desktop
      binding; total test count never dropped
- [ ] `desktop/index.ts` registers all 18 `Platform` members, or the bootstrap
      exception is recorded and every remaining import is named
- [ ] `git grep -l "@tauri-apps" -- 'Client/src/**' | grep -v platform/desktop`
      is empty, or every surviving line is the recorded bootstrap exception
- [ ] Every static native import moved is gone from `Client/eslint.config.js`'s
      `ignores`; `Client/knip.json`'s `src/platform/**` ignore is removed
- [ ] `platform-contracts.md` counts and `platform-contracts-counts.test.ts`
      updated together; the counts test is green
- [ ] `Client/CLAUDE.md`'s "No call site has moved yet" bullet is corrected
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle
      ceiling not raised
- [ ] `ci-check` green
