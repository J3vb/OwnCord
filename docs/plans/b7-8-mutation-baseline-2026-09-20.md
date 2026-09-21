# B7-8 mutation baseline

**Measured:** 2026-09-20
**Base commit:** `7682c4c5` (`dev`, after PR #1641)
**Branch:** `fm/b7-8-impl`
**Plan:** `.claude/plans/b7-8-mutation-baseline.plan.md`, Task 4

The headline number this milestone exists to record:

> **Full-surface mutation score: 69.80 %** over `src/lib/**` + `src/stores/**`
> (76 files, 12 387 mutants), with **3 746 errored mutants excluded from the
> score denominator** — reported here rather than hidden.

This is the first full-surface Stryker score for the client. The register's
C-16 row and every B7 document since cite "stale at 67.04 %"; that figure is a
**different surface** — 13 risky client modules on 2026-08-19, never re-run
(`docs/audit-test-coverage-2026-08-19.md:12,137`) — and is not comparable to
the number below. B7-0 recorded the harness cost (a dry run), not a score
(`docs/plans/b7-0-client-baseline-2026-09-19.md:48`).

## Honesty caveats — read these with the score

1. **Errored mutants are excluded from the denominator.** Stryker's score is
   `(killed + timeout) / (total − errors)`. Of 12 387 mutants, **3 746 (30.2 %)
   did not run to a verdict**, so the 69.80 % is computed over the remaining
   **8 641** scored mutants. Publishing the score without the error count would
   record an inflated number.
2. **The errors are almost entirely a checker artefact, not test defects.**
   Triaged by class: **3 744 `CompileError`** (the `typescript` checker rejects
   the mutated source because the mutation no longer type-checks — e.g.
   `TS2721 Cannot invoke an object which is possibly undefined`, `TS2769 No
overload matches this call`, `TS18047 'x' is possibly null`) and **2
   `RuntimeError`** (the vitest runner crashed twice on the same `a11y.ts`
   mutant: `TypeError: Cannot convert object to primitive value`). No mutant
   was errored by a genuine product defect; the class is compile-time checker
   rejection. Triaging this population is a precondition for arming any
   threshold (plan Task 5).
3. **Timeouts count as kills** in the Stryker score, and there are **27** of
   them. Run-to-run variance is therefore not yet known; the plan requires
   ~5 consecutive nightly runs to establish the spread before a threshold is
   set.
4. **Two files instrument to zero mutants** and so appear in no report: with a
   base config that mutates the whole surface these are `src/lib/constants.ts`
   (9 lines of `const` values) and `src/lib/protocolTypes.ts` (generated type
   declarations). They are counted in the 76-file union (the shard check
   passes) but contribute no mutants.

## Environment

| Tool                       | Version                        | Note                                            |
| -------------------------- | ------------------------------ | ----------------------------------------------- |
| Node / npm                 | 26.9.0 / 11.19.1               | `nvm use 26`, matching the CI pin.              |
| Stryker                    | `@stryker-mutator/core` 10.0.0 | `testRunner: vitest`, `checkers: [typescript]`. |
| Vitest / Vite / TypeScript | 4.1.11 / 8.2.2 / 6.0.3         | As `Client/package.json`.                       |
| Machine                    | 16 vCPU, 15 GB, x86_64         | A cloud container; timings are not a desktop.   |

All runs used `Client/stryker.shard.config.mjs` with `STRYKER_SHARD` set, run
serially on one machine. In CI the five shards are parallel matrix jobs on
standard runners, so the per-night wall time is the longest shard (49 min for
`livekit` here, on a busier and slower local run), not the 169-minute serial
sum.

## Headline and per-shard results

Each shard's score uses the same denominator rule (errors excluded). "Wall"
is the measured `MutationTestExecutor` duration for that shard here.

| Shard            |  Files |      Total |    Killed | Timeout |  Survived |  No cov |    Errors |   Score % | Wall       |
| ---------------- | -----: | ---------: | --------: | ------: | --------: | ------: | --------: | --------: | ---------- |
| `livekit`        |      7 |      2 901 |     1 139 |      11 |       719 |     140 |       892 |     57.24 | 49 m 34 s  |
| `audio-media`    |      8 |      1 954 |       849 |       1 |       465 |     164 |       475 |     57.47 | 25 m 02 s  |
| `transport-auth` |     17 |      3 103 |     1 599 |       1 |       460 |     103 |       940 |     73.97 | 30 m 49 s  |
| `lib-rest`       |     35 |      2 511 |     1 374 |      10 |       336 |      61 |       730 |     77.71 | 44 m 08 s  |
| `stores`         |      9 |      1 918 |     1 043 |       4 |       158 |       4 |       709 |     86.60 | 19 m 52 s  |
| **full surface** | **76** | **12 387** | **6 004** |  **27** | **2 138** | **472** | **3 746** | **69.80** | 169 m 25 s |

The five per-shard scores are not a second headline; the headline is the
full-surface row. The `stores` shard reproduces the plan's earlier independent
measurement exactly (86.60 %, 1 043 killed, 158 survived, 4 timeout, 4 no-cov,
709 errors), which is a useful cross-check on this method.

## Commands

```bash
source ~/.nvm/nvm.sh && nvm use 26

# surface size and the initial test run (Task 0 recount)
cd Client && npm run test:mutate:dry
#   Found 76 of 595 file(s); Instrumented 76 source file(s) with 12387 mutant(s)
#   Ran 5527 tests in 2 minutes and 55 seconds

# the shard union equals the configured surface
cd Client && node scripts/check-mutation-shards.mjs
#   shard union equals the configured surface: 76 files

# each shard's real run (report-only; html/json under reports/mutation/<shard>/)
cd Client
for s in livekit audio-media transport-auth lib-rest stores; do
  STRYKER_SHARD=$s npx stryker run stryker.shard.config.mjs
done
```

Per-shard report files are written to
`Client/reports/mutation/<shard>/{mutation.json,index.html}` (gitignored by
`Client/reports/`; the numbers above are transcribed from them because a
7-day CI artifact is not a durable record).

**Public-artifact decision (recorded, not an oversight).** The nightly uploads
these per-module score files and full HTML reports as artifacts on a public
repository, including for auth and E2EE modules. Surviving mutants are test
gaps rather than unfixed defects, and the pre-existing nightly already uploaded
the `permissions.ts` report, so this is accepted. It is stated here because the
repo's "no unfixed defects in public" rule (`docs/security.md`) makes it a
decision that needs recording rather than a default that goes unnoticed.

## Score interpretation for later milestones

- **B7-9/B7-10 decompose against this number.** It is a pre-decomposition
  baseline measured on `dev` at `7682c4c5`. When decomposition lands, the same
  shard configs re-measure; the score should not be expected to be flat, since
  error populations and file boundaries move.
- **The low voice scores are not a fix list here.** `livekitDiagnostics`
  (31.11 %), `livekitReconnect` (38.89 %), `connectionDiagnostics` (44.97 %) and
  `noise-suppression` (2.56 %, with 117 no-coverage mutants) are the weakest
  rows; survivor triage and fixes for the critical transport/auth/E2EE modules
  are C-16's B10 half (`repo-health-issue-register-2026-08-23.md:219`), not this
  milestone's.
- **The error column is the first thing to move the score.** 3 746 errored
  mutants are excluded today; if triage converts some to scored mutants the
  headline moves without any test or product change. That is why the threshold
  flip (plan Task 5) waits on triage plus ~5 runs' spread.

## Per-module table

Score uses `(killed + timeout) / (total − errors)`; "no cov" is Stryker's
`NoCoverage`, "errors" the `CompileError`/`RuntimeError` total.

| Module                             | Score % | Total | Killed | Timeout | Survived | No cov | Errors |
| ---------------------------------- | ------: | ----: | -----: | ------: | -------: | -----: | -----: |
| `src/lib/a11y.ts`                  |   78.90 |   138 |     86 |       0 |       10 |     13 |     29 |
| `src/lib/admin-panel.ts`           |  100.00 |    12 |     11 |       0 |        0 |      0 |      1 |
| `src/lib/api.ts`                   |   78.85 |   395 |    220 |       0 |       42 |     17 |    116 |
| `src/lib/appearance.ts`            |   75.00 |    38 |     27 |       0 |        9 |      0 |      2 |
| `src/lib/audioElements.ts`         |   68.03 |   218 |    100 |       0 |       47 |      0 |     71 |
| `src/lib/audioPipeline.ts`         |   61.32 |   345 |    148 |       1 |       91 |      3 |    102 |
| `src/lib/autoIdle.ts`              |   68.75 |    88 |     44 |       0 |       18 |      2 |     24 |
| `src/lib/avatar.ts`                |   89.36 |    82 |     42 |       0 |        5 |      0 |     35 |
| `src/lib/call-ring.ts`             |   90.91 |    58 |     30 |       0 |        3 |      0 |     25 |
| `src/lib/cert-reconnect.ts`        |  100.00 |    15 |     14 |       0 |        0 |      0 |      1 |
| `src/lib/channel-mutes.ts`         |   85.29 |    92 |     58 |       0 |       10 |      0 |     24 |
| `src/lib/channel-navigation.ts`    |   88.00 |    41 |     22 |       0 |        3 |      0 |     16 |
| `src/lib/connectionDiagnostics.ts` |   44.97 |   304 |     85 |       0 |       75 |     29 |    115 |
| `src/lib/connectionStats.ts`       |   66.18 |   225 |     90 |       0 |       46 |      0 |     89 |
| `src/lib/context-menu.ts`          |   87.72 |    66 |     50 |       0 |        7 |      0 |      9 |
| `src/lib/credentials.ts`           |   75.00 |    57 |     24 |       0 |        8 |      0 |     25 |
| `src/lib/deep-link.ts`             |   78.48 |   124 |     62 |       0 |       17 |      0 |     45 |
| `src/lib/deviceManager.ts`         |   74.32 |   229 |    136 |       0 |       47 |      0 |     46 |
| `src/lib/dispatcher.ts`            |   80.19 |   851 |    502 |       0 |      105 |     19 |    225 |
| `src/lib/disposable.ts`            |   94.74 |    21 |     18 |       0 |        1 |      0 |      2 |
| `src/lib/dom.ts`                   |   90.00 |    33 |     16 |       2 |        2 |      0 |     13 |
| `src/lib/e2eeCrypto.ts`            |   90.38 |   169 |     93 |       1 |        9 |      1 |     65 |
| `src/lib/gifProvider.ts`           |   74.07 |    37 |     20 |       0 |        7 |      0 |     10 |
| `src/lib/hostValidation.ts`        |   97.06 |    36 |     33 |       0 |        1 |      0 |      2 |
| `src/lib/httpProxy.ts`             |   66.67 |    14 |      6 |       0 |        3 |      0 |      5 |
| `src/lib/icons.ts`                 |   70.71 |   107 |     70 |       0 |       29 |      0 |      8 |
| `src/lib/identity.ts`              |   95.92 |    86 |     47 |       0 |        2 |      0 |     37 |
| `src/lib/legacyKeyMigration.ts`    |   95.00 |    41 |     19 |       0 |        1 |      0 |     21 |
| `src/lib/livekitDiagnostics.ts`    |   31.11 |   123 |     28 |       0 |       59 |      3 |     33 |
| `src/lib/livekitE2EE.ts`           |   57.27 |   896 |    372 |      10 |      239 |     46 |    229 |
| `src/lib/livekitReconnect.ts`      |   38.89 |   175 |     63 |       0 |       79 |     20 |     13 |
| `src/lib/livekitSession.ts`        |   54.27 |  1024 |    342 |       1 |      226 |     63 |    392 |
| `src/lib/livekitUrlResolver.ts`    |   65.45 |    86 |     36 |       0 |       13 |      6 |     31 |
| `src/lib/logPersistence.ts`        |  100.00 |     4 |      2 |       0 |        0 |      0 |      2 |
| `src/lib/logger.ts`                |   78.33 |   100 |     47 |       0 |       11 |      2 |     40 |
| `src/lib/logout.ts`                |  100.00 |     2 |      2 |       0 |        0 |      0 |      0 |
| `src/lib/media-visibility.ts`      |   52.67 |   188 |     69 |       0 |       49 |     13 |     57 |
| `src/lib/mentions.ts`              |   83.02 |    97 |     44 |       0 |        9 |      0 |     44 |
| `src/lib/message-navigation.ts`    |   66.67 |    14 |      6 |       0 |        3 |      0 |      5 |
| `src/lib/modalFactory.ts`          |   74.58 |   146 |     86 |       2 |       30 |      0 |     28 |
| `src/lib/noise-suppression.ts`     |    2.56 |   185 |      4 |       0 |       35 |    117 |     29 |
| `src/lib/notifications.ts`         |   80.41 |   178 |    119 |       0 |       12 |     17 |     30 |
| `src/lib/nsfw-gate.ts`             |   93.10 |    41 |     26 |       1 |        2 |      0 |     12 |
| `src/lib/os-motion.ts`             |   80.00 |    29 |     16 |       0 |        4 |      0 |      9 |
| `src/lib/pendingMessages.ts`       |   63.83 |   266 |    120 |       0 |       54 |     14 |     78 |
| `src/lib/permissions.ts`           |  100.00 |    53 |     26 |       0 |        0 |      0 |     27 |
| `src/lib/preferences.ts`           |   73.53 |    52 |     23 |       2 |        9 |      0 |     18 |
| `src/lib/presence.ts`              |   58.62 |    46 |     17 |       0 |       10 |      2 |     17 |
| `src/lib/profiles.ts`              |   70.17 |   310 |    127 |       0 |       49 |      5 |    129 |
| `src/lib/ptt.ts`                   |   65.01 |   452 |    249 |       0 |      126 |      8 |     69 |
| `src/lib/rate-limiter.ts`          |   84.44 |    58 |     38 |       0 |        7 |      0 |     13 |
| `src/lib/read-state.ts`            |   82.14 |   107 |     69 |       0 |        7 |      8 |     23 |
| `src/lib/roomEventHandlers.ts`     |   78.99 |   155 |     94 |       0 |       24 |      1 |     36 |
| `src/lib/safe-render.ts`           |   60.00 |    40 |     21 |       0 |       14 |      0 |      5 |
| `src/lib/screenShare.ts`           |   71.83 |   442 |    204 |       0 |       79 |      1 |    158 |
| `src/lib/sessionScope.ts`          |   72.13 |    73 |     44 |       0 |       17 |      0 |     12 |
| `src/lib/store.ts`                 |   91.95 |   133 |     78 |       2 |        7 |      0 |     46 |
| `src/lib/streamPreview.ts`         |   63.16 |   274 |    120 |       0 |       51 |     19 |     84 |
| `src/lib/themes.ts`                |   60.87 |    94 |     41 |       1 |       19 |      8 |     25 |
| `src/lib/toast.ts`                 |  100.00 |    18 |      8 |       0 |        0 |      0 |     10 |
| `src/lib/updater.ts`               |   75.56 |    65 |     34 |       0 |       11 |      0 |     20 |
| `src/lib/userStatus.ts`            |   69.70 |    51 |     23 |       0 |        9 |      1 |     18 |
| `src/lib/voiceTokenManager.ts`     |   50.00 |    63 |     23 |       0 |       19 |      4 |     17 |
| `src/lib/window-state.ts`          |   72.09 |    49 |     31 |       0 |        9 |      3 |      6 |
| `src/lib/ws.ts`                    |   67.62 |   458 |    236 |       0 |       90 |     23 |    109 |
| `src/stores/auth.store.ts`         |   86.84 |    64 |     33 |       0 |        3 |      2 |     26 |
| `src/stores/blocks.store.ts`       |   91.67 |    52 |     33 |       0 |        3 |      0 |     16 |
| `src/stores/channels.store.ts`     |   94.94 |   298 |    150 |       0 |        7 |      1 |    140 |
| `src/stores/dm.store.ts`           |   85.04 |   177 |    108 |       0 |       18 |      1 |     50 |
| `src/stores/emoji.store.ts`        |   68.00 |    69 |     34 |       0 |       16 |      0 |     19 |
| `src/stores/members.store.ts`      |   76.32 |   147 |     58 |       0 |       18 |      0 |     71 |
| `src/stores/messages.store.ts`     |   83.64 |   788 |    451 |       4 |       89 |      0 |    244 |
| `src/stores/ui.store.ts`           |   89.19 |    79 |     33 |       0 |        4 |      0 |     42 |
| `src/stores/voice.store.ts`        |  100.00 |   244 |    143 |       0 |        0 |      0 |    101 |

## B7-9a post-split measurement (evidence append, 2026-09-21)

B7-9a (plan `.claude/plans/b7-9-decompose-voice.plan.md`, Tasks 0–6) split
`src/lib/livekitSession.ts` into a facade plus five ownership modules under
`src/features/voice/`: `sessionState.ts`, `joinOrchestration.ts`,
`roomLifecycle.ts`, `mediaControl.ts` and `remoteTracks.ts`. The before and
after runs were made one after the other on the same machine (16 vCPU,
shared with other work), Node 26.9.0 and Stryker 10.0.0, from `Client/`:

```bash
# before: dev at 4d4e0153 (39 m 04 s)
npx stryker run --mutate "src/lib/livekitSession.ts,src/lib/livekitE2EE.ts" --reporters clear-text,json
# after: fm/b7-9a-impl at 1c6abef2 (40 m 53 s)
npx stryker run --mutate "src/lib/livekitSession.ts,src/lib/livekitE2EE.ts,src/features/voice/**/*.ts,!src/features/voice/**/*.test.ts" --reporters clear-text,json
```

| Scope                                       | Before: mutants / errors / score | After: mutants / errors / score |
| ------------------------------------------- | -------------------------------: | ------------------------------: |
| `livekitSession` (facade + extracted files) |            1 024 / 392 / 54.43 % |           1 198 / 486 / 58.29 % |
| `livekitE2EE.ts` (untouched in 9a)          |              896 / 229 / 57.27 % |             896 / 229 / 57.27 % |
| **Two-module total**                        |        **1 920 / 621 / 55.89 %** |       **2 094 / 715 / 57.80 %** |

The before run matches the plan's re-measurement exactly (55.89 %, 54.43 %,
57.27 %, 621 errors). **The pass rule holds:** the after-score over the facade
and the extracted `livekitSession` files is 58.29 %, which is 3.86 points above
54.43 %, not more than 1 point below it. The two-module total is 1.91 points
up. `livekitE2EE.ts` is byte-identical and scores identically, which puts
run-to-run noise at zero for that file.

Per module, each extracted file compared with the **same code** in the
pre-split file (the before-run's mutants bucketed by the original line ranges):

| Module (after)                     | Before, same code |    After |     Δ |
| ---------------------------------- | ----------------: | -------: | ----: |
| `features/voice/sessionState`      |           75.00 % | 100.00 % | +25.0 |
| `features/voice/joinOrchestration` |           39.73 % |  45.61 % |  +5.9 |
| `features/voice/roomLifecycle`     |           49.38 % |  56.18 % |  +6.8 |
| `features/voice/mediaControl`      |           67.65 % |  69.06 % |  +1.4 |
| `features/voice/remoteTracks`      |            0.00 % | 100.00 % |  +100 |
| `lib/livekitSession` (facade)      |           65.22 % |  64.29 % | −0.93 |

- **The rises are the colocated tests.** `livekit-session.test.ts` is
  unchanged. Every gain comes from the new `src/features/voice/*.test.ts`
  files, which kill mutants the frozen suite never reached, for example
  `parseUserId`'s anchor mutant and the remote-track stream lookups.
- **The one drop is the facade's −0.93, and none of it is lost coverage.**
  The facade gained 105 mutants (346 → 451) from the new host wiring (the
  `JoinHost`, `RoomLifecycleHost` and `MediaControlHost` object literals) and
  the one-line delegate methods. The mutation class is `ArrowFunction` /
  `BlockStatement` on wiring closures: `syncModuleRooms: () => …`,
  `reapplyMuteGain: () => …`, `setPendingMicrophoneRoom: (room) => {…}` and
  `clearPendingReconnectFields: () => {…}`. These mutants did not exist before,
  because Stryker has no call-removal mutator for the direct `this.x()` calls
  those closures replace. So the extraction added survivable mutants rather
  than un-killing old ones. The one `UpdateOperator` survivor on the wiring
  (`++this._joinGenerationCounter` → `--`) is the same mutant, surviving the
  same way, as before the split (line 793): a decreasing counter still hands
  every attempt a unique generation.
- **The errored count rises by 94** (621 → 715): the host getters and typed
  delegates are rejected by the TypeScript checker when mutated, the same
  `CompileError` class as caveat 2 above. Errors stay excluded from the
  denominator.

The oracle named before the move and unchanged after it:
`tests/unit/livekit-session.test.ts` (217 `it`s, 227 test cases) was not
edited. It passes at every commit. Its supersession/staleness cases are at
lines 403, 434, 495, 1031, 1116, 1291, 2442, 2808, 2887, 2998, 3330, 3389,
3555 and 4065. `local/no-leave-voice-when-superseded` covers the new
`joinOrchestration.ts`; a deliberately re-introduced `leaveVoice()` inside its
`!isStateConnected()` checkpoint was reported red, then reverted. The
`livekitE2EE` oracle and its three rules are 9b's.
