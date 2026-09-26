# Plan: B7-11 — Lifecycle ownership and long-session evidence

> **Milestone:** B7-11 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branches:** `feat/b7-11a-lifecycle-instruments` (Tasks 0–4),
> `feat/b7-11b-lifecycle-ownership` (Tasks 5–11, based on 11a) and
> `feat/b7-11c-long-session-evidence` (Tasks 12–16, based on 11b).
> **Worktree:** `.claude/worktrees/b7-11a`, `.claude/worktrees/b7-11b` and
> `.claude/worktrees/b7-11c`.
> **Drafted:** 2026-09-22. **Base commit:** `9f2d92eb` (`dev`).
> **Starts after B7-10 has landed. It has:** 10a
> (https://github.com/J3vb/OwnCord/pull/1670), 10b
> (https://github.com/J3vb/OwnCord/pull/1672) and 10c
> (https://github.com/J3vb/OwnCord/pull/1677) are all on `dev` at the base.
> Every line number below is from `9f2d92eb`. Task 0 recounts them at the real
> start commit.

## Summary

The milestone outcome is one sentence: "Timers and listeners are owned through
the existing lifecycle primitives everywhere, and a client that stays connected
for a long session is proven not to leak or misbehave, not just assumed to"
(`prd.md:323`). It closes gap row 7 (`prd.md:184`) and the lifecycle clause of
register row C-13 (`prd.md:372`;
`docs/plans/repo-health-issue-register-2026-08-23.md:216`). The roadmap names
the same work: "Centralize timer/listener ownership and test teardown, …
long-session memory" (`docs/plans/repo-health-roadmap-2026-08-23.md:956-957`),
and the phase exit requires "long-session budgets meet or improve the accepted
baseline" (`:1018-1019`). **No long-session budget exists yet. This milestone
sets it.**

**Row 7's numbers, recounted at `9f2d92eb`.** Two of them have moved and one was
wrong at B7-0:

| Measure                                            | PRD row 7 / B7-0               | At `9f2d92eb`                                                                                | Verify row |
| -------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- | ---------: |
| Lifecycle primitives                               | 2                              | 2 (`lib/disposable.ts`, `lib/sessionScope.ts`)                                               |          2 |
| Their consumers                                    | "4" (`prd.md:103`, `:295-296`) | **5**: 3 import `Disposable` and 2 import `SessionScope`. B7-0's grep counted a doc comment. |          3 |
| Files that construct an `AbortController`          | 45                             | 45 files, **55** constructions                                                               |          4 |
| Files that construct one or name `AbortSignal`     | 69 (PRD) / 68 (B7-0 command)   | **71**                                                                                       |          5 |
| `addEventListener(` / `removeEventListener(` lines | 392 / 28                       | **414 / 29**                                                                                 |          6 |
| Timers created: `setTimeout(` + `setInterval(`     | 69 + 7 = 76                    | 69 + 7 = 76; `clearTimeout(` 68, `clearInterval(` 7                                          |          8 |
| Leak assertions in test setup                      | none                           | none. `tests/setup.ts` now has an `afterEach`, but it is the console guard.                  |          9 |

**A grep count is not an ownership count, so this plan classifies every site
from the syntax tree** (the [inventory script](#appendix-the-inventory-script)).
Of 409 `addEventListener` calls, **288** pass a `signal`, **28** are
`once: true` and **93** have neither. Most of those 93 are listeners on an
element the component just created, and they are collected with the element.
**22** of them are on long-lived targets (`window`, `document`,
`navigator.mediaDevices`):

- **16** are app-lifetime singletons, each installed once at module load or
  behind a once-guard.
- **6** are per-mount listeners with a hand-paired `removeEventListener`.

Of 69 `setTimeout` calls, **17** discard their handle, so no owner can clear
them. All 7 `setInterval` calls are cleared in their own file.

**The static count cannot prove the second clause, and three fixed findings
show why.** OC-0335, OC-0336 and OC-0365 were each a listener registered **with**
a signal, but on a signal that lived longer than the thing it served. The
listener was re-registered on every render, so every discarded subtree stayed
retained (ledger titles, Verify row 20). A "does it pass a signal" check scores
all three as owned. Only a run that repeats the user's actions and counts what
is still alive can see that class. So the milestone has two instruments, and it
uses both:

1. **A static ownership inventory** (a unit test, like
   `platform-contracts-counts.test.ts` and `dispatcherDoor.test.ts`). It
   classifies every long-lived-target listener, every discarded timer handle
   and every `new AbortController`, and fails on an unowned site that is not on
   an exact, shrinking allowlist.
2. **A long-session soak** against a real server and real media. It samples
   Chromium's own counters after forced GC, via CDP: live listeners, DOM nodes,
   live `AbortController`s, live intervals and timeouts, open sockets, peer
   connections, live tracks and JS heap. It samples them across repeated
   session cycles. The pass bar is **no net growth after warm-up**, with a
   stated slope and heap tolerance. It runs short on every PR through the
   existing `client-fullstack` job and long on the nightly and on demand
   ([The long-session measurement](#the-long-session-measurement)).

A third, smaller instrument answers "no leak assertions in test setup": a
**lifecycle guard** installed from `tests/setup.ts`, beside the console guard
it mirrors. It fails a unit test that leaves a `window`/`document` listener or
a real interval alive, unless the test file is on a pinned baseline that can
only shrink.

**The milestone is three serial PRs, because the PRD's ordering rule separates
refactoring from behaviour** (`prd.md:347-349,408`).

- **11a — instruments.** The inventory test, the lifecycle guard and the soak
  harness. No production file changes. Every metric that already passes at
  the base is enforced from day one.
- **11b — ownership.** A behaviour-preserving move of the ad-hoc owners onto
  `Disposable` and `SessionScope`. Each allowlist shrinks to its floor. This
  is refactoring only, and no observable behaviour changes.
- **11c — evidence.** A fix, with a regression test, for every leak the soak or
  the guard found; after that every soak metric is enforced. It also adds the
  long run, the recorded evidence, the coverage ratchet (decision 9) and the
  docs.

**B7-11 designs no primitive.** "B7-11 extends their use, it does not design the
lifecycle primitives" (`prd.md:295-297`). `lib/disposable.ts` and
`lib/sessionScope.ts` are **not** in the file table.

## Dependencies and concurrent files

- **B7-10 has landed** (all three PRs; see the header). It left one shape for
  this milestone: `wireDispatcher`'s `unsubs` array (`dispatcher.ts:108`,
  returned as one cleanup at `:279-283`)
  (`b7-10-decompose-dispatcher-messaging-stores.plan.md:142-144,740`). **It
  stays an array.** It is already owned: `main.ts:457` registers the returned
  cleanup on the login's `SessionScope`, so disposing the session runs it. The
  same holds for `main.ts`'s `sessionUnsubs` (`:573-577`). Wrapping either in a
  `Disposable` adds a type and changes nothing. The inventory records both as
  _owner-registered disposer lists_, the accepted shape for a list of `ws.on`
  unsubscribers.
- **B7-9 and B7-10's voice and handler modules** (`src/features/**`) contain
  **no** `addEventListener` call and three timers (inventory, Verify row 7). No
  task edits them unless Task 0's recount says otherwise.
- **B7-12 through B7-16 have landed**, among them
  https://github.com/J3vb/OwnCord/pull/1655 and
  https://github.com/J3vb/OwnCord/pull/1661. Their files (`MainPage.ts`,
  `main.ts`, `ConnectPage.ts`, `ServerPanel.ts`) are in this plan's migration
  set, and nothing concurrent is editing them. B7-13's plan already flagged
  `MainPage.ts`/`auth.store.ts` as shared lifecycle territory
  (`b7-13-one-connection-isolated-profiles.plan.md:379`), and that collision is
  now moot.
- **B7-17 is in flight** (plan landed in #1663; not implemented). It adds harness
  code under `Client/tests/e2e/` and a reusable workflow, and it may touch the
  `client-native` job. It states that "long-session lifecycle evidence is
  B7-11's; this smoke is a bounded journey, not a soak"
  (`b7-17-desktop-artifact-matrix-smoke.plan.md:104-105,447`). B7-11's
  **optional** native soak (Task 14, Open question 3) edits the `client-native`
  job. **Rebase on whichever lands first and re-run the job**. Neither plan
  moves the other's specs.
- **Two open test PRs**
  (https://github.com/J3vb/OwnCord/pull/1678,
  https://github.com/J3vb/OwnCord/pull/1679) add Playwright specs under
  `tests/e2e/` (not `fullstack/`) and change no production file. There is no
  conflict. If they land first, Task 0's suite count moves.
- **The Linux native-voice effort is in flight** (branch
  `fm/linux-voice-p0`: phase 0 links the LiveKit Rust SDK in `src-tauri/`, with
  no TypeScript and no behaviour yet). It shares no file with this plan. How
  B7-11's rules bind it is in
  [Lifecycle rules for a native voice backend](#lifecycle-rules-for-a-native-voice-backend).
- **Startup bundle headroom is 5 322 B** (85 678 / 91 000, Verify row 13).
  `lib/disposable.ts` is 61 lines. 11b adds its import to modules in the
  startup closure. That costs bytes, but the headroom is ample. **Every PR still
  re-measures**, and a breach is recorded **BLOCKED**, not fixed by raising
  the budget.

## Ownership rules this milestone enforces

These four rules are the definition of "owned" that the inventory test checks.
Each is lexical and states its own ceiling. The runtime soak backs all of them.

| Rule                               | A site passes when                                                                                                                                                                                                                     | Ceiling (why the soak exists)                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** long-lived-target listeners | the receiver is `window`, `document`, `document.body`, `document.documentElement` or `navigator.*`, and the options carry a `signal` or `once: true`, or the site is on the allowlist as an **app-lifetime singleton** with a reason   | the receiver is matched by name. A `MediaQueryList` or a store-held target is not seen, and a wrong-lifetime signal (the OC-0335 class) passes |
| **R2** intervals                   | the `setInterval` result is kept, and the same file calls `clearInterval`                                                                                                                                                              | does not prove that the clear is reached on teardown                                                                                           |
| **R3** timeouts                    | the `setTimeout` result is kept (not an expression statement or `void`), or the site is on the allowlist as **self-bounded** with a reason                                                                                             | a kept handle may still never be cleared                                                                                                       |
| **R4** `new AbortController`       | the file is a lifecycle primitive, or the site is on the allowlist as a **cancellation token** with its owner named. Component, overlay and render lifetimes use `Disposable`, and session-bound async work uses `SessionScope.fork()` | none beyond R1's. This is the rule that makes "through the existing primitives" checkable                                                      |

**The allowlists are exact.** An allowlisted site that no longer exists fails
the test with "remove this entry", the same ratchet as the cycle ceiling. So
the lists only shrink. Entries are keyed by file, receiver and event, or by
file and enclosing function, never by line number, so an unrelated edit does
not churn them.

**Two `Disposable` gotchas decide how 11b migrates** (Verify row 2):

- `Disposable.addCleanup` returns nothing (`disposable.ts:20-26`). A timer
  re-armed on every keystroke must register **one** cleanup that clears the
  _current_ handle (`let t; d.addCleanup(() => clearTimeout(t))` once). If it
  registered a cleanup per re-arm, the cleanup array would grow for the
  component's lifetime, and that is a leak in its own right.
  `SessionScope.addCleanup` returns an unregister (`sessionScope.ts:48-55`), so
  per-use registration is fine there.
- `Disposable.destroy` aborts first and then runs the cleanups with **no**
  per-cleanup isolation (`:52-60`), while `SessionScope.dispose` isolates each
  one (`:85-100`). `MainPage.destroy` wraps each unsubscriber in `try/catch`
  (`MainPage.ts:1066-1073`). So a list that tolerates a throwing cleanup today
  must not become a `Disposable`, or one bad cleanup would skip the rest.
  Page-level lists stay as they are, like `unsubs`.

## The long-session measurement

**What is measured.** The measurement is taken at each sample point, after a
quiesce step: close every overlay, return to `#general` with the member list
in its default state, poll until no `.toast` remains (default toast duration
5 s, `Toast.ts:12`), then `HeapProfiler.collectGarbage` twice. Each sample
reads:

| Metric                                  | How (CDP unless noted)                                                                                                  | Pass bar                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| DOM event listeners                     | `Memory.getDOMCounters().jsEventListeners`                                                                              | **count bar**                                         |
| DOM nodes, documents                    | `Memory.getDOMCounters().nodes`, `.documents`                                                                           | **count bar**; documents exactly equal                |
| Live `AbortController`s                 | `Runtime.queryObjects(AbortController.prototype)` in a named object group, then `Runtime.releaseObjectGroup`            | **count bar**                                         |
| Live intervals, pending timeouts        | an init script wraps `setTimeout`/`setInterval`/`clear*` into an id ledger (it adds no retention; ids only)             | intervals exactly equal; timeouts **count bar**       |
| Open sockets, peer connections          | `queryObjects` on `WebSocket`/`RTCPeerConnection`, counting only `readyState` ≤ OPEN and `connectionState !== "closed"` | outside a call: **exactly 0** LiveKit sockets and PCs |
| Live media tracks, open `AudioContext`s | `queryObjects` on `MediaStreamTrack` (`readyState === "live"`) and `AudioContext` (`state !== "closed"`)                | outside a call: **0** tracks; contexts ≤ warm         |
| JS heap used                            | `Runtime.getHeapUsage().usedSize` after the GCs                                                                         | **heap bar**                                          |

- **Count bar:** the final sample is ≤ the warm sample, and the least-squares
  slope over all post-warm samples is ≤ **0.05 per cycle** (at most one leaked
  unit per 20 cycles).
- **Heap bar:** the final sample is ≤ warm × **1.10**, and the slope is ≤
  **25 KB per cycle**.
- **Warm** is the sample after cycle 5. The first cycles legitimately populate
  lazy chunks, the emoji data and the message caches.

Task 3's calibration may **tighten** these numbers and never loosen them. The
only exception is a plan amendment the owner approves.

**The instrument is proven, not assumed.** A throwaway probe run under the
repo's Playwright 1.62.1 Chromium kept 50 `AbortController`s, dropped 100 and
added 50 `window` listeners and 50 nodes. The counters read 50 / 50 / 54 nodes,
so the 100 dropped controllers were collected. After the 50 kept controllers
were released and the nodes removed, they read 0 controllers and 4 nodes, while
the 50 unremoved listeners stayed at 50: exactly the leak signal wanted
(Verify row 14). **One gotcha was observed:** the `queryObjects` result retains
every object it returns. Until its object group is released, the count cannot
fall, so the release is part of the measurement.

**What one cycle is.** Alice and Bob use the existing fullstack fixtures
(`tests/e2e/fullstack/fixtures.ts`) with `media: true`. The server seeds
`general`, `voice-one` and `voice-two` (`support/server.ts:116-124`). The soak
creates two more text channels through the same admin route. One cycle:

1. Switch across the three text channels and back.
2. Bob posts in `#general`. Alice's list gains **exactly one** row (a
   duplicate-handler check). Alice sends, edits and reacts, then removes the
   reaction.
3. Open settings and visit every tab; close it. Open and close the quick
   switcher, the emoji picker, one user popup and one channel context menu.
4. Open the DM with Bob, send one message, then close it.
5. Alice joins `voice-one`, `expectDecodedMedia`, turns the camera on and off,
   then leaves; `mediaStats(...).liveCapture` returns to 0
   (`support/media.ts:159-200`; the pattern is `media.spec.ts:26-72`).
6. **Every 5th cycle:** an application reconnect via
   `aliceTransport.offline()`/`online()` (`media.spec.ts:53-56`). **Every 10th
   cycle:** a logout and a fresh login.

Samples are taken at cycle 0 (after login), at cycle 5 (warm), and then every 5
cycles.

**"Or misbehave" is checked, not implied.** Across the whole run the soak
requires:

- zero `pageerror` events;
- zero unhandled rejections;
- zero `console.error` lines outside a named expected list (the reconnect
  cycle's own lines);
- every per-cycle functional assertion above passes (one row per message, the
  reconnect banner appears and clears exactly once, decoded media on every
  join, capture released on every leave).

**Do not count through the media probe.** `installMediaProbe` keeps every
LiveKit signaling socket, peer connection and track in arrays
(`support/media.ts:35-41,55-57`), so while it is installed, "reachable" never
falls. The soak's lifecycle probe counts by **state** (open, live, not closed),
and it uses the media probe only for `expectDecodedMedia`/`mediaStats`.

**How long, and where it runs** (Open question 2):

| Run                    | Cycles and idle                                                           | Where                                                                                                                        | Gate?                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **PR soak**            | 20 cycles, no idle phase                                                  | `client-fullstack` (Linux Chromium, real server and LiveKit, `ci.yml:1225-1262`); picked up by `testDir`, no workflow edit   | **yes**, on every PR the `integration` selector routes there                                          |
| **Long soak**          | **300 cycles, then a 30-minute idle-connected phase** sampled every 5 min | a `long-session-soak` job in `nightly-test-depth.yml`, and `npm run test:e2e:soak` on demand                                 | nightly, once the workflow is carried to `main` (it is inert on `dev`, `nightly-test-depth.yml:3-17`) |
| **Recorded evidence**  | the long soak, run once on the 11c head                                   | a developer machine, Linux Chromium                                                                                          | the milestone's proof, appended to the B7-0 baseline doc (Task 15)                                    |
| **Desktop (optional)** | 10 cycles                                                                 | the `client-native` job on Windows WebView2, over the CDP port the native harness already opens (`support/native-app.ts:41`) | Open question 3                                                                                       |

In the idle phase every count metric must be **exactly equal** across the idle
samples. This phase is what catches a poller that allocates per tick: health,
connection stats, presence, heartbeat. The idle heap bar is a slope ≤ 100 KB
per minute. The long run's cycle count is fixed by Task 3's measured seconds
per cycle, so the job fits in 60 minutes. **It is never below 200 cycles.** If
200 cycles do not fit, record that and raise it; do not shorten silently.

**What this does not measure, stated rather than hidden.** The soak measures
the TypeScript client in Chromium. On Windows the desktop shell is WebView2
(also Chromium), and Task 14 can cover it. The Linux desktop shell is WebKitGTK,
which has no CDP, so B7-11 does not measure it. Resources held in Rust
(`src-tauri/`) are invisible to webview counters. The 14-day release-candidate
soak is B10's (`repo-health-roadmap-2026-08-23.md:1316`), not this one.

## Lifecycle rules for a native voice backend

The Linux effort will run LiveKit in the Rust backend "behind the same
`livekitSession` facade", with only the room key crossing IPC (branch
`fm/linux-voice-p0`, `docs/architecture/voice-e2ee.md` addition). B7-11's rules
apply to it unchanged on the TypeScript side, plus three points that exist only
because the resource lives across IPC:

1. **Native event subscriptions are owned like listeners.** A Tauri `listen()`
   resolves its unlisten function asynchronously. The subscription is
   registered on the voice attempt's owner, and an unlisten that resolves
   after the owner was disposed is called at once. That is the pattern already
   in the tree at `platform/desktop/pushToTalkService.ts:45-51`
   (`retainListener`) and `platform/desktop/trayStatus.ts:10-21`. A discarded
   `listen()` result is a discarded handle (R3's intent), and the inventory
   counts `listen(` sites under `src/platform/desktop/`.
2. **Every native handle is released in the same teardown that disconnects the
   web room today.** This covers room ids, track ids and any IPC `Channel`. The
   teardown lives in the room-lifecycle code under `src/features/voice/` behind
   the facade, so supersession keeps working: "cleanup in an aborted path must
   be scoped to that attempt's own room" (`Client/CLAUDE.md:68-71`). A native
   backend must not add a second teardown path the facade does not own.
3. **Native resources must be countable through the facade.** The soak cannot
   see Rust-side memory, so a native backend reports its open rooms, live
   native tracks and registered event channels in the facade's existing debug
   surface (`getSessionDebugInfo`, built by `lib/livekitDiagnostics.ts:139`).
   The long-session pass bar for a native backend is then the table above, with
   those counts in place of the CDP peer-connection and track rows: **0
   outside a call, no growth across cycles**.

B7-11 does **not** edit `src-tauri/` or the native-voice branch. It records
these rules in `Client/CLAUDE.md` and `docs/architecture/client.md` (Task 16).
If the native TypeScript lands before 11b, its sites join the inventory at
Task 0's recount and are owned like every other site.

## Verify before you implement

Every row was re-derived at `9f2d92eb` with the command shown. If a row is
false at your HEAD, **stop that task and record it**; do not improvise around
it. Rows marked **(moves)** are legitimately moved by other work. For those,
record the new number in Task 0 and continue.

| #   | Claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | How to re-check                                                                                                                                                                    | Verified |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | The base is `9f2d92eb`, and it contains all three B7-10 PRs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `git log --oneline origin/dev \| grep -E '#1670\|#1672\|#1677'` → three lines                                                                                                      | yes      |
| 2   | `Disposable`: one controller, `addCleanup` returns `void`, `destroy` aborts and then runs cleanups without isolation. `SessionScope`: `addCleanup` returns an unregister, `fork`, and isolated cleanup                                                                                                                                                                                                                                                                                                                                                                                                                   | `Client/src/lib/disposable.ts:9-61` (`:20-26`, `:52-60`); `Client/src/lib/sessionScope.ts:17-101` (`:48-55`, `:58-60`, `:85-100`)                                                  | yes      |
| 3   | Consumers: `Disposable` is imported by 3 files (`MemberList.ts:9`, `TypingIndicator.ts:9`, `UserBar.ts:9`); `drag-reorder.ts:33` only mentions it in a comment. `SessionScope` is imported by 2 (`main.ts:11`, `api.ts:8`)                                                                                                                                                                                                                                                                                                                                                                                               | `git grep -nE 'from "[^"]*(disposable\|sessionScope)"' -- 'Client/src/*.ts' \| grep -v test`                                                                                       | yes      |
| 4   | 45 files construct an `AbortController`, with 55 constructions: 2 in the primitives, 3 in `api.ts` (transports already scope-owned via `owner.addCleanup`, `api.ts:138-139,709-710,747-748`) and 50 elsewhere **(moves)**                                                                                                                                                                                                                                                                                                                                                                                                | `cd Client && grep -rl 'new AbortController' src --include=*.ts \| grep -v '\.test\.ts' \| wc -l` → 45; [inventory script](#appendix-the-inventory-script) → `ac: 55, acFiles: 45` | yes      |
| 5   | 71 files construct an `AbortController` or name `AbortSignal` (PRD 69, B7-0's command 68) **(moves)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `cd Client && grep -rlE 'new AbortController\|AbortSignal' src --include=*.ts \| grep -v '\.test\.ts' \| wc -l` → 71 (B7-0's command, `b7-0-client-baseline-2026-09-19.md:169`)    | yes      |
| 6   | 414 `addEventListener(` / 29 `removeEventListener(` lines. By AST: 409 calls, 288 with `signal`, 28 `once: true`, 93 with neither, in 31 files **(moves)**                                                                                                                                                                                                                                                                                                                                                                                                                                                               | B7-0's loop (`b7-0-client-baseline-2026-09-19.md:170`); inventory script → `add: 409, signal: 288, once: 28, bare: 93, bareFiles: 31`                                              | yes      |
| 7   | 22 long-lived-target listeners have no `signal`/`once`. **16 app-lifetime singletons:** `message-list/attachments.ts:27`, `formatting.ts:119`, `media.ts:43`, `renderers.ts:19`, `lib/channel-mutes.ts:128,133`, `lib/logger.ts:139`, `lib/media-visibility.ts:171,179,184` (once-guarded), `lib/safe-render.ts:54,64` (installed once, `main.ts:113`), `main.ts:80,87,102,1108`. **6 per-mount, paired with a remove:** `MemberList.ts:322`, `MessageInput.ts:966,1035`, `lib/deviceManager.ts:102`, `main-page/GlobalKeybinds.ts:80`, `main-page/OverlayManagers.ts:144`. `src/features/**` has none                   | inventory script, "long-lived targets" list; read each site                                                                                                                        | yes      |
| 8   | Timers: `setTimeout(` 69, `setInterval(` 7, `clearTimeout(` 68, `clearInterval(` 7. Every interval is cleared in its own file (`ServerBanner.ts:37/26`, `VoiceWidget.ts:176/181`, `connectionStats.ts:192/198`, `notifications.ts:215/221`, `ws.ts:227/240`, `main.ts:934/938`, `ChannelController.ts:654/614`). **17** `setTimeout` handles are discarded, in 9 files (`AdvancedTab.ts` 5, `LogsTab.ts` 4, `content-parser.ts` 2, and one each in `MemberList.ts`, `Toast.ts`, `channel-sidebar/context-menu.ts`, `volume-menu.ts`, `lib/context-menu.ts`, `LoginForm.ts`) **(moves)**                                  | B7-0's loop; `grep -n 'setInterval(\|clearInterval(' <file>`; inventory script, "discarded timer handles"                                                                          | yes      |
| 9   | `tests/setup.ts` asserts no lifecycle state. Its only `afterEach` is the console guard's (`tests/helpers/console.ts:105`, installed at `setup.ts:64`). `vitest.config.ts` sets no `clearMocks`/`restoreMocks`/`unstubGlobals`                                                                                                                                                                                                                                                                                                                                                                                            | `Client/tests/setup.ts:26-64`; `grep -n 'clearMocks\|restoreMocks\|unstubGlobals' Client/vitest.config.ts` → none                                                                  | yes      |
| 10  | A throwaway guard (it wrapped `window`/`document` `add`/`removeEventListener` and `setInterval`/`clearInterval`, and logged what was still live at `afterEach`) found **105 tests in 20 files** that end with 158 live listeners and 9 live intervals. The top files are `media.test.ts` 22, `updater.test.ts` 17, `cert-mismatch-modal.test.ts` 14, `identity-mismatch-modal.test.ts` 14 and `server-panel.test.ts` 8; the leading events are `document:keydown` 72, `window:owncord:pref-change` 31 and `document:mousemove`/`mouseup` 24 each. The probe itself broke 3 tests in `message-list-media-release.test.ts` | a temporary `setupFiles` entry run with `npx vitest run`; not committed. Task 2 re-derives it with the real guard                                                                  | yes      |
| 11  | The suite is green: 274 files, 6 124 passed + 140 expected fail; statements 94.33 % (16 937 / 17 955) **(moves)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `cd Client && npx vitest run --coverage`                                                                                                                                           | yes      |
| 12  | The coverage floor is 92.0, and decision 9 takes it **to 93 at B7-11**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `Client/coverage-floor.json`; decision 9 at `prd.md:391`                                                                                                                           | yes      |
| 13  | The bundle gate is green: startup closure 85 678 / 91 000 B; `MainPage` 57 263 / 60 000 **(moves)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `cd Client && npm run build:budget && node scripts/bundle-budget.mjs`                                                                                                              | yes      |
| 14  | Chromium's CDP gives the soak's counters: `Memory.getDOMCounters`, `Runtime.queryObjects`/`releaseObjectGroup`, `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage` all work under the repo's Playwright 1.62.1. Dropped controllers are collected, and released ones return to 0 **only after** the query's object group is released                                                                                                                                                                                                                                                                               | a throwaway `chromium.launch()` probe with `context.newCDPSession(page)`: base `{nodes 4, listeners 0, ACs 0}` → `{54, 50, 50}` → released `{4, 50, 0}`                            | yes      |
| 15  | The fullstack harness exists and the soak can compose it: 90 s per test, a 20-minute global timeout, 1 worker (`playwright.config.fullstack.ts:6,13,8`). The job runs with `timeout-minutes: 30` (`ci.yml:1230`). The fixtures provide `login` (`fixtures.ts:15`), `joinVoice`/`expectDecodedMedia` (`support/media.ts:159,180`) and transport `offline`/`online` (`media.spec.ts:53-56`)                                                                                                                                                                                                                                | read the files                                                                                                                                                                     | yes      |
| 16  | The media probe keeps every LiveKit signaling socket, peer and track it sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `Client/tests/e2e/support/media.ts:35-41,55-57`                                                                                                                                    | yes      |
| 17  | The nightly workflow is inert on `dev` until it is carried to `main`, and a substitute trigger is forbidden. Its jobs already run 90 and 30 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `.github/workflows/nightly-test-depth.yml:1-17,40,101`                                                                                                                             | yes      |
| 18  | The Windows native job exposes WebView2 over CDP, which Playwright attaches to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `ci.yml:1263` (`client-native`, `windows-latest`, 75 min); `Client/tests/e2e/support/native-app.ts:41`; `native/packaged-update.spec.ts:92`                                        | yes      |
| 19  | Disposer lists already hang off an owner: `dispatcher.ts:108,279-283` → `main.ts:457`; `sessionUnsubs` → `main.ts:573-577`; `MainPage` `unsubscribers` (`MainPage.ts:221`) is torn down with a per-item `try/catch` (`:1066-1073`)                                                                                                                                                                                                                                                                                                                                                                                       | read the lines                                                                                                                                                                     | yes      |
| 20  | OC-0335, OC-0336 and OC-0365 are `fixed`, and each was a listener on a **longer-lived signal**, re-registered per render                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `node -e 'const l=require("./.superpowers/findings-ledger.json");for(const f of (l.findings??l))if(/OC-03(35\|36\|65)/.test(f.id))console.log(f.id,f.status,f.title)'`             | yes      |
| 21  | The PRD binds this milestone: extend the primitives rather than design them; extraction and feature behaviour never share one PR; a local-rule change is its own reviewed step; ratchets move only with the milestone that earns them                                                                                                                                                                                                                                                                                                                                                                                    | `prd.md:295-297`; `prd.md:347-349,408`; `prd.md:407`; `prd.md:412`                                                                                                                 | yes      |
| 22  | C-13 has three clauses, and only the timer one is lifecycle. "Duplicated color/host literals, many timer call sites, and an O(n) sidebar DOM-rebuild TODO". The TODO is still there                                                                                                                                                                                                                                                                                                                                                                                                                                      | `docs/plans/repo-health-issue-register-2026-08-23.md:216`; `Client/src/pages/main-page/SidebarArea.ts:662` (`TODO(H16)`)                                                           | yes      |
| 23  | Native event subscriptions today: `updater.ts:85` (kept, unlistened at `:95`), `pushToTalkService.ts:182,198` (retained through `retainListener`, `:45-51`) and `trayStatus.ts:12` (late-resolve guard, `:10-21`)                                                                                                                                                                                                                                                                                                                                                                                                        | `git grep -n 'listen<\|listen(' -- Client/src/platform`                                                                                                                            | yes      |

## Patterns to Mirror

- **A gate is a test that reads the tree.** `tests/unit/platform-contracts-counts.test.ts`
  and `src/features/dispatcherDoor.test.ts` enforce structure without an ESLint
  rule change. The inventory test is the same kind of test, using the
  TypeScript compiler API (`typescript` is already a devDependency,
  `Client/package.json:63`). Open question 1 covers the rule alternative.
- **The console guard is the template for the lifecycle guard.**
  `installConsoleGuard()` (`tests/helpers/console.ts:87-113`) installs
  `beforeEach`/`afterEach` from `tests/setup.ts:64`. It records through plain
  functions, so `vi.restoreAllMocks` cannot switch it off, and
  `tests/unit/console-guard.test.ts` proves that it fails. The lifecycle guard
  copies all three properties.
- **Child scope per render.** The OC-0335/0336/0365 fixes give each render its
  own controller and abort the previous one (`ServerPanel.ts:151`
  `currentRenderAc`, `:375` `modalAc`; `MemberList.ts:480`;
  `MessageList.ts:517` `rowAc`). 11b keeps that shape with a child `Disposable`
  per render, and the three regression tests
  (`message-list-row-listener-leak.test.ts`, the `server-panel` and GIF picker
  cases) run **unedited**.
- **Late-resolving native unlisten.** `pushToTalkService.ts:45-51` and
  `trayStatus.ts:10-21` are the only correct shapes for an async `listen()`.
- **Counts are recounted, never merged**, and **a gate is proven able to
  fail**. The inventory, the guard baseline and the soak are each observed red
  on a deliberate violation before they are trusted
  (`b7-9-decompose-voice.plan.md:201-204`).
- **Existing suites are the oracle.** A migration that needs a component test's
  assertion changed has changed behaviour (`b7-9-decompose-voice.plan.md:189-193`).

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                                                                                                                                                          | Change                                                                                                                                                         | PR       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `Client/tests/unit/lifecycle-ownership.test.ts`                                                                                                                                                               | new: the inventory (R1–R4) with exact allowlists, pinned at Task 0's recount; stale entries fail                                                               | 11a, 11b |
| `Client/tests/helpers/lifecycle.ts`, `Client/tests/setup.ts`                                                                                                                                                  | new guard, plus one `installLifecycleGuard()` line beside `installConsoleGuard()`                                                                              | 11a      |
| `Client/tests/lifecycle-guard-baseline.json`                                                                                                                                                                  | new: the test files allowed to leak at the base; shrinks in 11b, and a stale entry fails                                                                       | 11a, 11b |
| `Client/tests/unit/lifecycle-guard.test.ts`                                                                                                                                                                   | new: proves the guard fails and cannot be switched off (mirrors `console-guard.test.ts`)                                                                       | 11a      |
| `Client/tests/e2e/support/lifecycle-probe.ts`                                                                                                                                                                 | new: the CDP counters, the timer ledger init script, quiesce, and the bar evaluation                                                                           | 11a      |
| `Client/tests/e2e/fullstack/long-session.spec.ts`                                                                                                                                                             | new: the soak; `OWNCORD_SOAK_CYCLES` (default 20) and `OWNCORD_SOAK_IDLE_MIN` (default 0)                                                                      | 11a, 11c |
| `Client/playwright.config.fullstack.ts`                                                                                                                                                                       | `globalTimeout` only, and only if Task 3 measures that the soak does not fit in 20 minutes                                                                     | 11a      |
| `Client/src/**` (the migration set: the 45 lifetime `AbortController` sites of Tasks 7–8, `ChannelController.ts:259`, the 6 paired per-mount listeners and the ownable discarded timers; Verify rows 4, 7, 8) | behaviour-preserving moves onto `Disposable`/`SessionScope`; no other edit in these files                                                                      | 11b      |
| `Client/tests/unit/*.test.ts` named in the guard baseline                                                                                                                                                     | add the missing `destroy()`/teardown to tests that leak. **Add only; never loosen an assertion**                                                               | 11b      |
| `Client/src/**`, plus one regression test each                                                                                                                                                                | the fix for each leak that 11a's soak or guard recorded (Task 12)                                                                                              | 11c      |
| `Client/package.json`                                                                                                                                                                                         | `test:e2e:soak` (the long run)                                                                                                                                 | 11c      |
| `.github/workflows/nightly-test-depth.yml`                                                                                                                                                                    | a `long-session-soak` job (Open question 2)                                                                                                                    | 11c      |
| `.github/workflows/ci.yml`                                                                                                                                                                                    | the `client-native` short soak step, **only if** Open question 3 is answered yes                                                                               | 11c      |
| `Client/tests/e2e/native/long-session.spec.ts`                                                                                                                                                                | the native short soak, same condition                                                                                                                          | 11c      |
| `Client/coverage-floor.json`                                                                                                                                                                                  | 92.0 → 93.0 (decision 9)                                                                                                                                       | 11c      |
| `Client/CLAUDE.md`                                                                                                                                                                                            | a Gotchas bullet: R1–R4, the two `Disposable` gotchas, the guard and its baseline, and the native-backend rules                                                | 11a, 11c |
| `docs/architecture/client.md`                                                                                                                                                                                 | a "Lifecycle ownership" entry under _Key mechanisms_ (`:102`): the primitives, the rules and the soak                                                          | 11c      |
| `docs/plans/b7-0-client-baseline-2026-09-19.md`                                                                                                                                                               | append "B7-11 long-session baseline" after the B7-7 section (`:236`): inventory before/after, calibration, the long run (an evidence append, not a status row) | 11a, 11c |

**Not in the table, deliberately:**

- `Client/src/lib/disposable.ts` and `Client/src/lib/sessionScope.ts`. The
  primitives are not redesigned (`prd.md:295-297`). If a task seems to need a
  new method, record **BLOCKED** and raise it.
- `Client/eslint.config.js`, `Client/eslint-rules.js`. There is no rule change
  unless Open question 1 is answered (b), and then the rule is its own reviewed
  PR (`prd.md:407`), not a commit here.
- `Client/vitest.config.ts`. `clearMocks`/`restoreMocks`/`unstubGlobals` are
  mock hygiene, not leak assertions (see Out of scope).
- `Client/stryker*.mjs`, `Client/scripts/check-mutation-shards.mjs`. B7-11
  creates no file under the mutation surface (`src/lib/**`, `src/stores/**`,
  `src/features/**`). Every new file is under `tests/`. If a migration needs a
  new `src/` file, it goes in the shard list of the file it came from, and the
  union check stays green.
- `src/lib/dispatcher.ts`'s `unsubs`, `main.ts`'s `sessionUnsubs` and
  `MainPage.ts`'s `unsubscribers`. They are already owned (Verify row 19).
- `Client/src-tauri/**` and the native-voice branch.
- `Client/bundle-budgets.json`. There is nothing to ratchet, and the migration
  only has to stay under the budget.

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, the PRD, the register,
the roadmap, `docs/plans/README.md`, `CHANGELOG.md`, any other milestone's plan,
or any status row.

## Tasks

Commit after every task: a conventional subject, scope `b7-11`, one task per
commit, no `Co-Authored-By` trailer. **Every commit must leave
`npm --prefix Client test`, `lint`, `typecheck` and
`tests/unit/lifecycle-ownership.test.ts` green.** A task that would break them
is split, not skipped.

**Tasks 0–4 are PR 11a** (`feat/b7-11a-lifecycle-instruments`). **Tasks 5–11
are PR 11b** (`feat/b7-11b-lifecycle-ownership`, branched from 11a). **Tasks
12–16 are PR 11c** (`feat/b7-11c-long-session-evidence`, branched from 11b).
11a's PR targets `dev`. Each later PR targets its predecessor's branch until
that merges, and then `dev`.

### Task 0: Branch, baseline and the recount

- **Action:** create `feat/b7-11a-lifecycle-instruments` from `dev`. Re-run
  Verify rows 3–11 and 13, plus the
  [inventory script](#appendix-the-inventory-script), and record the output.
  Every **(moves)** number is replaced by what you measure. Classify every
  `new AbortController` site into one of four categories: **primitive**,
  **cancellation token** (a per-request or per-attempt abort with a named
  owner), **component/overlay lifetime**, or **per-render child**. This
  plan's working split at the base is 2 / 8 / 32 / 13; the 8 tokens are
  `api.ts` ×3, `profiles.ts:286`, `roomEventHandlers.ts:200`,
  `SearchOverlay.ts:134`, `ConnectionDiagnosticsPanel.ts:65` and
  `ChannelController.ts:259`. Classify every discarded timer as **ownable**
  (its callback touches a component's DOM or state) or **self-bounded** (it
  touches only a node it removes itself, such as `Toast.ts:48`'s 400 ms
  fallback removal).
- **Why:** the allowlists pinned in Task 1 are these classifications. A wrong
  class here becomes a wrong exemption.
- **Validate:** the suite is green; record the file and case counts and the
  statements coverage. The classification table goes in the 11a evidence
  append (Task 4).

### Task 1: The ownership inventory, red first — 11a

- **Action:** add `Client/tests/unit/lifecycle-ownership.test.ts`. It parses
  every non-test `src/**/*.ts` with the TypeScript compiler API and applies
  R1–R4 ([rules](#ownership-rules-this-milestone-enforces)). The allowlists are
  inline constants, one entry per site, keyed by file + receiver + event (R1)
  or file + enclosing function (R3, R4), each with a category and a one-line
  reason. **Pin them at Task 0's recount:** R1 has 22 entries (16 app-lifetime
  and 6 per-mount), R3 has 17 and R4 has 53 (every non-primitive site). The
  test also fails on a **stale** entry, and it prints the informational counts
  (the 93 bare listeners by file, rAF 16 / cancel 6, observers, and native
  `listen(` sites).
- **Prove it can fail:** add each of the following, observe red, delete it:
  a throwaway `window.addEventListener("resize", …)` in a component, a
  discarded `setTimeout`, and a `new AbortController()` in a new file. Then
  delete one allowlisted site's code and observe the stale-entry failure.
- **Validate:** the test passes in < 5 s; `lint`, `typecheck`,
  `typecheck:build` and `knip` are clean. Commit.

### Task 2: The unit lifecycle guard — 11a

- **Action:** add `Client/tests/helpers/lifecycle.ts` with
  `installLifecycleGuard()`, called from `tests/setup.ts` directly after
  `installConsoleGuard()`. In `beforeEach` it wraps
  `window`/`document` `add`/`removeEventListener` and the **real**
  `setInterval`/`clearInterval`, using plain functions for the same reason the
  console guard does. It records only registrations made during the test that
  pass neither `once` nor `signal` (an aborted signal releases its entry). In
  `afterEach` it fails the test when anything is still live, unless the test
  file is listed in `Client/tests/lifecycle-guard-baseline.json`. When a
  listed file runs clean, an `afterAll` fails with "remove from baseline", so
  the list only shrinks. Under `vi.useFakeTimers()` the interval half is
  skipped, because fake timers are vitest's to clean up.
- **Gotcha (Verify row 10):** the throwaway probe broke 3 tests in
  `message-list-media-release.test.ts`. **Find out why before pinning.** The
  likely cause is a test that spies on the same functions. The guard must
  wrap without changing a spied function's identity, or it must not install
  in that file's scope. Do **not** edit that test's assertions to make room
  for the guard.
- **Pin** the baseline at the measured leaking files (20 at the base). Add
  `Client/tests/unit/lifecycle-guard.test.ts`: a test that leaks a `document`
  listener fails, a `restoreAllMocks` in a `beforeEach` does not disarm the
  guard, and a signal-owned listener passes.
- **Validate:** the full suite is green with the guard on, and the file and
  case counts equal Task 0's (the guard file adds its own cases). Commit.

### Task 3: The soak harness and calibration — 11a

- **Action:** add `tests/e2e/support/lifecycle-probe.ts` (the metric table in
  [The long-session measurement](#the-long-session-measurement), the timer
  ledger `addInitScript`, `quiesce(page)` and `evaluateBars(samples)`) and
  `tests/e2e/fullstack/long-session.spec.ts` (the cycle, the samples, the
  "misbehave" checks). Attach the sample series to the report as JSON, so a
  failure shows the curve, not only the verdict.
- **Calibrate:** run `OWNCORD_SOAK_CYCLES=20 npm run test:e2e:fullstack --
long-session` **three times** at the 11a head. Record per metric the warm
  and final values, the slope, the run-to-run spread, and the **seconds per
  cycle**. A bar may be tightened to ≥ 3× the observed spread. It is never
  loosened.
- **Metrics that fail at the base are findings, not flakes.** List them in one
  `PENDING_METRICS` constant in the spec, each with the evidence (which
  counter, which cycle step it grows in, found by bisecting the cycle's steps).
  The spec reports them but does not assert them. **Every other metric is
  asserted from this commit on.** 11c must empty the constant (Task 12). A
  "misbehave" check that fails at the base is a finding too and follows the
  same route.
- **Prove it can fail:** add a throwaway `window.addEventListener` inside a
  settings tab's mount, observe the listener bar go red on the PR soak, then
  delete it.
- **Validate:** the PR soak passes within the fullstack job's budget: total
  fullstack wall time + soak ≤ 20 min `globalTimeout`, or raise
  `globalTimeout` in `playwright.config.fullstack.ts` with the measured
  number, keeping the job ≤ its 30-minute timeout. `npx tsc -p
tsconfig.e2e.json --noEmit` is clean. Commit.

### Task 4: 11a docs and gate

- **Action:** add a Gotchas bullet to `Client/CLAUDE.md` (R1–R4, where the
  allowlists live, and the guard baseline's shrink-only rule). Append the Task
  0 recount, the classification table and Task 3's calibration to
  `docs/plans/b7-0-client-baseline-2026-09-19.md`, under a new "B7-11
  long-session baseline" heading.
- **Validate:** the Validation block's 11a section, then the `ci-check` skill.
  Commit.

### Task 5: Long-lived listeners onto owners — 11b

- **Action:** move the 6 per-mount paired listeners (Verify row 7) onto their
  owner's signal. Where a listener is removed **before** the owner is torn down
  (the picker-close paths in `MessageInput.ts:966,1035`, the menu close in
  `MemberList.ts:322`), use a child `Disposable` per open that is destroyed on
  close and on owner teardown. `GlobalKeybinds` and `OverlayManagers` keep
  returning a disposer (MainPage registers both, `MainPage.ts:670,674-675`); only its
  body changes. `deviceManager.ts:102` keeps its start/stop pair, with the
  listener owned by a `Disposable` that `stop` destroys. The 16 app-lifetime
  singletons stay as they are, and their allowlist reasons are the
  documentation.
- **Validate:** R1's allowlist is down to 16. `member-list`, `message-input`,
  `device-manager`, `global-keybinds` and `overlay-managers` suites pass
  unedited. Commit.

### Task 6: Discarded timer handles — 11b

- **Action:** for each **ownable** discarded timer (Task 0), keep the handle and
  clear it in the owner's cleanup, one cleanup per component rather than per
  arm (the first `Disposable` gotcha). **Self-bounded** timers stay on R3's
  allowlist with their reason.
- **Gotcha:** clearing a timer on teardown is behaviour-preserving only if the
  timer's effect is invisible once the owner is gone: a label reset on a
  detached node, or a focus on a removed element. If clearing it would change
  something a user or test can observe, it is **not** this PR's to change.
  Leave it allowlisted as self-bounded and record it as a Task 12 candidate.
- **Validate:** R3's allowlist holds only self-bounded entries. The
  `advanced-tab`, `logs-tab`, `content-parser`, `toast` and `login-form`
  suites pass unedited. Commit.

### Task 7: Modal, overlay and menu lifetimes onto `Disposable` — 11b

- **Action:** replace the component-lifetime `AbortController` with a
  `Disposable` in the modal, overlay and menu set:
  - `CertMismatchModal.ts` (×3), `CreateChannelModal.ts`,
    `DeleteChannelModal.ts`, `EditChannelModal.ts`, `InviteManager.ts`,
    `NsfwGate.ts`, `PinnedMessages.ts`;
  - `QuickSwitchOverlay.ts`, `QuickSwitcher.ts`, `SearchOverlay.ts:42`,
    `SettingsOverlay.ts:124`, `StatusPicker.ts`, `UserProfilePopup.ts`,
    `ConnectedOverlay.ts`, `IncomingCallBanner.ts`, `AdminActions.ts` (×2);
  - `lib/modalFactory.ts`, `lib/context-menu.ts`,
    `channel-sidebar/context-menu.ts` and `volume-menu.ts`.

  That is 23 sites. The mechanical rule: `ac.signal` → `d.signal`, and
  `ac.abort()` → `d.destroy()` **at the same point in the same destroy body**.
  Keep the existing teardown order.

- **Validate:** R4's allowlist has shrunk by the migrated sites. Every touched
  component's suite passes unedited. `modal-factory.test.ts` and
  `cert-mismatch-modal.test.ts` leave the guard baseline if they now run clean.
  Commit.

### Task 8: Long-lived components and per-render children onto `Disposable` — 11b

- **Action:** the same for the remaining lifetime sites. These are:
  - `ChannelSidebar.ts` (×2), `MemberList.ts:480`, `MessageInput.ts:200`,
    `MessageList.ts` (×2), `DmSidebar.ts`, `DmProfileSidebar.ts`,
    `EmojiPicker.ts`, `GifPicker.ts`, `VoiceWidget.ts`;
  - `inline-autocomplete.ts`, `message-list/attachments.ts:1011`,
    `drag-reorder.ts`, `SettingsOverlay.ts:173`, `ServerPanel.ts` (×2),
    `SidebarMemberSection.ts`, `MainPage.ts:415`, `ConnectPage.ts:93`;
  - `lib/autoIdle.ts` and `lib/os-motion.ts`.

  Each per-render controller becomes a child `Disposable`, destroyed at the
  same point the old one was aborted. The parent registers **one** cleanup that
  destroys the current child.

- **Gotcha:** this is the task that touches the three fixed findings' code
  (`ServerPanel.ts:151,375`; `GifPicker.ts:47`; `MessageList.ts:517`). Their
  regression tests are the oracle and stay **unedited**. If one needs a
  change, the migration broke the fix, so stop.
- **Validate:** as Task 7, plus the three regression tests named in the commit
  body as passing unedited. Commit.

### Task 9: Session-bound async work onto `SessionScope` — 11b

- **Action:** `ChannelController.ts:259`'s `channelAbort` already reads
  `api.getSession()` (`:263`) and guards on ownership. Where its work is
  session-bound, make it a `session.fork()` so a logout cancels it through the
  session rather than through the channel switch alone. Keep the channel-switch
  abort by disposing the fork at the same point. The remaining cancellation
  tokens (`api.ts` ×3, `profiles.ts:286`, `roomEventHandlers.ts:200`,
  `SearchOverlay.ts:134`, `ConnectionDiagnosticsPanel.ts:65`) stay
  `AbortController`s. Each allowlist entry names its owner: the `SessionScope`
  that aborts it (`api.ts`), its timeout (`profiles.ts`) or the next attempt
  (the rest).
- **Gotcha:** if forking changes when the channel's work is cancelled in a way
  `channel-controller` tests observe (for example, cancelled on logout where
  it previously ran to a guarded no-op), that is behaviour. Leave it an
  allowlisted token and record a Task 12 candidate.
- **Validate:** R4's allowlist is at its floor: the 2 primitives plus
  cancellation tokens (≤ 8 sites). **Record the before/after "files
  constructing their own `AbortController`"** (45 → the measured floor).
  `channel-controller`, `api`, `http-sdk-lifecycle` and `ws-lifecycle` suites
  pass unedited. Commit.

### Task 10: Shrink the guard baseline — 11b

- **Action:** for each file still in `lifecycle-guard-baseline.json`, add the
  missing teardown to the test (a `destroy()`/`dispose()` in `afterEach`, or
  `resetModules` where the test re-imports a module that installs an
  app-lifetime listener). **Add teardown only; never change an assertion.** A
  file whose leak is a production leak (the component has no way to release
  the listener) stays listed and becomes a Task 12 candidate.
- **Validate:** the baseline is at its floor, and every remaining entry names
  its reason (an app-lifetime singleton under test, or a Task 12 candidate).
  The suite count is unchanged. Commit.

### Task 11: 11b gate

- **Action:** re-run the inventory script and the PR soak. Append the 11b
  before/after numbers (R1/R3/R4 allowlist sizes, the `AbortController` file
  count, `Disposable` consumers, the guard baseline size) to the evidence
  section.
- **Validate:** the Validation block's 11b section, then `ci-check`. The PR
  soak is **no worse** than 11a on every metric, since this PR is refactoring.
  Commit.

### Task 12: Fix what the instruments found — 11c

- **Action:** for each `PENDING_METRICS` entry (Task 3) and each Task 6, 9 or 10
  candidate, write the failing regression test first, then fix it, in **one
  commit per leak**. The test is a unit test when the leak reproduces in jsdom
  (the `message-list-row-listener-leak.test.ts` shape); otherwise the soak's
  own metric is the test. Then remove the entry from `PENDING_METRICS`.
- **Validate:** `PENDING_METRICS` is empty, and every soak metric is asserted.
  If there were no findings, record "no findings at 11a" in the commit body
  and the evidence, and skip to Task 13. Commit per fix.

### Task 13: The long run — 11c

- **Action:** add `"test:e2e:soak"` to `Client/package.json`. It runs the
  fullstack build with `OWNCORD_SOAK_CYCLES` set from Task 3's seconds per
  cycle (target 300, floor 200, fitting in 60 minutes) and
  `OWNCORD_SOAK_IDLE_MIN=30`. Add a `long-session-soak` job to
  `nightly-test-depth.yml` that mirrors `client-fullstack`'s setup steps
  (`ci.yml:1235-1253`), with `timeout-minutes: 90` and the report uploaded.
  **Add no substitute trigger**; the workflow stays inert until it is carried to
  `main` (`nightly-test-depth.yml:15-17`; Open question 2).
- **Validate:** `actionlint` and `zizmor --offline` pass on the workflow
  (root `CLAUDE.md`, tools table). The job definition is a verbatim copy of the
  CI job's pinned actions. Commit.

### Task 14: Desktop short soak (only if Open question 3 is yes) — 11c

- **Action:** add `tests/e2e/native/long-session.spec.ts`. It reuses
  `lifecycle-probe.ts` over the WebView2 CDP URL (`support/native-app.ts:41`)
  for 10 cycles, without the voice step unless the native harness already has
  LiveKit (it does: `ci.yml:1301`). Add it to the `native-core` project run
  in `client-native`.
- **Validate:** the job still fits in its 75-minute timeout, with the measured
  added time recorded. Rebase on B7-17 if it has landed, then re-run. Commit.

### Task 15: Record the evidence — 11c

- **Action:** run `npm --prefix Client run test:e2e:soak` once on the 11c head.
  Append to the B7-11 section of the baseline doc: the commit, the machine,
  the cycle and idle counts, the wall time, and per metric the cycle-0, warm
  and final values, the slope and the bar, plus the idle phase's samples. This
  is "proven not to leak", and it is the long-session baseline that the
  roadmap's exit criterion ratchets against
  (`repo-health-roadmap-2026-08-23.md:1018-1019`).
- **Validate:** every bar passes. A failing bar is a finding: go back to Task 12. It is not a reason to edit the bar. Commit.

### Task 16: Ratchet, docs and the final gate — 11c

- **Action:** ratchet `Client/coverage-floor.json` from 92.0 to 93.0 (decision 9,
  `prd.md:391`), **only if** measured statements coverage is ≥ 93.5. Otherwise
  record the number and raise it separately (`prd.md:412`). Add "Lifecycle
  ownership" to `docs/architecture/client.md`'s _Key mechanisms_: the two
  primitives and when to use each, R1–R4, the guard, the soak and its bars,
  and the [native-backend rules](#lifecycle-rules-for-a-native-voice-backend).
  Finish the `Client/CLAUDE.md` bullet with the native-backend rules.
- **Validate:** the Validation block's 11c section, then `ci-check`. Commit.

## Validation

```
# PR 11a
npm --prefix Client test                                   # count = Task 0's + the new guard/inventory cases
npm --prefix Client test -- tests/unit/lifecycle-ownership.test.ts tests/unit/lifecycle-guard.test.ts
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build && npm --prefix Client run lint && npm --prefix Client run knip
(cd Client && npx tsc -p tsconfig.e2e.json --noEmit)
(cd Client && OWNCORD_SOAK_CYCLES=20 npm run test:e2e:fullstack -- long-session)   # asserted metrics pass; PENDING_METRICS listed
git diff --stat origin/dev -- Client/src                   # empty: 11a changes no production file
(cd Client && npm run build:budget && node scripts/bundle-budget.mjs)
npm run check:docs && npm run check:hygiene

# PR 11b (branched from 11a)
npm --prefix Client test                                   # count not lower than 11a's; no assertion edited
git diff origin/dev...HEAD -- 'Client/tests/**' | grep -E '^-\s*(expect|assert)'   # empty: teardown added, nothing loosened
npm --prefix Client test -- tests/unit/lifecycle-ownership.test.ts      # allowlists at their floors
(cd Client && node <inventory script>)                     # AbortController files: 45 -> floor
(cd Client && OWNCORD_SOAK_CYCLES=20 npm run test:e2e:fullstack -- long-session)   # no metric worse than 11a
(cd Client && node scripts/check-mutation-shards.mjs)      # union exact
(cd Client && npm run build:budget && node scripts/bundle-budget.mjs)   # startup < 91 000
npm run check:docs && npm run check:hygiene

# PR 11c (branched from 11b)
npm --prefix Client test
npm --prefix Client run test:coverage                      # statements >= 93, floor ratcheted (or recorded)
(cd Client && OWNCORD_SOAK_CYCLES=20 npm run test:e2e:fullstack -- long-session)   # every metric asserted
npm --prefix Client run test:e2e:soak                      # the recorded long run (Task 15)
actionlint .github/workflows/*.yml && zizmor --offline .github/workflows/
npm run check:docs && npm run check:hygiene
# → then the ci-check skill on each PR
```

## Risks

| Risk                                                                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A migration changes teardown order or cancels something earlier, and a component misbehaves               | Medium     | High   | The mechanical rule keeps the same point in the same destroy body (Task 7); component suites run unedited; Tasks 6 and 9 leave any observable change allowlisted for 11c                                                                                                         |
| `Disposable.addCleanup` is called per re-arm and becomes the leak it was meant to prevent                 | Medium     | Medium | The gotcha is stated where it bites ([rules](#ownership-rules-this-milestone-enforces), Task 6); the soak's heap and listener slopes catch it                                                                                                                                    |
| A page-level disposer list moves onto `Disposable` and loses per-item `try/catch`                         | Low        | High   | Those lists are out of the file table (Verify row 19)                                                                                                                                                                                                                            |
| The soak is flaky on shared CI runners (media, timing), and people learn to retry it                      | Medium     | High   | Samples are taken after quiesce and double GC; the bars are slopes plus end-versus-warm, not single-sample equality (except documents and intervals); calibration runs 3× and bars are ≥ 3× spread; the fullstack config already fails on flaky tests in CI (`failOnFlakyTests`) |
| The PR soak pushes `client-fullstack` past its timeout                                                    | Medium     | Medium | 20 cycles, measured seconds per cycle in Task 3; `globalTimeout` raised only with the measured number and the job kept ≤ 30 min; otherwise fewer cycles (never below 10) and recorded                                                                                            |
| The media probe's arrays make every media count look like a leak                                          | High       | Medium | Count by state, not reachability (Verify row 16)                                                                                                                                                                                                                                 |
| The inventory is lexical and is gamed or misses a target (a `MediaQueryList`, a store-held `EventTarget`) | Medium     | Medium | The ceiling is stated per rule; the soak is the proof and the inventory is the ratchet; Open question 1 records the ESLint alternative                                                                                                                                           |
| The unit guard's wrapping breaks tests that spy on the same functions (as the probe did)                  | High       | Medium | Task 2 finds the cause before pinning, and never edits the affected test's assertions                                                                                                                                                                                            |
| The long soak never runs because the nightly is inert on `dev`                                            | High       | Medium | Task 15 records one on-demand long run as the milestone's evidence; the PR soak gates every PR; the job is ready for the carry to `main` (Open question 2)                                                                                                                       |
| A fix lands in the refactoring PR, and extraction and behaviour mix                                       | Medium     | Medium | 11b is refactoring only; anything observable is deferred to 11c's Task 12 (`prd.md:408`)                                                                                                                                                                                         |
| The native voice backend leaks in Rust, where the soak cannot see                                         | Medium     | High   | [Native-backend rules](#lifecycle-rules-for-a-native-voice-backend): resource counts through `getSessionDebugInfo`, with the same bar once the backend exists                                                                                                                    |
| The startup closure grows past 91 000 B from `Disposable` imports                                         | Low        | Medium | 5 322 B of headroom; re-measured in Tasks 4, 11 and 16; a breach is recorded **BLOCKED**                                                                                                                                                                                         |

## Out of scope

- **C-13's other two clauses:** the duplicated colour/host literals and the O(n)
  sidebar rebuild (`SidebarArea.ts:662`, `TODO(H16)`). See Open question 4.
- **Designing or changing `Disposable`/`SessionScope`** (`prd.md:295-297`).
- **Rewrapping the owner-registered disposer lists** (`unsubs`,
  `sessionUnsubs`, `MainPage`'s `unsubscribers`). They are already owned.
- **`clearMocks`/`restoreMocks`/`unstubGlobals` in `vitest.config.ts`.** Row 7
  lists them among the lifecycle facts (`prd.md:108`), but they are mock
  hygiene, not leak assertions. Turning them on changes the semantics of
  6 000+ tests. Raise it separately if wanted.
- **The 71 element-local bare listeners.** They are collected with their
  element. The soak's node and listener counters are what would show one that
  is not.
- **Native (Rust) resource accounting and the native-voice implementation.**
  Only the rules and the facade hook are in scope.
- **The Linux WebKitGTK shell** (no CDP) and the **14-day RC soak** (B10).
- **Mutation measurement.** B7-11 extracts no module, and decision 5's subset is
  B7-9/B7-10's (`prd.md:387`).
- **Any ESLint local-rule change** (`prd.md:407`), unless Open question 1 is
  answered (b), and then in its own PR.
- **The register rows, the PRD, the roadmap and other milestones' plans.**

## Open questions for the owner

1. **Is a test-based inventory the right gate for "owned everywhere", or should
   it be a local ESLint rule?** Options: **(a)**
   `lifecycle-ownership.test.ts` with exact shrinking allowlists, and no rule
   change (this plan); **(b)** a `local/lifecycle-owned` rule. It gives editor
   feedback, but it is a local-rule change, which `prd.md:407` makes its own
   reviewed step, and a rule's `ignores:` is coarser than a per-site allowlist
   with reasons. **Recommendation: (a).** It matches the `dispatcherDoor` and
   `platform-contracts-counts` precedent and changes no rule. (b) can follow
   later with the test's allowlist as its seed.
2. **Where does the long-session evidence run?** Options: **(a)** a 20-cycle
   soak gating every PR in `client-fullstack`, the 300-cycle + 30-minute run as
   a `nightly-test-depth.yml` job (inert until the beta carry to `main`), and
   one on-demand long run recorded as the milestone's evidence (this plan);
   **(b)** as (a) but with the long run as its own scheduled workflow on `main`
   now. That is refuted by the existing rule against a scheduled run on the
   default branch's tip (`nightly-test-depth.yml:15-17`,
   `nightly-docker-smoke.yml:1-15`). **(c)** On demand only, with no PR
   gate. **Recommendation: (a).** The PR soak is what keeps "proven" true after
   this milestone. The long run is evidence now and a gate after the carry.
3. **Should the Windows desktop shell be soaked too (Task 14)?** Options:
   **(a)** yes, 10 cycles over WebView2 CDP in `client-native`, which runs
   only when the `native` selector fires and already has LiveKit; **(b)**
   Chromium only, since WebView2 is Chromium and the TypeScript is identical.
   **Recommendation: (a)**, if the measured added time is under 10 minutes. It
   is the only run that exercises the real desktop adapter's listeners
   (`platform/desktop/*`) for a long session. Otherwise (b), with the reason
   recorded.
4. **C-13 closes only in part.** Its acceptance is "Shared tokens/config,
   lifecycle-owned timers, and measured incremental sidebar updates"
   (`repo-health-issue-register-2026-08-23.md:216`, tagged B7/B9), and the PRD
   maps all of C-13 to B7-11 (`prd.md:372`). Options: **(a)** B7-11 closes the
   lifecycle clause and records the two remaining clauses for B9's UI work; the
   register edit is the orchestrator's; **(b)** B7-11 also does the literals and
   the incremental sidebar. The sidebar is UI behaviour, and doing it here would
   put behaviour in a refactoring milestone (`prd.md:408`). **Recommendation:
   (a).**

## Acceptance

- [ ] The milestone ships as **three serial PRs**: 11a (instruments, Tasks
      0–4), 11b (ownership, Tasks 5–11) and 11c (evidence, Tasks 12–16). Each
      is green, 11a changes no production file, and 11b changes no observable
      behaviour
- [ ] `lifecycle-ownership.test.ts` enforces R1–R4 with exact allowlists and
      was observed red on each violation class and on a stale entry. At the
      end, R1 holds only the 16 app-lifetime singletons, R3 only self-bounded
      timers, and R4 only the two primitives plus named cancellation tokens
      (≤ 8 sites)
- [ ] "Files constructing their own `AbortController`" has fallen from 45 to the
      recorded floor. Component, overlay and render lifetimes use `Disposable`,
      and session-bound async work uses `SessionScope.fork()`. The primitives
      are unchanged
- [ ] `tests/setup.ts` installs the lifecycle guard. It fails a test that leaves
      a `window`/`document` listener or a real interval alive, it was proven
      unable to be switched off, and its baseline is at the recorded floor,
      with a reason for every remaining entry
- [ ] The PR soak gates every `client-fullstack` run with every metric asserted
      (`PENDING_METRICS` empty). It was observed red on a deliberate leak
- [ ] The long run (≥ 200 cycles + 30 minutes idle-connected) is recorded in
      `b7-0-client-baseline-2026-09-19.md` with its command, commit and every
      metric against its bar, and all bars pass. The nightly job exists for
      the carry
- [ ] Every leak found was fixed with a regression test written first, one
      commit each, in 11c only
- [ ] The native-backend rules are in `Client/CLAUDE.md` and
      `docs/architecture/client.md`
- [ ] The coverage floor is ratcheted from 92 to 93 and green, or the
      shortfall is recorded and raised separately. The startup closure stays
      under 91 000 B on all three PRs
- [ ] `npm --prefix Client test` count is not lower than Task 0's, with no
      assertion loosened. `typecheck`, `typecheck:build`, `knip`, `check:docs`,
      `check:hygiene` and the `ci-check` skill are green on all three PRs
- [ ] No new `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `.skip` /
      `.only`, and no PRD, register, roadmap or status-row edit

## Appendix: the inventory script

This is the script that produced Verify rows 4 and 6–8 at the base. Save it
outside the repo and run it from `Client/` with `node <path>`. Task 1's test is
its enforced form.

```js
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const ts = createRequire(process.cwd() + "/")("typescript");
const LONG_LIVED = /^(window|document|document\.body|document\.documentElement|navigator\..*)$/;
const files = execSync("git ls-files 'src/*.ts'")
  .toString()
  .trim()
  .split("\n")
  .filter((f) => !/\.(test|d)\.ts$/.test(f));
const n = {
  add: 0,
  signal: 0,
  once: 0,
  bare: 0,
  remove: 0,
  setTimeout: 0,
  discarded: 0,
  setInterval: 0,
  ac: 0,
};
const acFiles = new Set(),
  bareFiles = new Set(),
  longLived = [],
  discarded = [];
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  const at = (node) => `${f}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  (function visit(node) {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const name = ts.isPropertyAccessExpression(c)
        ? c.name.text
        : ts.isIdentifier(c)
          ? c.text
          : "";
      if (name === "addEventListener") {
        n.add++;
        const opts = node.arguments[2]?.getText(sf) ?? "";
        if (/\bsignal\b/.test(opts)) n.signal++;
        else if (/\bonce\s*:\s*true/.test(opts)) n.once++;
        else {
          n.bare++;
          bareFiles.add(f);
          const target = ts.isPropertyAccessExpression(c) ? c.expression.getText(sf) : "";
          if (LONG_LIVED.test(target))
            longLived.push(`${at(node)} ${target} ${node.arguments[0].getText(sf)}`);
        }
      } else if (name === "removeEventListener") n.remove++;
      else if (name === "setTimeout" || name === "setInterval") {
        n[name]++;
        if (ts.isExpressionStatement(node.parent) || ts.isVoidExpression(node.parent)) {
          n.discarded++;
          discarded.push(at(node));
        }
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sf) === "AbortController") {
      n.ac++;
      acFiles.add(f);
    }
    ts.forEachChild(node, visit);
  })(sf);
}
console.log({ ...n, acFiles: acFiles.size, bareFiles: bareFiles.size });
console.log("long-lived targets without signal/once:\n" + longLived.join("\n"));
console.log("discarded timer handles:\n" + discarded.join("\n"));
```

At `9f2d92eb` it prints
`{ add: 409, signal: 288, once: 28, bare: 93, remove: 29, setTimeout: 69, discarded: 17, setInterval: 7, ac: 55, acFiles: 45, bareFiles: 31 }`.
`git ls-files 'src/*.ts'` matches at every depth, including `src/main.ts`.
`'src/**/*.ts'` does **not** match top-level files, and a first draft of this
count missed `main.ts` that way.
