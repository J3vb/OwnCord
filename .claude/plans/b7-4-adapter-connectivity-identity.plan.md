# Plan: B7-4 — Adapter migration, connectivity and identity

> **Milestone:** B7-4 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-4-adapter-connectivity-identity`.
> **Worktree:** `.claude/worktrees/b7-4`.
> **Drafted:** 2026-09-20. **Base commit:** `8cb03344` (`dev`).

## Summary

B7-3 built the seam and did not use it: 17 type-only contracts under
`Client/src/platform/contracts/`, an **empty** `desktop/index.ts`
(`export const desktop: Partial<Platform> = {}`), and eight behaviour suites
bound to today's `src/lib` exports. This milestone moves the first half of the
call sites behind that seam — HTTP, WebSocket, credentials, identity, pending
messages, settings, logs/filesystem — and leaves media and shell to B7-5.

The oracle is already written and is the reason this step is mechanical rather
than exploratory. Each suite states its own contract
(`credentials.suite.ts:1-5`): "Run now against the legacy binding … and again
in B7-4 against `platform/desktop` — a green run before and after that move is
the evidence the move changed nothing." **Do not weaken a suite to make a move
land.** If a suite goes red, the move is wrong, not the suite.

**The asymmetry that shapes the task list.** Only **four** of this milestone's
eight capabilities have a suite today. Counted at `8cb03344`:

| Capability     | Contract             | Suite exists? | This milestone must                  |
| -------------- | -------------------- | ------------- | ------------------------------------ |
| Credentials    | `credentials.ts`     | **yes**       | move; re-bind the suite to `desktop` |
| Identity       | `identityStore.ts`   | **yes**       | move; re-bind the suite to `desktop` |
| Settings       | `settings.ts`        | **yes**       | move; re-bind the suite to `desktop` |
| Logs / files   | `logFiles.ts`        | **yes**       | move; re-bind the suite to `desktop` |
| HTTP           | `http.ts`            | **no**        | **write the suite first**, then move |
| WebSocket      | `socket.ts`          | **no**        | **write the suite first**, then move |
| Pending msgs   | `pendingMessages.ts` | **no**        | **write the suite first**, then move |
| File save/pick | `fileSave.ts`        | **no**        | **write the suite first**, then move |

The other four existing suites (`deepLinks`, `nativeProxies`, `pushToTalk`,
`updater`) belong to B7-5. Do not touch them.

A suite written here is written **against the legacy binding first**, proven
falsifiable, and only then re-bound to `desktop`. Writing it against the new
code instead proves nothing — it would assert whatever the new code happens to
do.

## Verify before you implement

Every row was checked at `8cb03344`. If a row is false at your HEAD, **stop
that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                           | How to re-check                                                                                                 | Verified |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `desktop/index.ts` is empty — `export const desktop: Partial<Platform> = {}`                                                    | `cat Client/src/platform/desktop/index.ts`                                                                      | yes      |
| 2   | 17 contracts + one `index.ts` under `contracts/`                                                                                | `ls Client/src/platform/contracts/*.ts \| wc -l` → 18                                                           | yes      |
| 3   | Exactly 8 `*.suite.ts` and 8 matching `*.legacy.test.ts`                                                                        | `ls Client/tests/unit/platform/*.suite.ts \| wc -l` → 8                                                         | yes      |
| 4   | No suite exists for `http`, `socket`, `pendingMessages`, `fileSave`                                                             | `ls Client/tests/unit/platform/ \| grep -E 'http\|socket\|pending\|fileSave'` → empty                           | yes      |
| 5   | `suites-are-falsifiable.test.ts` runs every suite against a null subject with `expectEveryTestToFail: true`                     | read its header comment                                                                                         | yes      |
| 6   | 21 files under `Client/src/` import `@tauri-apps/*`; 12 statically, 9 via dynamic `import()`                                    | `docs/architecture/platform-contracts.md:51`; the static 12 are the `ignores` list in `Client/eslint.config.js` | yes      |
| 7   | `platform-contracts-counts.test.ts` re-derives the three counts from the tree and fails when the doc's table disagrees          | read the file                                                                                                   | yes      |
| 8   | There is no `window.__TAURI__` use and no `isDesktop()` helper; the only SDK env guard is `isTauri` in `lib/pendingMessages.ts` | `platform-contracts.md:51-56,89-91`                                                                             | yes      |
| 9   | Nothing outside B7-3 imports `platform/desktop` yet                                                                             | `grep -rn "platform/desktop" Client/src` → only `desktop/index.ts` itself                                       | yes      |

**Row 6 is the one that moves under you.** Every capability you migrate should
_remove_ entries from the eslint `ignores` list. A migration that leaves the
list unchanged has not actually moved the import.

## Patterns to Mirror

- **Suite shape:** `Client/tests/unit/platform/credentials.suite.ts` — exports
  `describe<Name>Suite(subjectFactory, opts)`, asserts **only what the caller
  receives** (no command name, no invoke argument shape), and takes a
  `NativeControl` handle with `succeedWith` / `failWith` / `unavailable` so the
  suite never knows how the native call is wired.
- **Legacy binding:** `credentials.legacy.test.ts` — binds the suite to today's
  `lib/` exports with **no cast**. The null-subject casts in
  `suites-are-falsifiable.test.ts` are the only casts allowed in these suites.
- **Falsifiability:** every new suite gets a null-subject entry in
  `suites-are-falsifiable.test.ts`. A suite test that passes against a subject
  that does nothing asserts nothing.
- **Counts maintenance:** `docs/architecture/platform-contracts.md` counts are
  guarded by a test; update the doc in the same commit that changes the tree.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                               | Change                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `Client/src/platform/desktop/index.ts`                                             | grows one capability at a time              |
| `Client/src/platform/desktop/*.ts`                                                 | new: one implementation file per capability |
| `Client/src/lib/api.ts`                                                            | HTTP call sites → contract                  |
| `Client/src/lib/ws.ts`                                                             | WebSocket call sites → contract             |
| `Client/src/lib/credentials.ts`                                                    | → contract                                  |
| `Client/src/lib/identity.ts`                                                       | → contract                                  |
| `Client/src/lib/pendingMessages.ts`                                                | → contract (incl. the `isTauri` guard)      |
| `Client/src/lib/profiles.ts`                                                       | HTTP **and** settings — splits across two   |
| `Client/src/lib/logPersistence.ts`                                                 | → contract                                  |
| `Client/src/components/message-list/attachments.ts`                                | HTTP + file save                            |
| `Client/src/components/message-list/embeds.ts`                                     | HTTP                                        |
| `Client/src/components/message-list/media.ts`                                      | HTTP                                        |
| `Client/src/components/settings/AdvancedTab.ts`                                    | logs/filesystem half only                   |
| `Client/src/components/settings/LogsTab.ts`                                        | logs/filesystem half only                   |
| `Client/tests/unit/platform/{http,socket,pendingMessages,fileSave}.suite.ts`       | new                                         |
| `Client/tests/unit/platform/{http,socket,pendingMessages,fileSave}.legacy.test.ts` | new                                         |
| `Client/tests/unit/platform/*.desktop.test.ts`                                     | new: the re-bound runs                      |
| `Client/tests/unit/platform/suites-are-falsifiable.test.ts`                        | 4 new null subjects                         |
| `Client/eslint.config.js`                                                          | shrink the `ignores` list as imports move   |
| `docs/architecture/platform-contracts.md`                                          | counts + the moved rows                     |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `docs/plans/*`,
`CHANGELOG.md`, or any status row.

## Tasks

Commit after every task — conventional subject, scope `b7-4`, one task per
commit, no `Co-Authored-By` trailer. This step is long: a commit per capability
means a compaction loses at most one.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-4-adapter-connectivity-identity`
  at `8cb03344` or later; run the four Verify commands above that are one-liners
  (rows 1, 2, 3, 9) and record their output.
- **Validate:** `npm --prefix Client test -- tests/unit/platform` green before
  you change anything. Record the test count — it must never drop.

### Task 1: Write the four missing suites against the legacy binding

- **Action:** for each of `http`, `socket`, `pendingMessages`, `fileSave`,
  write `<name>.suite.ts` mirroring `credentials.suite.ts`, plus
  `<name>.legacy.test.ts` binding it to today's `lib/` exports with no cast.
  Add a null subject for each to `suites-are-falsifiable.test.ts`.
- **Why:** these four have no oracle. Written after the move they would assert
  the new behaviour rather than the old, which is the failure mode this whole
  milestone exists to avoid.
- **Gotcha:** `lib/ws.ts` binds `core.invoke` to a local `tauriInvoke`; the
  counts test exists because of that alias. Assert on what the caller receives,
  never on the command name.
- **Validate:** `npm --prefix Client test -- tests/unit/platform` green, and
  `suites-are-falsifiable` green — which is what proves the four new suites can
  fail. Commit.

### Tasks 2–9: Move one capability per task

In this order — credentials, identity, settings, logs/files, pendingMessages,
fileSave, HTTP, WebSocket. The four with existing suites go first so that the
migration pattern is established against the strongest oracle.

For each capability:

- **Action:** add `Client/src/platform/desktop/<name>.ts` implementing the
  contract with the native calls lifted verbatim from the `lib/` file; register
  it on `desktop`; change the `lib/` call sites to consume the contract; delete
  the now-dead native import; remove that file from the eslint `ignores` list.
- **Add** `<name>.desktop.test.ts` running the same suite against the desktop
  binding. **Keep** `<name>.legacy.test.ts` until the `lib/` export is gone.
- **Gotcha (credentials, identity, pendingMessages):** these three are the
  security-relevant ones. Lift the native call **verbatim** — same command, same
  arguments, same error handling. A behavioural "improvement" here is out of
  scope and will be rejected in review.
- **Gotcha (pendingMessages):** it holds the only SDK `isTauri` guard in the
  tree. The guard moves into the desktop implementation; it does **not** become
  a general `isDesktop()` helper — row 8 records that no such helper exists and
  B7 is not the milestone that adds one.
- **Gotcha (profiles.ts):** it spans HTTP _and_ settings. Split it across the
  two tasks rather than moving it twice.
- **Validate, every task:** the capability's suite green against **both**
  bindings; `npm --prefix Client run typecheck` and `typecheck:build` clean;
  `npm --prefix Client run lint` exits 0 with no new cycle. Commit.

### Task 10: Counts, docs and the final gate

- **Action:** update `docs/architecture/platform-contracts.md` — the counts
  table and the rows for every capability that moved.
- **Validate:**
  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
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
npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                      | Mitigation                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A move changes behaviour silently                         | The suite runs against both bindings; green-before-and-after is the acceptance                                       |
| A new suite is vacuous                                    | Null subject in `suites-are-falsifiable.test.ts` — B7-3's reviews missed 5 vacuous tests that this probe then caught |
| Credentials/identity behaviour "improved" during the lift | Lift verbatim; any change is a separate, reviewed commit                                                             |
| Import cycles appear as `desktop/` grows                  | `lint` enforces the ceiling of 29; it must not rise                                                                  |
| The eslint `ignores` list rots                            | Each capability task removes its own entries; Task 10 checks none are stale                                          |

## Out of scope

- Media, LiveKit's native proxy, push-to-talk, notifications, window state,
  deep links, updater, app metadata, dev tools — **all B7-5**.
- Any `browser/` implementation. B8 is deferred post-beta.
- An `isDesktop()` environment helper.
- Decomposing any `lib/` file beyond what moving its native calls requires.

## Open questions for the owner

- [ ] `lib/profiles.ts` spans HTTP and settings. Split it into two files as
      part of this milestone, or leave it as one file consuming two contracts?
      **Proposed default:** leave it as one file consuming two contracts —
      decomposition is B7-10's job, not this one's.
- [ ] Keep `*.legacy.test.ts` after a capability's `lib/` export is fully
      internal? **Proposed default:** delete the legacy binding in the same
      commit that makes the export internal, since it then tests nothing that
      the desktop binding does not.

## Acceptance

- [ ] Eight capabilities reach native APIs through `platform/desktop`:
      credentials, identity, settings, logs/files, pending messages, file
      save/pick, HTTP, WebSocket
- [ ] Four new suites exist, each written against the legacy binding first and
      each with a null subject in `suites-are-falsifiable.test.ts`
- [ ] Every suite runs green against **both** the legacy and the desktop
      binding; total test count never dropped
- [ ] `desktop/index.ts` registers exactly those eight capabilities
- [ ] Every migrated file is gone from `Client/eslint.config.js`'s `ignores`
- [ ] `platform-contracts.md` counts updated; the counts test is green
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle
      ceiling not raised
- [ ] `ci-check` green
