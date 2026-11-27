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

| Lane                             | Command                                                                                                                                                    | What it proves                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, integration and contract   | `npm test`                                                                                                                                                 | Fast edge cases and protocol contracts. CI runs the suite a second time at `TZ=America/St_Johns` (see below)                                                          |
| Mocked browser                   | `npm run test:e2e`                                                                                                                                         | UI behavior and protocol events, with an explicit desktop IPC mock. Unexpected IPC and page errors fail                                                               |
| Mocked browser, smoke            | `npm run test:e2e:smoke`                                                                                                                                   | A smaller sample of the mocked suite. CI runs this on every browser PR against the dev server; the full suite runs against the production bundle                      |
| Production browser               | `npm run test:e2e:prod`                                                                                                                                    | The same UI suite against the built assets, bundled workers included. Its CI job keeps the old "parity" check name for branch protection                              |
| Production browser, Command Deck | `npm run test:e2e:deck`                                                                                                                                    | The shell specs under Command Deck against the built assets                                                                                                           |
| Admin                            | `npm run test:e2e:admin`                                                                                                                                   | A fresh real server and database for every attempt. Covers setup, channel changes, audit and login, plus one journey per remaining admin page                         |
| Real server, chat only           | `npm run test:e2e:fullstack -- --grep chat`                                                                                                                | Two separate users over real HTTP and WebSocket: durable history, transport loss and permission revocation                                                            |
| Full stack                       | `npm run test:e2e:fullstack`                                                                                                                               | All of the above, plus real LiveKit, decoded encrypted audio and video, browser API faults and signed server replacement                                              |
| Linux native voice               | `npm run test:e2e:native-voice`                                                                                                                            | The Linux Rust voice backend against `livekit-client` in Chromium, with E2EE on. CI runs it in the Rust Unit Tests job                                                |
| Windows native                   | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-core`                                                          | The release executable, WebView2, first-use TLS trust, cut Rust sockets, durable messages and voice controls                                                          |
| Windows native (auth and UI)     | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-no-auth --project native-authenticated --project native-extra` | The same executable. See the list below                                                                                                                               |
| Windows installer                | `npx playwright test --config tests/e2e/config/playwright.config.native.ts --project native-updater`                                                       | A real signed NSIS archive: corrupt and interrupted downloads, install, relaunch, new app version and kept session. See below                                         |
| Mutation                         | `npx stryker run tests/mutation/stryker.ci.config.mjs`                                                                                                     | Permission mutations, with a 90% minimum score for the measured target                                                                                                |
| Generated fuzzing                | `node scripts/ci/fuzz-ci.mjs` from the repository root                                                                                                     | Every Go package with `Fuzz` targets (found with `go test -list`) gets 30 s of generated inputs per target, not just its seed corpus                                  |
| Rust parser properties           | `cargo test -p owncord-parse` in `Client/src-tauri`                                                                                                        | proptest properties of the client's pure parsers: proxy request heads, tunnel token, pin keys, the trust decision, store files. CI runs it in the Rust Unit Tests job |
| Rust parser fuzzing              | `cargo +nightly fuzz run <target>` in `Client/src-tauri/crates/owncord-parse/fuzz`                                                                         | Nightly: every cargo-fuzz target gets 60 s of generated inputs (pinned nightly toolchain and cargo-fuzz version)                                                      |

Every harness seeds the Classic layout on a fresh profile, with the marker that the one-time move to Command Deck is settled (so a seeded Classic stays Classic), so an empty profile does not count as a new install. A test sets `screenLayout: "deck"` or `"fresh"` to change that. A spec that clears storage must seed again. A native relaunch that keeps its profile is not seeded.

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

## What blocks what

A red check only stops work if something is set to listen to it. There are
three listeners: the branch rules on `dev` (stop a PR merge), the release
workflow (stops a tag from publishing) and nobody. This table is read from the
workflow files, not from other docs.

How to read it:

- **ci.yml** runs on a PR to `dev` or `main`, on a push to `dev` or `main`, and
  by hand. It has no tag trigger.
- On a PR **into `dev`**, `scripts/ci-select.mjs` picks jobs from the changed
  paths. A job it does not pick shows as skipped, and GitHub counts a skipped
  required check as passing. On every other ci.yml event (PR to `main`, push to
  `dev`, push to `main`) it picks everything.
- The release gate (`scripts/release/verify-gate-evidence.mjs`) counts the same
  list of required contexts, on the push-to-`main` run of the tagged commit.
  There a skipped check does not count as green, and runs from pull requests
  are ignored.

| Check (name on GitHub)                                                                                                                                                          | Where it runs                                                                                 | What it blocks                                                  | What green covers                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change selection                                                                                                                                                                | ci.yml, every event                                                                           | Nothing. If it fails, every gated job runs                      | It only decides which jobs run                                                                                                                                                                                                                                                                              |
| Server Build & Test (ubuntu-latest) and (windows-latest)                                                                                                                        | ci.yml, every event                                                                           | PR merge into `dev`; release                                    | Both legs always report. Steps run only if the server changed (PR to `dev`), so green can mean "not selected". When run: build, boot smoke, upgrade and rollback rehearsal, `-tags otel`, `wazero` and `otel,wazero` builds, `govulncheck`, generated-code checks (Linux), race tests, document gates, lint |
| Server Deadlock & Tag Tests                                                                                                                                                     | ci.yml, server change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | `-tags deadlock` tests, the `wazero` and `otel` tag-gated tests, real LiveKit proofs                                                                                                                                                                                                                        |
| Server Race Tests (db, service, api)                                                                                                                                            | ci.yml, server change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | `-race` tests for `db`, `service` and `api` (Linux)                                                                                                                                                                                                                                                         |
| Server Coverage Floor                                                                                                                                                           | ci.yml, server change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | Merged Linux coverage meets the floor in `scripts/coverage-floor.sh`                                                                                                                                                                                                                                        |
| Client Static Checks                                                                                                                                                            | ci.yml, client change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | Type checks, lint, import cycles, Knip, npm audit (shipped deps), desktop build, bundle budgets, permissions mutation hotspot                                                                                                                                                                               |
| Client Unit Tests                                                                                                                                                               | ci.yml, client change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | The client unit suite                                                                                                                                                                                                                                                                                       |
| Rust Unit Tests                                                                                                                                                                 | ci.yml, Rust change on a PR to `dev`; else always                                             | PR merge into `dev`; release                                    | The Rust crate tests, including Linux native voice                                                                                                                                                                                                                                                          |
| Repository Hygiene                                                                                                                                                              | ci.yml, every event, never skipped                                                            | PR merge into `dev`; release                                    | Formatting and repository self-tests                                                                                                                                                                                                                                                                        |
| Docs & Ledger Consistency                                                                                                                                                       | ci.yml, every event, never skipped                                                            | PR merge into `dev`; release                                    | Docs checks and the bug-hunt ledger                                                                                                                                                                                                                                                                         |
| Client E2E (Playwright)                                                                                                                                                         | ci.yml, browser change on a PR to `dev`; else always                                          | PR merge into `dev`; release                                    | The mocked-browser suite                                                                                                                                                                                                                                                                                    |
| Client E2E (parity subset, blocking)                                                                                                                                            | ci.yml, browser change on a PR to `dev`; else always                                          | PR merge into `dev`; release                                    | The production-bundle browser suite                                                                                                                                                                                                                                                                         |
| Admin Panel E2E (real server)                                                                                                                                                   | ci.yml, integration change on a PR to `dev`; else always                                      | PR merge into `dev`; release                                    | Admin panel against a fresh real server                                                                                                                                                                                                                                                                     |
| Client E2E (real server and media)                                                                                                                                              | ci.yml, integration change on a PR to `dev`; else always                                      | PR merge into `dev`; release                                    | Full-stack suite with real LiveKit                                                                                                                                                                                                                                                                          |
| Client E2E (Windows native)                                                                                                                                                     | ci.yml, native change on a PR to `dev`; else always                                           | PR merge into `dev`; release                                    | The Windows executable driven by the native Playwright projects                                                                                                                                                                                                                                             |
| Workflow Security Lint                                                                                                                                                          | ci.yml, workflow change on a PR to `dev`; else always                                         | PR merge into `dev`; release                                    | `zizmor` over `.github/workflows/`. Diff-selected on a PR to `dev`                                                                                                                                                                                                                                          |
| Supply-chain Scan                                                                                                                                                               | ci.yml, manifest or lockfile change on a PR to `dev`; else always                             | PR merge into `dev`; release                                    | `osv-scanner` over every lockfile plus `cargo-deny`. On a PR or a dev push it fails only on advisories that change adds; on `main` it is the full verdict                                                                                                                                                   |
| Analyze (go), Analyze (javascript-typescript), Analyze (actions)                                                                                                                | CodeQL default setup in repository settings, no file here                                     | PR merge into `dev`; release                                    | CodeQL scans. Names come from the branch-rule script, not a workflow in this repository                                                                                                                                                                                                                     |
| Server Lint & Invariants                                                                                                                                                        | ci.yml, server or changelog change on a PR to `dev`; else always                              | Nothing pinned (red still shows on the PR)                      | Go invariants, document gates, lint (default, `otel,wazero`, Windows)                                                                                                                                                                                                                                       |
| Secret Scan                                                                                                                                                                     | ci.yml, every event                                                                           | Nothing pinned                                                  | `gitleaks` over the working tree (full-history scan is weekly only)                                                                                                                                                                                                                                         |
| Node policy (refused major)                                                                                                                                                     | ci.yml, client change on a PR to `dev`; else always                                           | Nothing pinned                                                  | Each package root refuses the wrong Node major                                                                                                                                                                                                                                                              |
| Android APK                                                                                                                                                                     | ci.yml, Android-relevant change on a PR to `dev`; else always                                 | Nothing pinned                                                  | A signed arm64 build                                                                                                                                                                                                                                                                                        |
| Client E2E (web portal, non-blocking)                                                                                                                                           | ci.yml, web-client change on a PR to `dev`; else always                                       | Nothing: `continue-on-error`                                    | Browser portal against a real server. A red run does not fail the PR                                                                                                                                                                                                                                        |
| Server Docker Build (verify, linux/amd64 and arm64)                                                                                                                             | ci.yml, PR to `main` and push to `main` only                                                  | Nothing pinned                                                  | The server image builds and boots on both architectures                                                                                                                                                                                                                                                     |
| Tauri Full Build (windows-latest, ubuntu-22.04, ubuntu-22.04-arm)                                                                                                               | ci.yml, PR to `main` only                                                                     | Nothing pinned                                                  | A full desktop build on three runners                                                                                                                                                                                                                                                                       |
| Re-run failed jobs once                                                                                                                                                         | ci.yml, PR from this repository or push to `dev`                                              | Nothing                                                         | Asks `ci-rerun.yml` to re-run failed jobs once                                                                                                                                                                                                                                                              |
| Protocol N-1 Compatibility                                                                                                                                                      | protocol-compat.yml, PR to `dev` that touches the wire fixtures or the script; weekly; manual | Nothing pinned                                                  | The previous release's client against current server transcripts                                                                                                                                                                                                                                            |
| Verify exact-SHA gate evidence                                                                                                                                                  | release.yml, release tag (`v*`); manual dry run                                               | Release                                                         | Every required context above is green on the tagged commit's push-to-`main` run                                                                                                                                                                                                                             |
| Latest nightly drills must be green                                                                                                                                             | release.yml, release tag; manual dry run                                                      | Release                                                         | The latest scheduled Upgrade Rehearsal run succeeded and is under 72 hours old. Override: `allow_red_nightly` on a dry run, or the `RELEASE_ALLOW_RED_NIGHTLY` repository variable on a tag                                                                                                                 |
| Release is recorded in docs/STATUS.md and lists known issues, Verify client version matches tag                                                                                 | release.yml, release tag; manual dry run                                                      | Release                                                         | The version has a row in `docs/STATUS.md`, and the client manifests carry the tag's version                                                                                                                                                                                                                 |
| Build and smoke jobs: Build Tauri (Windows, Linux, Linux ARM64, Android arm64), Build server, Smoke Server Docker Image, Rehearse Upgrade and Rollback, Smoke Desktop Artifacts | release.yml, release tag; manual dry run                                                      | Release (publish needs them)                                    | The signed bundles build, the server image boots on both architectures, the previous release upgrades and rolls back, and each desktop bundle installs and runs on its own architecture, including update and rollback                                                                                      |
| Publish GitHub Release                                                                                                                                                          | release.yml, release tag; not on a dry run                                                    | Nothing, it is the release                                      | Runs only after the jobs above and a reviewer approval on the `release` environment                                                                                                                                                                                                                         |
| Upgrade Rehearsal (Upgrade and Rollback Rehearsal)                                                                                                                              | upgrade-rehearsal.yml, daily 04:00 UTC; manual; called by the release                         | Release (through "Latest nightly drills")                       | Upgrade from the newest published release and roll back, as binaries and as images, plus failure and recovery drills                                                                                                                                                                                        |
| Nightly Docker Smoke (linux/amd64 and arm64)                                                                                                                                    | nightly-docker-smoke.yml, daily 03:00 UTC; manual                                             | Nothing                                                         | The image built from `dev` boots                                                                                                                                                                                                                                                                            |
| Desktop Artifact Smoke                                                                                                                                                          | client-artifact-smoke.yml, daily 05:00 UTC; manual; called by the release                     | Nothing on its own schedule; Release when called by the release | Unsigned nightly bundles on four targets: install, boot, connect, media, recovery                                                                                                                                                                                                                           |
| Weekly Supply-chain Scan                                                                                                                                                        | weekly-supply-chain.yml, Mondays 06:00 UTC; manual                                            | Nothing                                                         | The same scan as Supply-chain Scan, over all lockfiles on `main`                                                                                                                                                                                                                                            |
| Weekly Secret Scan                                                                                                                                                              | weekly-supply-chain.yml, Mondays 06:00 UTC; manual                                            | Nothing                                                         | `gitleaks` over all history and the working tree                                                                                                                                                                                                                                                            |
| Nightly Test Depth (mutation, fuzzing, Rust fuzzing, query benchmarks, soak, in-call heap)                                                                                      | nightly-test-depth.yml, daily 21:17 UTC; manual                                               | Nothing                                                         | Deep checks of `dev`, every job at the one revision the first job pins and names in the summary. The mutation matrix is skipped if the run starts between 07:00 and 19:59 UTC                                                                                                                               |
| Load Baseline                                                                                                                                                                   | load-baseline.yml, Sundays 06:00 UTC; manual                                                  | Nothing                                                         | Capacity numbers on a 2 CPU, 4 GB limit; the unconstrained "ceiling" leg is informational only                                                                                                                                                                                                              |

Notes:

- Required on `dev` as listed in `docs/plans/b0-dev-branch-protection.sh`
  (its `contexts` list, which the release gate also reads) and in CLAUDE.md,
  which names Workflow Security Lint and Supply-chain Scan as required. The
  repository rulesets themselves cannot be read from the repository; the
  rulesets were last confirmed by the owner on: not yet.
- The web portal lane is advisory (`continue-on-error`). It stays advisory
  until it has 14 green days in a row, then it is reconsidered.
- The PR Supply-chain Scan only runs when a manifest, lockfile or scanner
  baseline changes, while the weekly scan re-scans everything. A scheduled
  workflow runs the workflow file from the default branch (`main`), so a change
  to one takes effect on the schedule only after it reaches `main`.

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
