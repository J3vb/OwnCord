# CI flake audit, 2026-10

**Date:** 2026-10-09
**Window:** workflow runs created from 2026-08-10 to 2026-10-09 on `dev` and on
pull requests into `dev` (CI, Desktop Artifact Smoke, Nightly Test Depth, and
the Release workflow for the update smoke).
**Audited tree:** `dev` at `610ec96`.
**Scope:** every check that went red and then passed on a rerun of the same
commit, ranked, root-caused from the job logs and the code, and fixed where the
fix is a deterministic sync point. Retries are added only where this report
proves the cause is runner infrastructure.

## 1. Method

- Runs and jobs came from the GitHub REST API (`/actions/workflows/{id}/runs`,
  then `/actions/runs/{id}/jobs?filter=all`, which returns every attempt). Logs
  were read per job.
- **Metric.** A check "flaked" in a run when its job failed or was cancelled in
  attempt _N_ and the same job succeeded in a later attempt of the same run.
  That is the only signal that isolates "red, then green on the same commit"
  from "red because the change was wrong". Failures that were never rerun are
  listed separately where they matter.
- **Population.** 2,339 CI runs in the window, of which 1,778 completed (the
  other 561 were cancelled by `concurrency.cancel-in-progress` when a newer
  push arrived; they are not flakes). 111 runs had more than one attempt.
- Jobs were fetched for the 983 runs that failed, were cancelled, or were
  rerun. Successful single-attempt runs carry no flake signal and were not
  fetched.

## 2. Ranking

Rate is flaked runs per 1,000 completed CI runs (1,778).

| Check                                | Flaked runs | Rate | Failing step                                                                                          | Cause (section)                                                                                                                                              |
| ------------------------------------ | ----------: | ---: | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client E2E (real server and media)   |          22 | 12.4 | Test two clients, real server and encrypted decoded media                                             | LiveKit signal-stream line outside a fixed 5 s window (§3.7)                                                                                                 |
| Server Build & Test (windows-latest) |          20 | 11.2 | race leg (14), deadlock leg (4), build (1), no failing step recorded (1)                              | Go 1.26.8 runtime faults (§3.8); one real test race (§3.5); one runner loss                                                                                  |
| Client E2E (Windows native)          |          17 |  9.6 | Rust transport/WebView2 (9), suites (4), NSIS (2), updater (1), Tauri build (1)                       | Transport/WebView2 step: WebView2 lifecycle on `windows-latest` (§3.9, one run examined); suites, NSIS, updater and Tauri build: unclassified                |
| Client E2E (Playwright)              |          11 |  6.2 | Install Playwright browser (5, cancelled); full suite (4); cancelled test step (1); none recorded (1) | apt mirror hang (§3.4); Vite dev server V8 abort (§3.3)                                                                                                      |
| Rust Unit Tests                      |           9 |  5.1 | Native-voice E2EE interop test                                                                        | Not root-caused here: excluded from this audit's scope, being fixed elsewhere                                                                                |
| Client E2E (parity subset, blocking) |           9 |  5.1 | production specs cancelled (4), Install Playwright browser cancelled (1), none recorded (4)           | apt mirror hang (§3.4); the production-spec cancellations may include new-push cancellations, which are not flakes by the metric above, and are unclassified |
| Server Build & Test (ubuntu-latest)  |           7 |  3.9 | deadlock leg (5), tag-gated tests (2)                                                                 | restart health polls, upload floor test (§3.8)                                                                                                               |
| Client Unit Tests                    |           5 |  2.8 | Run unit tests with coverage (3), half-hour-offset leg (2)                                            | late lazy import after teardown (§3.1, 4 of 5); jitter boundary (§3.2, 1)                                                                                    |
| Repository Hygiene + Docs & Ledger   |       2 + 2 |  2.2 | `actions/setup-node` (cancelled)                                                                      | runner provisioning; one-offs                                                                                                                                |
| Admin Panel E2E (real server)        |           2 |  1.1 | Install Playwright browser (cancelled)                                                                | apt mirror hang (§3.4)                                                                                                                                       |
| Tauri Full Build (ubuntu-22.04)      |           1 |  0.6 | Install Linux system dependencies (cancelled)                                                         | same apt class as §3.4                                                                                                                                       |

Counts follow the metric above as recorded by the API. Where a cause cell says
**unclassified** or **not root-caused**, no log or code evidence in this audit
ties those runs to the named subsystem, and they should not drive remediation
until someone examines them.

Not flakes, listed so they are not mistaken for one: `Lint`, `Go vulnerability
check` and `Client Static Checks` failures in the window were all genuine
(a new advisory or a real lint finding) and turned green only with a code
change.

## 3. Findings

### 3.1 Client Unit Tests: "Errors 4 errors" after a green suite

**Evidence.** Four of the five Client Unit flakes, including both legs:
[run 37893449701](https://github.com/J3vb/OwnCord/actions/runs/37893449701/job/113699664587),
[run 36649382365](https://github.com/J3vb/OwnCord/actions/runs/36649382365/job/109679798117),
[run 36657473528](https://github.com/J3vb/OwnCord/actions/runs/36657473528/job/109704908659),
[run 36864182946](https://github.com/J3vb/OwnCord/actions/runs/36864182946/job/110375585353).
Every test passes and the run still exits 1:

```
EnvironmentTeardownError: Cannot load '/src/lib/voiceJoinTrace.ts' imported from
  .../Client/src/lib/livekitE2EE.ts after the environment was torn down.
  - src/lib/livekitSession.ts
  - src/features/connection/dispatchContext.ts
  - src/features/connection/wsHandlers.ts
  - src/lib/dispatcher.ts
  - tests/unit/dispatcher.test.ts
This error originated in "tests/unit/dispatcher.test.ts"
 Test Files  375 passed (375)
     Errors  4 errors
```

**Root cause.** `livekitSession()` in
`Client/src/features/connection/dispatchContext.ts` is a bare dynamic
`import("../../lib/livekitSession")`, called fire-and-forget
(`void livekitSession().then(...)`) from fourteen WebSocket handlers in
`src/features/voice/wsHandlers.ts` and `src/features/connection/wsHandlers.ts`.
`tests/unit/dispatcher.test.ts` mocks `@lib/livekitSession`, but its voice tests
dispatch `voice_leave`, `voice_state`, `voice_disconnected`, `voice_token` and
`server_restart` frames synchronously and return at once; the file's
`afterEach` only unsubscribes and restores real timers. Two things combine:

1. A dynamic import resolves through vitest's module-runner RPC, which is a
   macrotask, so an import started by one of the file's last tests can still be
   in flight when vitest tears the file's environment down.
2. In vitest 4.1.11 a dynamic import of a factory-mocked module that starts
   while another import of the same module is still pending bypasses the mock
   and loads the real graph (verified with a scratch test: three concurrent
   imports got the mock once and the real module twice; sequential imports
   always got the mock). Several handlers call `livekitSession()` twice in one
   tick (a restart drop plus a kick, for one), so the second load is the real
   `livekitSession.ts` graph, whose first uncached import throws once the
   environment is gone.

The first CI leg runs with `--coverage`, which slows the real graph's load and
makes the race more likely; it is rare locally. Adding only
`vi.dynamicImportSettled()` reproduced `Errors 3 errors` locally on every run,
which is how the second cause was found.

**Fix.** [#2254](https://github.com/J3vb/OwnCord/pull/2254). Test-only. The test file wraps `livekitSession()` so
every caller shares one import of the mocked module (no second, real load), and
`afterEach` awaits `vi.dynamicImportSettled()` (the pattern
`tests/unit/video-grid.test.ts` already uses) before asserting that no lazy
loader is still in flight; that assertion fails on 81 of the file's 226 tests
without the fix. The full coverage run then reports no `Errors` line.

### 3.2 Client Unit Tests: `session-replaced.test.ts` reconnect jitter

**Evidence.** [run 37919098739](https://github.com/J3vb/OwnCord/actions/runs/37919098739/job/113782514349):

```
FAIL tests/unit/session-replaced.test.ts > SESSION_REPLACED stops the two-device
  reconnect fight > control: a plain close with no such frame still reconnects, and backs off
AssertionError: expected 1 to be +0
```

**Root cause.** `getReconnectDelay` in `Client/src/lib/ws.ts` uses equal
jitter, `lower + random() * (upper - lower)`, with `Math.random` unless the
test injects `random` through `createWsClient({ random })`. The control test
creates its client with no seam and advances fake timers by exactly 1000 ms
twice. The second attempt's delay lies in [1000, 2000) ms; when `Math.random()`
is below 0.001 the delay is 1000.x ms, `@sinonjs/fake-timers` truncates it to
1000, and the timer fires inside the 1000 ms advance that expects no connect.
About one run in a thousand, and the suite runs twice per job.

**Fix.** [#2245](https://github.com/J3vb/OwnCord/pull/2245). Pin `random` (as `ws-lifecycle.test.ts` already does), assert
the window edges explicitly, and keep the lower-endpoint case as its own test so
the truncation boundary stays pinned.

### 3.3 Client E2E (Playwright): the dev server dies mid-run

**Evidence.** All four full-suite flakes and the three failures on 2026-10-09,
for example
[run 37912555584](https://github.com/J3vb/OwnCord/actions/runs/37912555584/job/113761022871),
[run 37885477621](https://github.com/J3vb/OwnCord/actions/runs/37885477621/job/113674461012),
[run 37841420820](https://github.com/J3vb/OwnCord/actions/runs/37841420820/job/113531577066):

```
Running 753 tests using 2 workers
[WebServer] abort: Lazy deopt after a fast API call with return value is unsupported
[WebServer]     1: byteLength [node:buffer:926]
[WebServer]     2: maybePrepareFinalChunk [node:_http_outgoing:1176]
[WebServer]     4: send$1 [node_modules/vite/dist/node/chunks/node.js]
[WebServer]     5: viteTransformMiddleware [node_modules/vite/dist/node/chunks/node.js]
...
  20 failed   (page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1420/)
  1 interrupted
  328 did not run
  1 error was not a part of any test
```

**Root cause.** A V8 bug in Node 26.x (V8 14.6): when Vite's transform
middleware ends an HTTP response with a large (about 130 KB) module body,
`Buffer.byteLength` is reached through V8's fast-API-call path and the lazy
deoptimisation that follows is unsupported, so the process aborts. The dev
server is Playwright's `webServer`, so every test still to run fails on
connection refused. Only the configurations that serve through the Vite dev
server (`playwright.config.ts` and the smoke config that inherits it) take
this path; the parity and fullstack runs use `vite preview`. Node 26.11.1,
Vite 8.3.1. The same abort, with the same stack, is reported by other projects
on Node 26 with the same workaround.

**Fix.** [#2243](https://github.com/J3vb/OwnCord/pull/2243). Start Vite with the V8 flag that disables the fast-API-call
path, `node --no-turbo-fast-api-calls node_modules/vite/bin/vite.js`, and pipe
the server's stdout into the job log so a future crash is visible. A unit test
pins the command. This avoids an engine bug; it is not a retry or a timeout.

### 3.4 "Install Playwright browser" cancelled

**Evidence.** [run 37944927348, attempt 1](https://github.com/J3vb/OwnCord/actions/runs/37944927348/job/113868753597)
(job "Client E2E (Playwright)"; the same shape on the parity, admin and
fullstack jobs):

```
14:33:00  Run npx playwright install --with-deps chromium
14:33:31  Ign:2 http://azure.archive.ubuntu.com/ubuntu noble InRelease
14:33:34  Get:5 https://archive.ubuntu.com/ubuntu noble-security InRelease [126 kB]
14:57:58  ##[error]The operation was canceled.
          Terminate orphan process: pid (2436) (npm exec playwright install --with-deps chromium)
```

**Root cause.** Runner infrastructure. `playwright install --with-deps` runs
`apt-get update && apt-get install` with no bound of its own; when the
runner's apt mirror hangs, the step sits until the job's `timeout-minutes` (25)
cancels the whole job, and the red shows as "cancelled" on the job rather than
as a failed step. Nothing caches `~/.cache/ms-playwright`, so each of the five
jobs also downloads about 300 MB of browser on every run. This is the one
finding where a retry is justified: the cause is the mirror, proven by the log,
and the retry is apt's own bounded `Acquire::Retries`.

**Fix.** [#2242](https://github.com/J3vb/OwnCord/pull/2242). One shared script installs the system packages with apt
timeouts and a bounded retry under its own step `timeout-minutes`, then installs
the browser from an `actions/cache` keyed on the Playwright version. A workflow
guard (`scripts/check-workflow-guards.mjs`) fails on any unbounded
`playwright install --with-deps` step.

### 3.5 Server: `TestEventPersisterStopWaitsForGoroutineExit` (ws, Windows, race leg)

**Evidence.** [run 37806781951](https://github.com/J3vb/OwnCord/actions/runs/37806781951/job/113417015903):

```
--- FAIL: TestEventPersisterStopWaitsForGoroutineExit (1.85s)
    event_persister_test.go:148: Stop returned after 41.8149ms, want it to block for the ~200ms flush
    event_persister_test.go:154: persisted=0, want 5 (Stop must wait for the in-flight flush to finish)
```

**Root cause.** The test enqueues five events into a persister whose store
delays 200 ms, then calls `Stop` with a 20 ms context. In `run()`'s drain loop
the inner `select` offers `<-p.queue`, `<-p.stopCtxDone` and `default`. If the
run goroutine reaches the drain only after the 20 ms context has expired, which
a loaded Windows runner under `-race` can do before the goroutine's first
scheduling, both channels are ready and Go picks between them at random; taking
`stopCtxDone` first flushes an empty batch and returns. The production contract
(Stop never abandons an in-flight flush; the context only bounds the drain) is
intact. The timer in the test is the race.

**Fix.** [#2252](https://github.com/J3vb/OwnCord/pull/2252). Test-only: the context is cancelled from inside the
store's `PersistEvents`, so it is guaranteed to be done while the flush is in
flight, which is the property the test exists to prove, with no timer to lose.

### 3.6 Windows ARM64 update smoke: baseline launch and relaunch (report only)

This step runs only inside the Release workflow (`release.yml` calls
`client-artifact-smoke.yml` with `release-artifacts: true`); the nightly never
exercises it. It is being worked on elsewhere, so no fix ships with this audit;
the two failure modes seen in the window and the sync point each needs:

1. [run 37022231190, attempt 1](https://github.com/J3vb/OwnCord/actions/runs/37022231190/job/110893193596)
   (v2.1.0-beta.2; attempt 2 passed). The failure is in `relaunch()` after the
   update, not in the baseline launch: `Process exited before
http://127.0.0.1:9222/json/version was ready … app process 1044: exited (0)`
   while `owncord-client.exe` and its WebView2 processes from the previous
   instance were still running and port 9222 was still held; the app log ends
   with `second-instance launch forwarded`. The test launched a second instance
   while the installer's own restart of the app was alive, and the
   single-instance guard forwarded the launch and exited. Sync point: before
   launching, wait until no process from the old instance's tree remains and
   port 9222 is free, or adopt the installer-launched instance over CDP instead
   of launching one.
2. [run 37960484934](https://github.com/J3vb/OwnCord/actions/runs/37960484934/job/113931621203)
   (both attempts, ARM64 and x64). The baseline launch panics at WebView2
   creation, `HRESULT(0x8000FFFF) "Catastrophic failure"`, one second after
   `profile cleared 46ms`, with twelve `msedgewebview2.exe` processes from the
   preceding `artifact-journey` step still alive and no `owncord-client.exe`.
   `startNativeApp` wipes the profile while WebView2 is still tearing down the
   same user-data folder. Sync point: after `killInstalled`, wait for the
   previous instance's WebView2 child processes to exit before
   `clearNativeProfiles`.

### 3.7 Client E2E (real server and media): the long-session soak's console guard

The top row by count: 22 flaked runs, 16 failures on 2026-10-08 and 10-09 alone
across unrelated pull requests and a `dev` push
([run 37880494738](https://github.com/J3vb/OwnCord/actions/runs/37880494738/job/113659227575)).
The guard `unexpectedConsoleErrors` rejects LiveKit's
`error reading from signal stream {room: channel-3, … WS closed unexpectedly
with code 1006}` when it is logged outside the reconnect window, and the
window closes on a fixed `waitForTimeout(SIGNAL_SETTLE_MS)` of 5 s
(`tests/e2e/fullstack/long-session.spec.ts`), a sleep; the SDK's failed signal
reconnect can log later than that. This was already in hand when the audit
ran: #2208 narrowed the allow-list to the reconnect step and #2211 excuses the
line for the room the client has just left; both merged on 2026-10-09. No change
ships with this audit. Re-check the count in a week; if the line still appears,
the next step is to end the window on the SDK's own disconnect event rather
than on a timer.

### 3.8 Server Build & Test: the rest of the Windows and Linux rows

- **Go 1.26.8 runtime faults (Windows, race leg).** Every sampled Windows race
  flake before the toolchain bump was a runtime crash in `ws`, not a test:
  `fatal error: found pointer to free object`
  ([run 35965528604](https://github.com/J3vb/OwnCord/actions/runs/35965528604/job/107523525313),
  [run 35393366242](https://github.com/J3vb/OwnCord/actions/runs/35393366242/job/105756546025))
  and a nil dereference inside `net.(*TCPConn).SetKeepAliveConfig` via
  `internal/syscall/windows.SupportTCPKeepAliveIdle`
  ([run 35921740934](https://github.com/J3vb/OwnCord/actions/runs/35921740934/job/107387226693)),
  all on `go1.26.8 windows/amd64`. CI has built with Go 1.27.1 and then 1.27.2
  since the bump; none of these signatures appears on 1.27 in the window. The
  ci-check skill's known-flake table lists only the GC signature; the
  nil-dereference one is recorded here and should be added next to it once
  #2242 and #2243, which both re-pad that table, have landed.
- **`internal/app` restart tests (Windows, race leg).**
  `TestAppRun_RestartReleasesManagedCompanionBeforeHandoff` and
  `TestRun_RestartRequest_DrainsCleanly` fail with `server never became
reachable on /health`
  ([run 35503550806](https://github.com/J3vb/OwnCord/actions/runs/35503550806/job/106059424153)).
  The wait is already a deadline poll, not a sleep; the runner was slow to boot
  a second server process under `-race`. Recommendation: derive the health
  deadline from the first boot's measured time rather than a constant, and log
  the elapsed boot time on failure so the next occurrence says which.
- **`TestAppRun_EveryStageFailure_ReleasesEverythingItStarted` (Linux, deadlock
  leg).** `hub dispatch is still alive after Run returned — GracefulStop was
skipped`
  ([run 35892286448](https://github.com/J3vb/OwnCord/actions/runs/35892286448/job/107287881359)).
  A shutdown-ordering race in the test's failure injection; it passed on the
  rerun and did not recur in the window. Worth a dedicated look if it returns.
- **`TestUpload_ConcurrentLargeBodiesNeverCrossTheFloor` (Linux, api).**
  `created 7, refused 1; want all 8 admitted (96 MiB landed leaves 54 MiB,
above the 50 MiB floor)`
  ([run 35309733588](https://github.com/J3vb/OwnCord/actions/runs/35309733588/job/105489087612)).
  Already fixed: the test does not depend on the runner's free disk (its probe
  derives free space from a fixed base). The cause was a transient window in
  which a racer judged between another's store write and its landing is refused
  because the landed bytes are counted twice, which is the safe side; the
  exact-count assertion was relaxed to "at least one created, and created plus
  refused equals eight" (#1612), and the test comment documents the window.
- **`TestHandleRestoreBackup_AbortsWithoutSafetyBackup` (Windows, deadlock
  leg).** Flaked on 2026-09-12; its 4 s pre-restore window was widened to a
  120 s set of blockers on `dev` since (the comment in
  `Server/admin/handlers_backup_test.go` records it). No further occurrence.

### 3.9 Client E2E (Windows native)

Seventeen flaked runs, nine of them in "Test actual Rust transport and
WebView2". The sampled one
([run 36874199852](https://github.com/J3vb/OwnCord/actions/runs/36874199852/job/110409463317))
is `tests/e2e/native/long-session.spec.ts` timing out a `locator.click` at
30 s and passing on its Playwright retry, which `failOnFlakyTests` still counts
as red. The lane shares the WebView2 lifecycle problems of §3.6 and is owned by
the same work; this audit records the count and does not change the lane.

## 4. Needs a product decision

1. **apt retry and browser cache in CI (§3.4).** This audit adds a bounded
   apt retry because the log proves the mirror is the cause. If the project
   prefers no retries anywhere, the alternative is a step timeout alone, which
   fails fast but still costs the run. Recommendation: keep the bounded retry
   plus the cache.
2. **`cancel-in-progress` on `dev` pushes.** 151 `dev` push runs were cancelled
   by the next squash-merge, so those commits have no CI verdict of their own.
   Recommendation: exempt `refs/heads/dev` from cancellation the way `main`
   already is, at the cost of runner minutes.
3. **The dev-server e2e leg (§3.3).** The parity job already runs the full
   suite against the built bundle. Recommendation: keep the dev-server leg
   (it is what contributors run locally) with the V8 flag; revisit when Node
   ships the fix.
4. **Windows ARM64 update smoke (§3.6).** Two sync points for the owner of that
   work; no change here.
5. **The media soak window (§3.7).** Verify after a week that #2208 and #2211
   closed it; if not, replace the 5 s settle with the SDK's disconnect event.

## 5. Reproduction notes

- Rerun the ranking with the scripts in this audit's PR description or by
  hand: list runs with `gh api "repos/J3vb/OwnCord/actions/workflows/<id>/runs?per_page=100&page=N"`,
  then `gh api "repos/J3vb/OwnCord/actions/runs/<run>/jobs?filter=all"` for
  every run with `run_attempt > 1` or a failed or cancelled conclusion, and
  count per job name the attempts that failed before a later successful attempt
  of the same run.
- Job logs: `gh api repos/J3vb/OwnCord/actions/jobs/<id>/logs` (follows a
  redirect to blob storage).
