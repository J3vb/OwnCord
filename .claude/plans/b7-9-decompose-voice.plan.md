# Plan: B7-9 — Decompose voice

> **Milestone:** B7-9 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-9-decompose-voice`.
> **Worktree:** `.claude/worktrees/b7-9`.
> **Drafted:** 2026-09-21. **Base commit:** `639d5bb3` (`dev`).

## Summary

The milestone outcome is one sentence: "The two largest voice modules split
into ownership-scoped files with colocated tests, with supersession and
staleness behavior proven unchanged, not just assumed unchanged"
(`prd.md:321`). Recounted at `639d5bb3`, the two modules are still the client's
two largest non-generated files and the two largest in the mutation surface:

| Module                      | Lines | Mutants (B7-8) | Score (B7-8) | Score re-measured here |
| --------------------------- | ----: | -------------: | -----------: | ---------------------: |
| `src/lib/livekitSession.ts` | 1 621 |          1 024 |      54.27 % |                54.43 % |
| `src/lib/livekitE2EE.ts`    | 1 612 |            896 |      57.27 % |                57.27 % |

The re-measured column is one command at HEAD (Verify row 5): the two files
together are **1 920 mutants / 55.89 %**, with 621 errored mutants excluded from
the score. The B7-8 rows and the re-measurement agree to run-to-run variance,
which is what makes B7-8's baseline usable as the before-number here
(`docs/plans/b7-8-mutation-baseline-2026-09-20.md:169,171`).

**Eight extractions have already happened.** `livekitReconnect.ts`,
`livekitUrlResolver.ts`, `voiceTokenManager.ts`, `screenShare.ts`,
`livekitDiagnostics.ts`, `roomEventHandlers.ts`, `audioElements.ts` and
`audioPipeline.ts` all started inside `livekitSession.ts` (their headers say so,
e.g. `livekitReconnect.ts:1`, `screenShare.ts:2`, `livekitE2EE.ts:1`). What is
left in the two files is the part no earlier split touched: the session-attempt
state machine and its supersession checkpoints, the room lifecycle, the
media/device control facade, and, in `livekitE2EE.ts`, the key-exchange protocol
with its epoch staleness guards. Those are exactly the responsibilities the
layout-refactor supplement names for Phase 5 items 2 and 3
(`developer-experience-layout-refactor-2026-08-29.md:393-398`).

**The oracle already exists and is the point of the milestone.** The supersession
and staleness behavior is covered today by two large suites —
`tests/unit/livekit-session.test.ts` (4 329 lines, 217 `it`s, 13 names about
supersession) and `tests/unit/livekit-e2ee.test.ts` (2 467 lines, 77 `it`s, 56
finding/OC-named cases, 107 mentions of supersede/stale/epoch) — plus **four
local ESLint rules** that encode the invariants structurally
(`eslint.config.js:76-101`). "Proven unchanged" therefore has three instruments,
and the plan uses all three: the existing suites stay untouched and green, the
four rules stay armed and are extended to every new home, and the extracted
files get a mutation score measured against the 55.89 % / 1 920-mutant
before-number.

**The decomposition pattern is a facade, not a re-export sweep.**
`livekitSession.ts` has **13 static importers** and **8 dynamic import sites**
(Verify row 13), and `livekitE2EE.ts` has exactly one production importer
(`livekitSession.ts:20`). So the split extracts ownership modules _behind_ the
existing classes and keeps `livekitSession.ts`'s public surface — including its
36 bound exports and `parseUserId` — byte-for-byte stable. Consumer files do not
move, which is what keeps the diff attributable and keeps B7-10 (whose
dispatcher re-organization touches this surface) from rebasing onto a rename
sweep.

**Two gate facts that reshape the task list, both re-derived here.**

1. **A colocated test breaks the mutation gate as configured.** `vitest` already
   includes `src/**/*.test.ts` (`vitest.config.ts:49`) and zero files match it
   today (Verify row 2), but `stryker.config.mjs:21` mutates
   `src/lib/**/*.ts` and `stryker.shard.config.mjs` lists files explicitly, so
   adding `src/lib/voice/x.test.ts` makes
   `node scripts/check-mutation-shards.mjs` exit 1 ("missing from every
   shard"); `tsconfig.build.json` also typechecks `src/**` with `types: []`, so
   a colocated test importing `node:*` fails `typecheck:build` with TS2591.
   Both were observed on a throwaway file (Verify row 11). Task 1 fixes the
   three configs before any test is colocated.
2. **The PR-CI mutation subset has no runner.** Decision 5 says "PR CI keeps the
   `permissions.ts` subset plus the modules B7-9/B7-10 extract" (`prd.md:387`),
   but `Client/stryker.ci.config.mjs:5` still lists only `src/lib/permissions.ts`
   and is executed by nothing on a PR: the sole caller is
   `nightly-test-depth.yml:87`, in the workflow B7-8 landed **inert on `dev`**
   (`.github/workflows/nightly-test-depth.yml:1-15`; `b7-8 plan:42-58`). The
   plan must therefore say how the extracted modules are actually measured
   rather than citing a subset that does not run — Open question 2.

## Dependencies and concurrent files

- **B7-8 is the baseline and it has landed** (PR #1644, `dev` `9953f9b4`). Its
  shard config and union check are the measurement instrument; B7-9 adds its new
  files to them.
- **B7-9 runs before B7-10** (`prd.md:344-346`): "the dispatcher reorganization
  B7-10 performs touches the voice handlers B7-9 extracts". `dispatcher.ts:114`
  is a dynamic `import("@lib/livekitSession")` and twelve of its call sites
  dispatch into facade functions (`dispatcher.ts:165,406,1069,1106,1143,1170,
1186,1194,1355,1390,1395,1427`). **The facade's export names and signatures are frozen by
  this milestone**, so B7-10 rebases onto a stable surface rather than a
  concurrent rename.
- **B7-11 runs after B7-10** and owns timer/listener ownership; the split must
  not pre-empt its work (no new lifecycle primitive).
- **B7-5, B7-7 and B7-16 have landed** (`f5c9ff68`, `076408d0`, `639d5bb3`) and
  touched `livekitUrlResolver.ts`, `pushToTalkService.ts`, `ptt.ts`, the CSP and
  the fetch capability — none of which B7-9 moves. No expected file conflict.
- **The only shared file with a later milestone is `dispatcher.ts`,** which B7-9
  does not touch. If B7-9 needs to change it (it should not), that is a signal
  the facade rule was broken — record **BLOCKED**.

## Verify before you implement

Every row was re-derived at `639d5bb3` with the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                                                                                                                           | How to re-check                                                                                                                                                                                                                                                                | Verified |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | The two modules are `livekitSession.ts` 1 621 lines and `livekitE2EE.ts` 1 612; the next largest voice-scope file is `screenShare.ts` 536                                                                                       | `wc -l Client/src/lib/livekitSession.ts Client/src/lib/livekitE2EE.ts Client/src/lib/screenShare.ts Client/src/stores/voice.store.ts Client/src/lib/audioPipeline.ts` → 1621 / 1612 / 536 / 535 / 490                                                                          | yes      |
| 2   | Colocated `src/**/*.test.ts` is already in the vitest include and **zero** files match it; the PRD states decomposition populates it                                                                                            | `git ls-files 'Client/src/**/*.test.ts' \| wc -l` → 0; `Client/vitest.config.ts:49`; `prd.md:299`                                                                                                                                                                              | yes      |
| 3   | Voice is off the startup path and the bundle gate is green: startup closure 87 873 B / 90 000; `livekitSession` 19 840 B / 800 000 and lazy                                                                                     | `cd Client && npm run build:budget && node scripts/bundle-budget.mjs` → `ok startup-closure 87873 B`, `ok livekitSession 19840 B (budget 800000 B) [lazy]`                                                                                                                     | yes      |
| 4   | The mutation surface is 76 files / 11 870 mutants at this base, and the shard union equals it exactly                                                                                                                           | `cd Client && npx stryker run --dryRunOnly` → `Found 76 of 907 file(s)`, `Instrumented 76 … with 11870 mutant(s)`; `node scripts/check-mutation-shards.mjs` → `76 files`                                                                                                       | yes      |
| 5   | The two modules are 1 920 mutants / 55.89 % together (`livekitSession` 54.43, `livekitE2EE` 57.27), 621 errors excluded, 31 m 57 s                                                                                              | `cd Client && npx stryker run --mutate "src/lib/livekitSession.ts,src/lib/livekitE2EE.ts" --reporters clear-text`                                                                                                                                                              | yes      |
| 6   | Decision 5's PR-CI subset has **no PR runner**: the config lists only `permissions.ts` and its only caller is the inert nightly                                                                                                 | `Client/stryker.ci.config.mjs:5`; `grep -rn "stryker" .github/workflows/ci.yml` → one comment at `:492`; `grep -rn "stryker run" .github/workflows/` → `nightly-test-depth.yml:64,87` only                                                                                     | yes      |
| 7   | Four local ESLint rules are scoped by an explicit `files:` list to the two modules; no test asserts those lists                                                                                                                 | `Client/eslint.config.js:81` (`no-leave-voice-when-superseded`, covers `livekitSession.ts` + `livekitReconnect.ts`), `:88` (three `e2ee-*` rules on `livekitE2EE.ts`), `:97` (`no-identity-scope-fallback`); `grep -rn "files:" Client/tests/unit/eslint-rules.test.ts` → none | yes      |
| 8   | The supersession/staleness oracle is large: `livekit-session.test.ts` 4 329 lines / 217 `it`s / 13 supersession-named; `livekit-e2ee.test.ts` 2 467 lines / 77 `it`s / 56 finding-OC-named / 107 supersede-stale-epoch mentions | `wc -l` the two files; `grep -cE '\bit\('` → 217 / 77; named-case counts by `grep -cE`                                                                                                                                                                                         | yes      |
| 9   | The suite is green with 242 files / 5 734 passed + 140 expected fail, and statements coverage is 94.02 % (16 021/17 039)                                                                                                        | `cd Client && npx vitest run`; `npx vitest run --coverage`                                                                                                                                                                                                                     | yes      |
| 10  | The coverage floor is 90.0 and decision 9 ratchets it **to 91** at this milestone                                                                                                                                               | `Client/coverage-floor.json` (`"aggregate": 90.0`); `Client/vitest.config.ts:80`; decision 9 at `prd.md:391`                                                                                                                                                                   | yes      |
| 11  | A colocated `src/lib/**/*.test.ts` breaks the mutation union check and `typecheck:build` as configured                                                                                                                          | throwaway `src/lib/voice/probe.test.ts` → `node scripts/check-mutation-shards.mjs` exits 1 `missing from every shard`; a `node:*` import there → `npm run typecheck:build` fails `TS2591` (`tsconfig.build.json` includes `src`, `types: []`)                                  | yes      |
| 12  | The import-cycle ceiling is 29 and the tree sits exactly at 29; 7 of the diagnostics are the livekit/audio cluster, so the split must not add one                                                                               | `Client/package.json:39` (`--max-warnings=29`); `cd Client && npx oxlint -c .oxlintrc.cycles.json --tsconfig tsconfig.json src/` → 29 `no-cycle` diagnostics; `npx madge --circular --extensions ts --ts-config tsconfig.json src` → 23 cycles over 210 files                  | yes      |
| 13  | Keeping the facade costs zero consumer churn: 13 static + 8 dynamic importers of `@lib/livekitSession`; `livekitE2EE.ts` has exactly one production importer                                                                    | `git grep -l 'from "@lib/livekitSession"' -- 'Client/src/**' \| wc -l` → 13; `git grep -n 'import("@lib/livekitSession")' -- 'Client/src/**' \| wc -l` → 8; `git grep -n '@lib/livekitE2EE' -- 'Client/src/**'` → `livekitSession.ts:20`                                       | yes      |
| 14  | B7-9 closes register row C-12 (voice half) only; C-11 and C-12 (rest) are B7-10's                                                                                                                                               | `prd.md:370-371`; `docs/plans/repo-health-issue-register-2026-08-23.md:214-215`                                                                                                                                                                                                | yes      |
| 15  | The PRD's own rules bind this milestone: the four local rules stay green and any rule change is its own reviewed step; extraction and feature behavior never share one PR                                                       | `prd.md:407`, `prd.md:408`                                                                                                                                                                                                                                                     | yes      |

**Row 11 and row 6 are the two that shape the plan.** Row 11 means the
config fix must land before the first colocated test. Row 6 means the mutation
measurement cannot be delegated to an existing PR job; it has to be produced
deliberately, which is Open question 2.

## Patterns to Mirror

- **Facade over rewrite.** `screenShare.ts`, `roomEventHandlers.ts`,
  `audioElements.ts` and `livekitReconnect.ts` were all extracted out of
  `livekitSession.ts` while the class kept delegating methods with the same
  names (`livekitSession.ts:1462-1523`). The next split does the same: a new
  ownership module, a thin delegate in the class, consumers untouched.
- **Behavior suites as the seam, not the test file.** `deepLinks.suite.ts` and
  its B7-5 bindings assert only what the caller receives. Here the callers are
  `LiveKitSession`'s public methods, so the _existing_ suites are the binding
  and must not be rewritten — a split that needs a test changed is a split that
  changed behavior (`b7-5 plan:31-35`).
- **Named invariants stay armed where the code lands.** `eslint.config.js:81`
  already had to grow from one file to two when `livekitReconnect.ts` was
  extracted; its comment states the rule. Every new home for a guard gets added
  to the `files:` list **in the same commit** as the move.
- **Counts are recounted, never merged.** `check-mutation-shards.mjs`,
  `platform-contracts-counts.test.ts` and the cycle ceiling are all re-derived
  from the tree; a conflict is resolved by recounting (`b7-5 plan:68-74`).
- **Prove a gate can fail.** B7-3's null-subject probe, B7-6 and B7-7 each
  observed red before trusting green. Task 1 proves the repaired mutation union
  check red on a throwaway file; the ratchets prove themselves red before being
  trusted.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                                                       | Change                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Client/src/lib/livekitSession.ts`                                                                         | shrinks to the facade + delegates; public surface frozen                       |
| `Client/src/lib/livekitE2EE.ts`                                                                            | same: `E2EEManager` stays the public class, delegates to ownership modules     |
| `Client/src/lib/voice/**` (or `src/features/voice/**`)                                                     | new ownership-scoped modules + their colocated `*.test.ts` (Open question 1)   |
| `Client/src/lib/audioElements.ts`, `livekitDiagnostics.ts`, `roomEventHandlers.ts`                         | re-point `parseUserId` at its leaf module (cycle removal, row 12)              |
| `Client/tests/unit/livekit-session.test.ts`                                                                | **re-point an import only if a file moves under it; assertions unchanged**     |
| `Client/tests/unit/livekit-e2ee.test.ts`                                                                   | same                                                                           |
| `Client/eslint.config.js`                                                                                  | extend the four `files:` lists to every new home of the guarded code           |
| `Client/stryker.config.mjs`                                                                                | exclude `src/**/*.test.ts` from `mutate`                                       |
| `Client/stryker.shard.config.mjs`                                                                          | add each extracted file to the `livekit` shard list                            |
| `Client/stryker.ci.config.mjs`                                                                             | add the extracted files to decision 5's subset                                 |
| `Client/tsconfig.build.json`                                                                               | exclude `src/**/*.test.ts` from the build typecheck                            |
| `Client/coverage-floor.json`                                                                               | ratchet 90.0 → 91.0 (decision 9)                                               |
| `Client/bundle-budgets.json`                                                                               | ratchet the `livekitSession` ceiling from the post-split measurement (B7-7 Q2) |
| `Client/package.json`                                                                                      | `lint:cycles` `--max-warnings` only if the split removes a cycle               |
| `Client/CLAUDE.md`                                                                                         | the layout bullet if the module map moves                                      |
| `docs/architecture/voice-e2ee.md`, `docs/architecture/ux/voice-and-e2ee.md`, `docs/architecture/client.md` | the file paths and line counts they cite for the two modules                   |
| `docs/plans/b7-8-mutation-baseline-2026-09-20.md`                                                          | append B7-9's post-split measurement (an evidence append, not a status row)    |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, the PRD, the register,
`docs/plans/README.md`, `CHANGELOG.md`, or any status row. The PRD is out of
scope by instruction: four parallel plan PRs would collide in its delivery table
and the links are added once, separately.

## Tasks

Commit after every task — conventional subject, scope `b7-9`, one task per
commit, no `Co-Authored-By` trailer. Because each task creates a file that the
mutation shard list must name, **every commit must leave
`node scripts/check-mutation-shards.mjs` and `npm --prefix Client run lint`
green**; a task that would break them is split, not skipped.

### Task 0: Branch, baseline and the oracle inventory

- **Action:** confirm the worktree is on `feat/b7-9-decompose-voice` at
  `639d5bb3` or later. Re-run Verify rows 1, 2, 4, 5, 9, 12, 13 and record the
  output. Write down the supersession/staleness oracle as an explicit list: each
  existing test name that proves a guard (the 13 supersession-named cases in
  `livekit-session.test.ts`, the epoch/keypair/finding cases in
  `livekit-e2ee.test.ts`), each of the four ESLint rules, and the two module
  mutation scores.
- **Why:** the outcome is "proven unchanged"; the proof has to be named before
  the code moves, not reconstructed after.
- **Validate:** the suite is green (242 files, 5 734 passed | 140 expected fail)
  and coverage is 94.02 % statements. Record both — neither may drop from this
  task's number. Re-run the two-module mutation command and record it as the
  before-number (55.89 % / 1 920 mutants at this base).

### Task 1: Make the gates survive a colocated test

- **Action:** add `!src/**/*.test.ts` to `Client/stryker.config.mjs`'s `mutate`
  surface; add `"exclude": ["src/**/*.test.ts"]` (plus the existing
  `tests/e2e`) to `Client/tsconfig.build.json`. Confirm
  `vitest.config.ts:49` already picks the files up and needs no change, and that
  `vitest`'s coverage report does not count them (a colocated test did not
  appear in `coverage-summary.json` in the probe).
- **Why:** row 11. Without this, the first colocated test fails
  `check-mutation-shards.mjs` and `typecheck:build`, and the milestone's own
  outcome — "with colocated tests" — cannot be delivered.
- **Validate:** create a throwaway `src/lib/voice/probe.test.ts` + `probe.ts`,
  observe `node scripts/check-mutation-shards.mjs` exit **0** (it exited 1
  before the fix), `npm run typecheck:build` exit **0**, `npm run lint` exit 0,
  then delete the throwaway. **Prove the exclusion did not blunt the gate:**
  temporarily remove the new `!src/**/*.test.ts` exclusion and confirm the union
  check goes red again. Commit.

### Task 2: Extract the session state and pure helpers

- **Action:** move `SessionState`, `PendingVoiceJoin`,
  `RemoteVideoCallback`/`RemoteVideoRemovedCallback` and `parseUserId`
  (`livekitSession.ts:65-117`) into a leaf module
  (`voice/sessionState.ts`), re-export them from `livekitSession.ts` so the 13
  static importers, the 8 dynamic sites and the suites are untouched, and
  re-point `audioElements.ts:16`, `livekitDiagnostics.ts:5` and
  `roomEventHandlers.ts:18` at the leaf. This removes three of the seven
  voice-cluster cycles (row 12) without touching a behavior.
- **Gotcha:** `parseUserId` is asserted directly in
  `livekit-session.test.ts:266-324`; the facade re-export keeps that test
  unchanged, which is how it stays a proof rather than a rewrite.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-session.test.ts
tests/unit/audio-elements.test.ts tests/unit/room-event-handlers.test.ts
tests/unit/livekit-diagnostics.test.ts` green; `typecheck`, `typecheck:build`
  and `lint` clean; the cycle count at or below 29. If it drops, lower
  `--max-warnings` by the delta in this commit and record it. Add the new file
  to the `livekit` shard list; `check-mutation-shards.mjs` green. Commit.

### Task 3: Extract the join orchestration (the supersession core)

- **Action:** move session-attempt ownership — `connectAndSetup`
  (`livekitSession.ts:760-1092`), `handleVoiceToken` (`:1093-1184`),
  `disconnectSupersededLocalRoom` (`:728-753`), `ownsConnectAttempt` and
  `isStateConnected` (`:278-285`) — into an ownership module, with the class
  delegating and `_joinGenerationCounter`/`setState` owned by the facade (single
  writer stays single). **In the same commit**, add the new file to
  `Client/eslint.config.js:81`'s `files:` list so
  `local/no-leave-voice-when-superseded` still covers the guard code.
- **Why:** this is the code the PRD risk row names
  (`prd.md:407`) and the reason the milestone exists.
- **Gotcha:** `connectAndSetup` is reached through `(session as any)` 17 times
  in the suite; the delegate must keep the same name and visibility semantics
  (private is fine — the tests cast). Do not "clean up" the cast surface.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-session.test.ts`
  green (all 217, especially the 13 supersession cases); the eslint rule still
  reports on a deliberately re-introduced violation in the new file (observe
  red, revert); `lint`, `typecheck`, `typecheck:build` clean; shard list and
  `check-mutation-shards.mjs` green. Commit.

### Task 4: Extract the room lifecycle

- **Action:** move `createRoom` (`:420-517`, the E2EE worker, room options and
  event wiring), `syncModuleRooms` (`:518-529`), `leaveVoice` (`:1257-1309`),
  `cleanupAll` (`:1310-1324`) and the E2EE worker field into a room-lifecycle
  module, class delegating.
- **Gotcha:** `createRoom` wires `this._eventHandlers` and
  `attachDiagnosticListeners`; the ownership module must receive those
  dependencies rather than reach back into the facade, or it recreates the
  cycle the split is meant to avoid. Keep the worker termination behavior — it
  is asserted (`livekit-session.test.ts:2998`).
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-session.test.ts`
  green; `lint` cycle count not above 29; shard list updated;
  `check-mutation-shards.mjs` green. Commit.

### Task 5: Extract the media and device control

- **Action:** move the media/device control facade — `setMuted`/`setDeafened`
  (`:1325-1357`), `enableMicrophone`, `microphonePublishingAllowed`,
  `applyMicMuteState` (`:1358-1445`), camera/screenshare enable/disable
  (`:1446-1463`), `switchInputDevice`/`switchOutputDevice` (`:1464-1473`),
  `retryMicPermission` (`:1222-1256`), the volume helpers (`:1474-1506`),
  `reapplyMuteGain` and the audio-pipeline delegates (`:1501-1523`) — into a
  media-control module. The underlying track implementations stay in
  `screenShare.ts`/`deviceManager.ts`/`audioPipeline.ts`; this moves the facade,
  not those.
- **Gotcha:** the class's test-compat getters/setters (`_peerPublicKeys`,
  `_e2eeEpoch`, `_rotatingKey`, `_rotationPending`, `_pendingAnnounces`,
  `livekitSession.ts:154-180`) must survive; they are reached via `(session as
any)` and are part of the frozen surface.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-session.test.ts
tests/unit/voice.store.test.ts tests/unit/ptt.test.ts` green; `lint`,
  `typecheck`, `typecheck:build` clean; shard list updated; union check green.
  Commit.

### Task 6: Extract remote tracks and debug/statistics

- **Action:** move the remote-track surface (`setOnRemoteVideo`,
  `setOnRemoteVideoRemoved`, `clearOnRemoteVideo` `:716-726`;
  `getRemoteVideoStream` `:1533-1536`; `getLocalCameraStream`/
  `getLocalScreenshareStream` `:1524-1532`) and the debug/statistics surface
  (`getSessionDebugInfo` `:1550-1559`, `getRoom`/`hasActiveSession`
  `:1537-1549`, and the `getRoomForStats`/`isVoiceSessionActive` module
  functions `:1610-1621`) into a remote-tracks module and a debug module —
  folding the latter into the existing `livekitDiagnostics.ts` if the seam is
  clean, which it should be since `livekitDiagnostics.ts` already owns
  `buildSessionDebugInfo`.
- **Gotcha:** `getRoomForStats` is called from `connectionDiagnostics.ts:41` and
  `VoiceWidget.ts:25`; `getSessionDebugInfo` from `LogsTab.ts:15`. The facade
  re-exports keep both call sites unchanged.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-session.test.ts
tests/unit/voice-widget.test.ts tests/unit/logs-tab.test.ts
tests/unit/video-grid.test.ts` green; `lint` clean; shard list updated; union
  check green. Commit.

### Task 7: Extract E2EE identity and key management

- **Action:** move `ensureIdentityKeyPair` (`livekitE2EE.ts:485-513`),
  `clearIdentityKeyPair` (`:514-522`), `_identityKeyPair`, `_identityScope`,
  `_identityGeneration` and `_ecdhKeyPair` ownership into an
  `voice/e2eeIdentity.ts`. **In the same commit**, add it to the `files:` list
  for `local/no-identity-scope-fallback` (`eslint.config.js:88`, and `:97` if
  the seam reaches `identity.ts`).
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-e2ee.test.ts`
  green — in particular the identity-scope case at `:870`; the rule still
  reports on a re-introduced violation in the new file (red, revert); `lint`,
  `typecheck`, `typecheck:build` clean; shard list updated; union check green.
  Commit.

### Task 8: Extract E2EE epoch and key rotation

- **Action:** move the epoch counter, `_roomKey`, `_peerOfferEpochs`,
  `rotateRoomKey` (`:1292-1309`), `rotateKeyPeriodically` (`:1528-1566`),
  `drainPendingRotationOrArmTimer` (`:1567-1578`),
  `startKeyRotationTimer`/`clearKeyRotationTimer` (`:1508-1527`) and
  `_rotatingKey`/`_rotationPending` into `voice/e2eeEpoch.ts`. **In the same
  commit**, add it to the `files:` list for
  `local/e2ee-epoch-needs-keypair-check` (`eslint.config.js:88`).
- **Gotcha:** the keypair-identity check the rule enforces must travel with the
  epoch comparison; the rule's own description says an epoch-only comparison
  cannot detect a torn-down-then-restarted session (`eslint-rules.js:130-155`).
  If the two checks end up in different files, the rule is inert in both —
  that is a design failure, not a config tweak.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-e2ee.test.ts`
  green, especially the `epoch is unchanged` case at `:401` and the keypair-swap
  cases at `:444,:721`; rule red-first on a violation; `lint`, `typecheck`,
  `typecheck:build` clean; shard list updated; union check green. Commit.

### Task 9: Extract E2EE peer state and verification

- **Action:** move `_peerPublicKeys`, `_peerGenerations`, `_retiredPeerKeys`,
  `_blockedAnnounces`, `_pendingAnnounces`, `peerAttemptIsCurrent`,
  `isRetiredPeerKey`, `retirePeerKey`, `setPeerVerificationIfCurrent`
  (`livekitE2EE.ts:554-811`) and `verifyPeerAnnounce` into
  `voice/e2eePeerState.ts`; `handleAnnounceInner` may move with it or stay with
  the protocol owner. **In the same commit**, add the new files to the `files:`
  list for `local/e2ee-verified-status-literal` (`eslint.config.js:88`).
- **Gotcha:** the rule requires every `status` write to be a hand-typed literal
  (`eslint-rules.js:190`). Splitting that function so a status is written in a
  second file is fine only if the rule covers that file.
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-e2ee.test.ts`
  green, especially TOFU pin cases (`:380,:530,:544`), replay cases
  (`:1168,:1657`) and the never-verified-as-verified cases; rule red-first on a
  violation; `lint`, `typecheck`, `typecheck:build` clean; shard list updated;
  union check green. Commit.

### Task 10: Extract E2EE worker lifecycle and the offer protocol

- **Action:** move the `keyProvider` ownership and the `_keyApplyChain` write
  queue (`livekitE2EE.ts:44-47,119-124`) into `voice/e2eeWorker.ts`, and
  `handleOfferInner`/`handleOffer`/`sendOfferPaced`/`distributeRoomKey`/
  `applyRoomKey`/`applyCurrentRoomKey`/`pruneOfferSendTimes` (`:996-1291`) into
  `voice/e2eeOffer.ts`. Leave `E2EEManager` composing them and keep its public
  method list exactly as the suite uses it (Verify: the 14 members listed in
  row 8's command output).
- **Validate:** `npm --prefix Client test -- tests/unit/livekit-e2ee.test.ts`
  green (all 77); `lint`, `typecheck`, `typecheck:build` clean; shard list
  updated; union check green. Commit.

### Task 11: Measure the extracted modules' mutation score

- **Action:** add every extracted file to `Client/stryker.ci.config.mjs`'s
  `mutate` list (decision 5) and confirm each is in the `livekit` shard list.
  Measure **before/after**: the before-number is Task 0's two-module run
  (55.89 % / 1 920 mutants); the after-number is the same command over the same
  two modules plus their extracted files, plus a
  `STRYKER_SHARD=livekit npx stryker run stryker.shard.config.mjs` run so the
  shard's post-split score is recorded too.
- **Why:** the outcome says "proven unchanged, not just assumed unchanged". A
  per-module mutation score before and after is the strongest non-test evidence
  available, and it is what decision 5's subset exists for.
- **Gotcha (Open question 2):** because the PR-CI subset has no runner (row 6)
  and the nightly is inert on dev, this task **runs the measurement locally and
  records it** in `docs/plans/b7-8-mutation-baseline-2026-09-20.md`'s
  interpretation section (an evidence append) — the same choice B7-8 made for
  its baseline (`b7-8 plan:209-226`). If the owner instead wants a PR-CI step,
  that is a separate, owned change and this task does not add one.
- **Validate:** each run exits 0 (report-only thresholds) and the recorded
  scores carry the exact command; `check-mutation-shards.mjs` green with the
  extracted files in the union; `stryker.ci.config.mjs` lists them. Commit.

### Task 12: Ratchets, docs and the final gate

- **Action:** ratchet `Client/coverage-floor.json` 90.0 → 91.0 (decision 9) and
  confirm `vitest.config.ts:80`'s thresholds still pass; re-measure the
  `livekitSession` bundle chunk with `npm run build:budget && node
scripts/bundle-budget.mjs` and ratchet `Client/bundle-budgets.json`'s ceiling
  to the measured value plus the file's existing margin convention (B7-7 Q2
  left "B7-9 sets the real ceiling from measurement"); lower
  `--max-warnings` in `Client/package.json:39` if the split removed cycles.
  Update the module map in `Client/CLAUDE.md` and the paths/line counts in
  `docs/architecture/voice-e2ee.md`, `docs/architecture/ux/voice-and-e2ee.md`
  and `docs/architecture/client.md`.
- **Why:** the ratchet rule (decision 9, `prd.md:391`; `prd.md:412`) says
  thresholds move only with a decomposition milestone that earns the
  improvement — this is that milestone.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run test:coverage
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  npm --prefix Client run knip
  cd Client && npm run build:budget && node scripts/bundle-budget.mjs
  cd Client && node scripts/check-mutation-shards.mjs
  npm run check:docs && npm run check:hygiene
  ```

  Then the `ci-check` skill. Commit.

## Validation

```
npm --prefix Client test                                  # 242 files, count not lower than Task 0
npm --prefix Client test -- tests/unit/livekit-session.test.ts tests/unit/livekit-e2ee.test.ts
npm --prefix Client run test:coverage                     # statements >= 91, floor ratcheted
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
npm --prefix Client run lint                              # 0 warnings, cycles <= ceiling
npm --prefix Client run knip
cd Client && npm run build:budget && node scripts/bundle-budget.mjs   # startup untouched, livekitSession ratcheted
cd Client && node scripts/check-mutation-shards.mjs       # union equals the surface incl. extracted files
cd Client && npx stryker run --mutate "src/lib/livekitSession.ts,src/lib/livekitE2EE.ts,<extracted files>" --reporters clear-text
git grep -n 'from "@lib/livekitSession"' -- 'Client/src/**' | wc -l   # still 13; consumers unmoved
git grep -n 'import("@lib/livekitSession")' -- 'Client/src/**' | wc -l # still 8
npm run check:docs && npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A supersession checkpoint is weakened by the move and the suite is "fixed" to pass       | Medium     | High   | The existing 217 + 77 test assertions are the oracle and are frozen; a split that needs one changed is wrong (Task 0 names them; Tasks 3-10 validate them unchanged)           |
| A local ESLint rule goes inert because its `files:` list still names only the old module | High       | High   | Every task that moves guarded code extends the `files:` list **in the same commit** and observes the rule red on a re-introduced violation before reverting (Tasks 3, 7, 8, 9) |
| A colocated test lands and breaks the mutation union check or `typecheck:build`          | High       | Medium | Task 1 fixes `stryker.config.mjs`, `tsconfig.build.json` and the shard list first, observed red-then-green on a throwaway file                                                 |
| The split adds an import cycle and the ceiling of 29 is breached                         | Medium     | Medium | Task 2 removes three voice-cluster cycles instead of adding; `lint` gates every commit; the ceiling only ever moves down (row 12)                                              |
| Voice code reaches the startup path and the bundle gate fails                            | Low        | High   | `livekitSession` stays a dynamic import and the facade keeps its module graph; Task 12 re-measures with the enforced gate (row 3)                                              |
| The mutation measurement is claimed from a subset that never runs in PR CI               | High       | Medium | Row 6 records it; Task 11 runs the measurement and records it, and Open question 2 asks the owner whether to wire a PR-CI step                                                 |
| `dispatcher.ts` must change, entangling the split with B7-10                             | Low        | High   | The facade surface is frozen and `dispatcher.ts` is not in the file table; a change there is recorded **BLOCKED**, not made (Dependencies)                                     |
| The split is large enough that a commit loses the "which change did it" thread           | Medium     | Medium | One ownership module per commit, facade delegating, consumers untouched; `screenShare.ts`/`roomEventHandlers.ts` are the precedent                                             |
| Coverage dips because extracted modules are new code                                     | Medium     | Medium | Colocated tests land with each module; the 91 % floor is enforced in the same PR that earns it                                                                                 |

## Out of scope

- **B7-10's work**: `dispatcher.ts`, `stores/messages.store.ts`, `MessageList.ts`,
  `MessageInput.ts` and import-cycle removal beyond voice scope. B7-9 closes
  C-12 (voice half) only (`prd.md:370`).
- **The `features/` layout migration**: a mechanical move of the whole client is
  not this milestone; Open question 1 decides only where the _new_ voice files
  live.
- **Any feature or behavior change, including the B7-11 lifecycle work** — the
  PRD's "extraction and feature behavior never share one PR" (`prd.md:408`).
- **New tests of voice behavior.** Colocated tests cover extracted units; they
  do not broaden the supersession/staleness oracle.
- **The register rows and the PRD** — the orchestrator owns those.
- **Raising any budget or floor without measurement** (the ratchet rule).

## Open questions for the owner

1. **Where do the extracted voice modules live: `src/lib/voice/**` or
   `src/features/voice/**`?** The layout-refactor supplement's directional
   target layout puts voice under `features/` and says "use the target layout
   for new or extracted code, not as a reason to bulk-move every existing file"
   (`developer-experience-layout-refactor-2026-08-29.md:243-263,386`). Every
   prior extraction, including the eight from this very module, stayed in
   `src/lib/` under the existing `@lib` alias. Options:
   **(a) `src/lib/voice/**`** — zero config change, consistent with
   `livekitReconnect.ts`/`screenShare.ts` et al, smallest diff, and the
   supplement's own rule against bulk moves supports doing the directory move
   separately. **(b) `src/features/voice/**`** — first use of the target layout;
   requires a new `@features/*` alias in `vite.config.ts`, `vitest.config.ts`
   and `tsconfig.json`, and makes this milestone also a layout migration.
   **Recommendation: (a).** It keeps the decomposition attributable and the
   consumer diff at zero; the `features/` move is a mechanical follow-up that
   the alias work would make cheap, and it is not B7-9's outcome.
2. **How is the extracted modules' mutation score obtained, given decision 5's
   PR-CI subset does not run?** `stryker.ci.config.mjs` lists only
   `permissions.ts`, its sole caller is the nightly that B7-8 landed inert on
   `dev`, and `ci.yml` has no stryker step (Verify row 6). Options:
   **(a) measure locally with the subset config and record it**, adding the
   extracted files to `stryker.ci.config.mjs` and the `livekit` shard list so
   the deferred `main` carry covers them (this is what B7-8 did for its own
   baseline). **(b) also wire the subset into the required `client-check` job**
   so PR CI enforces it, which lengthens every client PR by the run's initial
   test pass plus its mutants (a measured two-file run took 31 m locally; a
   scoped extracted-files subset would be less, but it is a new cost and a new
   required-check obligation under `docs/plans/b0-dev-branch-protection.sh`).
   **Recommendation: (a)** for B7-9, with the config entries landed so (b) is a
   one-step change when the owner wants it. Decision 5's wording is satisfied
   either way; what is not decided is whether PR CI pays for the measurement.
3. **Is the `livekitSession` bundle ceiling ratcheted in this PR?** B7-7
   adopted decision 10's 800 kB now and left "B7-9 sets the real ceiling from
   measurement" (`b7-7 plan:342`; `docs/plans/b7-0-client-baseline-2026-09-19.md:272-273`).
   The ratchet rule allows it here. Options: **(a) ratchet to measured + the
   file's existing margin** (Task 12 as written); **(b) leave 800 kB** and let
   B7-10 ratchet. **Recommendation: (a)** — the chunk is ~20 kB today, so 800 kB
   cannot detect a regression, which is the same "gate that cannot fail"
   argument B7-7 itself made.

## Acceptance

- [ ] The two largest voice modules are split into ownership-scoped files under
      one directory, each with a colocated `src/**/*.test.ts`, and
      `livekitSession.ts`'s public surface (36 bound exports, `parseUserId`, the
      test-compat getters, the dynamic-import path) is unchanged — the 13 static
      and 8 dynamic importers still compile untouched
- [ ] Supersession and staleness are proven unchanged, not assumed: the 217
      `livekit-session` and 77 `livekit-e2ee` assertions pass **without being
      rewritten**, the four local ESLint rules are armed on every new home of
      their guarded code, and a before/after per-module mutation score is
      recorded with the command that produced it
- [ ] A colocated test no longer breaks `check-mutation-shards.mjs` or
      `typecheck:build`; the union still equals the mutation surface with the
      extracted files named
- [ ] Coverage floor ratcheted to 91 % and green; `livekitSession` bundle
      ceiling ratcheted from measurement (or the owner's answer to Open
      question 3 says otherwise); startup closure unchanged and under 90 kB
- [ ] Import-cycle count not above the ceiling, lowered and re-pinned if the
      split removed cycles; `lint` 0 warnings
- [ ] `npm --prefix Client test` count not lower than Task 0's; `typecheck`,
      `typecheck:build`, `knip`, `check:docs`, `check:hygiene` and the
      `ci-check` skill green
- [ ] No new `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `.skip` /
      `.only`; no loosened assertion; no PRD, register or status-row edit
- [ ] Extraction and feature behavior are separate commits throughout — no task
      in this plan changes observable voice behavior
