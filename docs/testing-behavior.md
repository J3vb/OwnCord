# Tests that detect broken behavior

This page is for anyone writing or running OwnCord tests. It explains what a
good regression test checks, which test lane covers which boundary, and what
CI does when a test is flaky.

A regression test must fail when the behavior is broken. Check what a user
would see, not how the code does it. Good examples:

- a second user receives a message exactly once;
- a permission really denies a request;
- remote audio and video actually decode;
- an updated executable serves the same database.

## Local and CI lanes

Run client commands from `Client/`, after `npm ci`. The real-server suites
also need Go on your `PATH`.

The packaged desktop apps are built and installed on four targets by
`client-artifact-smoke.yml`:

- Windows x64 and ARM64 (NSIS), on `windows-latest` and `windows-11-arm`;
- Linux x64 and ARM64 (AppImage and deb), on `ubuntu-22.04` and
  `ubuntu-22.04-arm`.

The interactive native Playwright projects still run on Windows only.

| Lane                           | Command                                                                                                                                                    | What it proves                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, integration and contract | `npm test`                                                                                                                                                 | Fast edge cases and protocol contracts. CI runs the suite a second time at `TZ=America/St_Johns` (see below)                                                          |
| Mocked browser                 | `npm run test:e2e`                                                                                                                                         | UI behavior and protocol events, with an explicit desktop IPC mock. Unexpected IPC and page errors fail                                                               |
| Mocked browser, smoke          | `npm run test:e2e:smoke`                                                                                                                                   | A smaller sample of the mocked suite. CI runs this on every browser PR against the dev server; the full suite runs against the production bundle                      |
| Production browser             | `npm run test:e2e:prod`                                                                                                                                    | The same UI suite against the built assets, bundled workers included. Its CI job keeps the old "parity" check name for branch protection                              |
| Admin                          | `npm run test:e2e:admin`                                                                                                                                   | A fresh real server and database for every attempt. Covers setup, channel changes, audit and login, plus one journey per remaining admin page                         |
| Real server, chat only         | `npm run test:e2e:fullstack -- --grep chat`                                                                                                                | Two separate users over real HTTP and WebSocket: durable history, transport loss and permission revocation                                                            |
| Full stack                     | `npm run test:e2e:fullstack`                                                                                                                               | All of the above, plus real LiveKit, decoded encrypted audio and video, browser API faults and signed server replacement                                              |
| Linux native voice             | `npm run test:e2e:native-voice`                                                                                                                            | The Linux Rust voice backend against `livekit-client` in Chromium, with E2EE on. CI runs it in the Rust Unit Tests job                                                |
| Windows native                 | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-core`                                                          | The release executable, WebView2, first-use TLS trust, cut Rust sockets, durable messages and voice controls                                                          |
| Windows native (auth and UI)   | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-no-auth --project native-authenticated --project native-extra` | The same executable. See the list below                                                                                                                               |
| Windows installer              | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-updater`                                                       | A real signed NSIS archive: corrupt and interrupted downloads, install, relaunch, new app version and kept session. See below                                         |
| Mutation                       | `npx stryker run tests/mutation/stryker.ci.config.mjs`                                                                                                     | Permission mutations, with a 90% minimum score for the measured target                                                                                                |
| Generated fuzzing              | `node scripts/ci/fuzz-ci.mjs` from the repository root                                                                                                     | Every Go package with `Fuzz` targets (found with `go test -list`) gets 30 s of generated inputs per target, not just its seed corpus                                  |
| Rust parser properties         | `cargo test -p owncord-parse` in `Client/src-tauri`                                                                                                        | proptest properties of the client's pure parsers: proxy request heads, tunnel token, pin keys, the trust decision, store files. CI runs it in the Rust Unit Tests job |
| Rust parser fuzzing            | `cargo +nightly fuzz run <target>` in `Client/src-tauri/crates/owncord-parse/fuzz`                                                                         | Nightly: every cargo-fuzz target gets 60 s of generated inputs (pinned nightly toolchain and cargo-fuzz version)                                                      |

Notes on some lanes:

- **Time zone run.** CI repeats `npm test` at `TZ=America/St_Johns`, a
  half-hour offset. An assertion that hard-codes a rendered local time then
  fails in CI, not only for contributors outside UTC.
- **Windows native (auth and UI).** `native-no-auth` covers the connect page
  and auth flows without saved credentials. `native-authenticated` logs in once
  and covers layout, channel navigation, chat, DMs, settings, appearance and
  overlays. `native-extra` covers window-state restore, tray status,
  reload and DevTools keys, external links and push-to-talk.
- **Windows installer.** The test holds the old executable locked during the
  update. This forces the shutdown race that the installer hook must wait out.

### Iterate on a focused check

While fixing a failure, start with its owning package or test file. These
examples use existing tests; substitute the package or file relevant to your
change.

| Working directory | Command                                                    | Scope                                                                                                                      |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Server/`         | `go test -count=1 ./permissions/`                          | Permission package tests, without a cached result.                                                                         |
| `Client/`         | `npm test -- tests/unit/platform-contracts-counts.test.ts` | One Vitest file. `npm test` can also select colocated `src/**/*.test.ts` files; `test:unit` is restricted to `tests/unit`. |
| Repository root   | `node --test scripts/ci-select.test.mjs`                   | The CI selector's script tests.                                                                                            |
| `Client/`         | `npm run test:e2e -- --list`                               | Discover tests in the mocked Playwright lane; this lists tests without running them.                                       |

For another Playwright lane, use its command from the table above and its
prerequisites. Confirm that the intended tests actually ran: a listing, an
empty selection or an unavailable platform is not a passing test run.
Before submitting, run the required checks for the complete change; a focused
pass does not replace coverage, tagged builds or cross-component tests.
See [contributing](contributing.md#available-commands) for the existing check
commands and working directories.

### Inspect a mocked-browser failure

From `Client/`, `npx playwright show-report playwright-report/mock` opens
the mocked lane's HTML report. Look there for the failing assertion and
retained traces, screenshots and video. Open an extracted trace with
`npx playwright show-trace <trace.zip>`, replacing `<trace.zip>` with its
actual path. For other lanes, use the report and output directory named by
that lane's Playwright config; they deliberately keep separate results.

### Media prerequisites

For media tests, run `node tests/e2e/scripts/install-livekit.mjs`. Then set
`OWNCORD_E2E_LIVEKIT_BINARY` to `tests/e2e/.bin/livekit-server` (`.exe` on
Windows). A missing prerequisite fails the suite.

The installer pins the release and the archive digest. It retries a failed
download. It keeps the verified archive in `tests/e2e/.bin/livekit-cache`,
which CI also caches, so a later run skips the download.

In CI, the native packaged tests use artifacts built by
`tests/e2e/scripts/build-native-updates.mjs`.

### What the browser full-stack tests replace

Browser full-stack tests replace only the desktop IPC. HTTP, WebSocket,
authentication, storage and key exchange all go through the real server.

Browser API probes watch peer connections. They inject microphone, device,
round-trip-time and worker-key faults. These tests must not add badges, toasts
or CSS classes just to produce the result they expect. Native tests cover Rust
IPC and certificate checks separately.

### Voice-join budget

`fullstack/voice-join-budget.spec.ts` is the client's voice-join budget. It
times seven joins into a live call, each on a fresh app socket. Each timing
runs from the click to "Voice Connected" with the peer's audio decoding. It
holds the median to `Client/voice-join-budget.json`.

Change the budget only with a CI measurement recorded in
`docs/archive/plans/b7-0-client-baseline-2026-09-19.md`.

### Performance baselines

Three opt-in measurements run against the real server (and LiveKit, for
media). They are tools, not gates: their `.measure.ts` names keep them out of
every CI run, and they never change app behaviour or settings.

| Command                        | Measures                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:e2e:stream-perf` | Watch click to first decoded, presented and full-size frame; steady call and watched-share cost on both ends (per-layer sender stats, receiver frame rate, freezes, loss, jitter, microphone and screen audio apart, main thread, heap); what stays alive after leaving |
| `npm run test:e2e:chat-perf`   | Send to acknowledged and to the other user; channel switch to the right history, cold and warm; uploads of fixed-content files (hash recorded); server restart to the client being live again                                                                           |
| `npm run test:e2e:media-cost`  | One pass over a call and a share, as rates per stream                                                                                                                                                                                                                   |

The first two need the media prerequisites above and write one header line
per run (commit, versions, machine, settings, seed) and one line per trial to
`Client/test-results/perf/<suite>.jsonl`. Summarize any number of those files
with `npm run perf:analyze -- <files> [--compare base,candidate]`: it reports
p50, p95 and a 95% interval of the median that resamples whole runs, never
single samples, and marks a scenario with a failed or unverified trial as not
eligible to back a decision.

Label what you measure with `OWNCORD_PERF_ARM` and repeat runs (not just
trials) before comparing: trials inside one run share a server and a warm
cache. `OWNCORD_PERF_TRIALS`, `OWNCORD_PERF_WINDOW_MS`, `OWNCORD_PERF_SEED`
and the rest are listed at the top of each `.measure.ts` file. Set
`OWNCORD_PERF_CHROMIUM` to run another Chromium build, such as a GPU
machine's Chrome.

The browser lane cannot see everything, and the files say so with
`unverified` rows instead of leaving gaps: the Tauri/Rust voice backend,
hardware encoders, shaped networks, SFU restarts and interrupted uploads.
Its HTTP goes through the test IPC bridge, so upload times compare arms in
this lane but are not the desktop app's absolute numbers.

### Server update tests

These tests build two real server `main` packages. A Go overlay supplies a
throwaway signing key, the upstream HTTP destination and the PID journal. The
production code for signature checks, staging, atomic replacement and restart
is unchanged.

- **A broken download** must reach the artifact, fail, leave the installed
  hash unchanged and clear staging.
- **A valid signed release** is applied through the admin UI. The new server
  must serve the new version and keep both clients signed in and in their
  channel, without the login form. It must keep messages and accept new
  traffic. In the media variant, decoded audio must resume.

### Native build settings

Native builds use `tests/e2e/scripts/native-test-config.mjs`. It sets a
separate app identifier, a fixed CDP port, and WebView settings passed through
Tauri's API. (An elevated WebView2 ignores environment overrides.) Each fresh
native process clears only the `com.owncord.e2e` profile. An installer
relaunch keeps it.

Desktop installer tests use a separate app identifier and a throwaway signing
key. They never need production signing secrets. Their TLS gateway proxies
real OwnCord traffic and supplies only release metadata and signed installer
bytes.

## Failure policy

- **One retry, for evidence only.** CI retries a failed test once to collect
  diagnostics. `failOnFlakyTests` then rejects a pass that needed the retry.
- **Tests own their resources.** Each test owns its database, ports and
  profiles. Long-lived native fixtures are scoped to a worker, and Playwright
  replaces the worker after a failure. Cleanup waits for the test's own
  process trees and captures traces before closing CDP.
- **Separate output per lane.** Screenshots, traces, process logs and JUnit
  reports go to a separate folder for each lane. Look at the first failing
  assertion before you raise a timeout.
- **Fuzzing and long simulations.** Scheduled fuzzing and long race-detector
  simulations test `dev`. Public CI never uploads generated fuzz reproducers.
  Reproduce a failure locally, then land the corpus entry together with its
  fix, as `Server/Makefile` describes.
- **Schedules.** A schedule starts only once its workflow is on the default
  branch. The checked-in list of required checks is in
  `docs/plans/b0-dev-branch-protection.sh`. Changing that file does not change
  the GitHub settings by itself.

### Quarantine

Sometimes a test fails now and then for a reason that is not fixed yet, such
as a Windows-only race or an upstream SDK timing. Such a test is
**quarantined**. It is listed in `Client/tests/e2e/quarantine.json` and left
out of the required run, so it cannot turn a required check red while the real
fix is pending. This is a tracked exception with an expiry date. It is never
"retry until green".

- **The required run keeps `failOnFlakyTests`.** Only a listed test leaves the
  required run. Anything else that needed its retry still fails the job.
- **Every entry is a JSON object** with these fields:
  - `file`, relative to `Client/`;
  - `title`, spelled exactly as in the spec;
  - `reason`: why, and what removing it waits on;
  - `owner`;
  - `added` and `expires`, both `YYYY-MM-DD`.
- **`expires` is enforced.** `Client/scripts/check-quarantine.mjs` fails when
  an entry is past its date, names a spec or title that no longer exists, or
  is missing a field. It runs in Client Static Checks and in
  `npm run check:client`.
- **Run quarantined tests with `OWNCORD_FLAKES=1`.** This lifts the configs'
  `grepInvert`, so you can confirm a fix or watch a recovery before removing
  the entry.
- **Remove an entry in the PR that fixes the flake.** The fix and the
  quarantine are separate concerns. The list only shrinks.

## Adding a regression for an escaped bug

1. Add the regression at the lowest layer that can reproduce the bug.
2. Show that it fails with the broken behavior.
3. If the failure crosses UI, network or process boundaries, also keep a small
   browser journey for it.

Expand mutation targets only after measuring their baseline. Do not lower
thresholds to make new tests pass.
