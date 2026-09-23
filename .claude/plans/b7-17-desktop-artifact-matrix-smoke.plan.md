# Plan: B7-17 — Desktop artifact matrix and smoke

> **Milestone:** B7-17 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-17-desktop-artifact-matrix-smoke`.
> **Worktree:** `.claude/worktrees/b7-17`.
> **Drafted:** 2026-09-21. **Base commit:** `92242f4a` (`dev`).
> **Dependencies re-checked at this base:** B7-12 (update path) landed as
> #1655; B7-15's server half (#1658) landed, its client flows follow; B7-16 and
> B7-5 landed. Task 6 is gated on B7-15's client flows and says so.
> **First draft status:** every row in [Verify before you implement](#verify-before-you-implement)
> was re-derived with the command shown except row 20, which is marked
> **unverified** and is Task 0's first job.

## Implementation status — landed 2026-09-23

Held 2026-09-22 (owner decision, option C) until Linux desktop voice/video
worked — the webview has no WebRTC on any mainstream WebKitGTK — and resumed
2026-09-23 once Linux voice, camera and screen share moved into the Rust
backend (#1697, #1700, #1704, #1706, #1711, #1719). The manual real-desktop
Linux device check (device switching, headset hot-plug) is an owner task
outside this milestone; the smoke proves a join with working controls, not
device handling.

**Owner answers to the open questions** (they replace the recommendations
below): (1) release-time before `publish` plus a nightly drift run, never per
PR; (2) `tauri-driver` + `webkit2gtk-driver` under `xvfb-run` on both Linux
arches, driving the real UI — no fallback leg was needed; (3) **no signing in
the nightly** — it builds unsigned bundles, skips update and rollback,
references no signing secret and generates no key; update/rollback run only at
release time on the real signed artifacts; (4) a declared cross-compile
fallback would not fail the milestone — **not needed**, `windows-11-arm` builds
and smokes natively (row 20).

**What landed, by task:**

- Task 1 — `windows-aarch64-nsis` row in `Server/updater/assets.go`, with
  `coverage_boost_test.go` and two `client_update_test.go` cases (arm64 pair
  served; a `.sig`-only release yields 204); `docs/api.md` target list.
- Task 2 — `release.yml`: `release-client-windows` is a two-leg matrix
  (`windows-latest` x64, `windows-11-arm` ARM64, artifact
  `windows-arm64-release-assets`); all three client jobs stage through the
  shared `Client/scripts/stage-release-assets.sh`; `publish` downloads the ARM64
  assets and needs `client-artifact-smoke`.
- Task 3 — `Client/tests/e2e/support/artifact-app.ts` (one `ArtifactDriver`
  over both OSes), `artifact-smoke/journey.spec.ts`,
  `playwright.config.artifact.ts`, `npm run test:e2e:artifact`. Plan
  correction: **the shipped artifact has no CDP port** (that is a test-build
  flag, `native-test-config.mjs`), so Windows attaches through a WebView2
  `AdditionalBrowserArguments` policy for `owncord-client.exe` (HKLM); Linux
  uses tauri-driver, which release builds honour (`TAURI_WEBVIEW_AUTOMATION`).
  There is no `run-artifact-smoke.mjs`: the workflow calls Playwright directly.
- Task 4 — LiveKit arm64 archives + digests (match LiveKit's
  `checksums.txt`). Linux media runs in the native backend, which captures and
  plays through the sound server, so the Linux smoke legs start a PulseAudio
  null sink (its monitor is the source).
- Task 5 — `update.spec.ts` and a target-filtering release mode in
  `native-update-server.ts`; `run-native-updater.mjs` accepts custom Playwright
  args for the Windows step. Rollback reinstalls the previous release and
  requires it to auto-connect from the profile the update kept. Proven by a
  probe-only workflow (never committed: it generates a key) that built an
  "old" `1.2.0-alpha.3` and a "new" bundle per target, both trusting a
  run-generated key.
- Task 6 — recovery leg in `journey.spec.ts` (issue kit in settings, log out,
  recover, then the server proves the new password works, the old one is
  refused and the kit reads used).
- Task 7 — `.github/workflows/client-artifact-smoke.yml`
  (`schedule`/`workflow_dispatch` build unsigned; `workflow_call` with
  `release-artifacts: true` smokes the caller's bundles and adds update +
  rollback). The nightly build carries the release's native-voice toolchain
  step and glibc-floor check. actionlint and `zizmor --offline` clean. Its
  schedule is inert until the file reaches `main`.
- Task 8 — BPR-010 evidence and the BG-04 B7-half note; `docs/contributing.md`
  and `docs/architecture/client.md`.

**Found by the smoke and fixed here:**

- **The Linux app aborted at sign-in on X11** (`[xcb] Too much data requested
from _XRead`, both arches, intermittent). libwebrtc's audio device module
  (`audio_device_pulse_linux.o`, `audio_device_alsa_linux.o`) opens and queries
  its own X display for typing detection from whichever thread creates it — a
  Tokio worker listing devices at sign-in — racing GTK's main-thread Xlib use,
  and nothing called `XInitThreads`. Bisected on the runners (PulseAudio and
  keyring on/off), then `main.rs` calls `XInitThreads()` first: 3/3 journeys
  green on each arch in the crashing environment, where the unpatched build
  failed most runs. The unpatched binary passed locally on Ubuntu 24.04 — a
  race, which is why this needed the runner. #1722 (merged in afterwards)
  replaced that device module with the session's own `cpal` streams; the call
  stays, because libwebrtc's screen capture and `device_query` (push-to-talk)
  still open X displays off the main thread.
- Harness fixes the runners exposed: Git Bash's GNU `tar` read `D:\...` as a
  remote host (`install-livekit.mjs` now names `System32\tar.exe`); WMI's
  process query outlasted its budget on `windows-11-arm` (`killInstalled` now
  kills by image name); the Linux driver's `press()` always sent Escape.

## Summary

The milestone outcome is one sentence: "An owner can install, boot, connect,
update, roll back, use media, and recover an account on Windows x64/ARM64 and
Linux x64/ARM64 builds, all exercised by CI, not just built; Windows ARM64 tries
the native `windows-11-arm` runner first (decision 4)" (`prd.md:329`). Recounted
at `92242f4a`, **three of the four artifacts are built and one is not, and none
of the four is ever executed**:

- `.github/workflows/release.yml` has exactly three client build jobs —
  `release-client-windows` on `windows-latest` producing NSIS
  (`release.yml:94,97,129`), `release-client-linux` on `ubuntu-22.04` producing
  AppImage + deb (`:154,157,204`), and `release-client-linux-arm64` on
  `ubuntu-22.04-arm` producing the same (`:379,382,429`). There is no Windows
  ARM64 client job; `windows-11-arm` appears in this file only in the **server**
  matrix (`:273`).
- `Server/updater/assets.go:39-43` maps three Tauri updater targets and no
  `windows-aarch64-nsis` row.
- `release.yml` smokes the **server** lifecycle (`go run ./cmd/smoke`, `:329`)
  and the **server** Docker image (`smoke-server-docker`, `:491`); no client
  artifact is installed or launched anywhere in the repository. The Windows
  staging step hardcodes the x64 NSIS suffix (`:143,145`), so an ARM64 NSIS
  artifact would not even be collected.
- `git grep -il "tauri-driver\|tauri_driver\|WebKitWebDriver\|msedgedriver"`
  over the tracked tree is empty. `tauri-driver` is installed on the dev machine
  but wired into no suite; Linux Tauri automation has no home today.

**What already exists, and is the point of reuse.** The required
`Client E2E (Windows native)` job (`ci.yml:1263-1268`;
`docs/plans/b0-dev-branch-protection.sh:73`) already builds a Tauri binary,
drives it over CDP WebView2, and then builds two signed NSIS test packages and
runs a real install → update → relaunch journey
(`ci.yml:1296-1324`; `Client/tests/e2e/native/packaged-update.spec.ts:33-126`).
What it drives is a `--no-bundle` exe (`ci.yml:1298`), not the artifact
`release.yml` ships, and its updater package pair is built by a test script
(`Client/tests/e2e/scripts/build-native-updates.mjs:27-30`), not by the release
pipeline. B7-17's job is to point that machinery at the **shipped, four-target**
artifacts and to add the two platforms it has never run on — Linux and Windows
ARM64.

**The four-target matrix is two runners of work, not four.** Windows x64 and
ARM64 share one harness (`native-app.ts` is CDP-based and Windows-only,
`native-app.ts:11`); Linux x64 and ARM64 share another (WebKitGTK, which needs
`tauri-driver` + `webkit2gtk-driver`, neither wired today). The architecture is
one reusable `client-artifact-smoke.yml` with a per-OS job and a per-arch matrix
leg, in the shape `upgrade-rehearsal.yml` already uses
(`upgrade-rehearsal.yml:52-68`; called from `release.yml:601-609`), plus shared
Node/Playwright drivers under `Client/tests/e2e/artifact-smoke/` so `release.yml`
and the nightly call the same code — the reason `Server/scripts/docker-smoke.sh`
is shared between `ci.yml`, `release.yml` and `nightly-docker-smoke.yml`
(`release.yml:556-559`).

**Cost discipline is a hard constraint, not a nicety.** The recent CI-toolchain
change (#1656) gives this workflow a shape that must survive: top-level
`permissions: {}` (`release.yml:21`), `persist-credentials: false` and
`package-manager-cache: false` on every job (`release.yml`, nine each), jobs
selected by capability via `scripts/ci-select.mjs` (`:56-66,240-246`), and
`release.yml` running only on a tag with the required checks proven green
(`release.yml:3-6,38-58`; `scripts/verify-gate-evidence.mjs`). A four-OS,
four-artifact, install-and-drive matrix is expensive, so **the default placement
is release-time (pre-publish, on the artifacts that actually ship) plus a nightly
drift run — not a per-PR matrix.** That is Open question 1; the plan's tasks are
written so the placement is one wiring task, not a redesign.

**One thing the plan does not invent.** "Roll back" for a desktop client is not
a server rollback; it is reinstalling the previous version and proving the app
still boots and connects. `Server/cmd/smoke`'s upgrade/rollback rehearsal is the
server analogue (`Server/cmd/smoke/docker.go:345,377`, and the eight phases
named in `upgrade-rehearsal.yml:1-11`), and the client smoke mirrors its
"resolve the previous published release, exercise the reverse direction"
structure rather than reusing its code — the two artifacts have nothing in
common but the word.

## Dependencies and concurrent files

- **B7-12 — landed.** The client update path exists end to end
  (`Client/src/lib/updater.ts` → `platform/desktop/updater.ts` → the Rust
  commands; `Client/src-tauri/src/update_commands.rs:127-136`). B7-17 exercises
  it, it does not change it.
- **B7-15 — server half landed (#1658), client flows in progress.** The smoke's
  "recover an account" step is B7-15's recovery flow (recovery kit / recover /
  emergency codes) driven through the real server. Task 7 is gated on that
  landing and records the gate; if it has not landed, the task stops rather than
  improvises.
- **B7-16 — landed.** External content goes through the bounded broker. The
  media/connect smoke must not reintroduce a direct fetch path to make a check
  pass; a failure there is B7-16's contract talking.
- **B7-5 — landed.** Media/devices/window/deep-links reach native APIs through
  the adapter. The smoke drives the app, not the adapter.
- **B7-11 — not a dependency.** Long-session lifecycle evidence is B7-11's;
  this smoke is a bounded journey, not a soak.
- **No shared production file** with any in-flight milestone. The plan touches
  `release.yml`, `Server/updater/assets.go`, a new reusable workflow, and new
  test/harness code under `Client/tests/e2e/`. If a task needs to edit
  `Client/src/**` or `Server/**` beyond the updater asset map, that is a signal
  the smoke is testing the wrong layer — record **BLOCKED**.

## Verify before you implement

Every row was re-derived at `92242f4a` with the command shown unless marked
otherwise. If a row is false at your HEAD, **stop that task and record it**; do
not improvise around it.

| #   | Claim                                                                                                                                                                                                   | How to re-check                                                                                                                                                                                                         | Verified    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | `release.yml` has exactly three client build jobs (Windows x64 NSIS, Linux x64 AppImage+deb, Linux ARM64 AppImage+deb) and no Windows ARM64 client job                                                  | `grep -n "^  release-client" .github/workflows/release.yml` → `94,154,379`; `grep -n "runs-on:" .github/workflows/release.yml` → `97,157,382`                                                                           | yes         |
| 2   | `windows-11-arm` is used in `release.yml` only by the server matrix leg                                                                                                                                 | `grep -n "windows-11-arm" .github/workflows/release.yml` → one hit at `:273` (`release-server`'s matrix)                                                                                                                | yes         |
| 3   | The updater asset map has three rows and no `windows-aarch64` row                                                                                                                                       | `sed -n '39,43p' Server/updater/assets.go` → `windows-x86_64-nsis`, `linux-x86_64-appimage`, `linux-aarch64-appimage`                                                                                                   | yes         |
| 4   | Windows staging hardcodes the x64 NSIS suffix, so an ARM64 artifact would not be collected                                                                                                              | `.github/workflows/release.yml:143,145` (`*_x64-setup.nsis.zip` / `*.sig`)                                                                                                                                              | yes         |
| 5   | No client artifact is executed in `release.yml`; only the server binary and the server Docker image are smoked                                                                                          | `grep -ni "smoke" .github/workflows/release.yml` → `:329` (`go run ./cmd/smoke`), `:491` (`smoke-server-docker`); no client launch step anywhere                                                                        | yes         |
| 6   | `tauri-driver` / WebDriver is wired into nothing in the tracked tree                                                                                                                                    | `git grep -il "tauri-driver\|tauri_driver\|WebKitWebDriver\|msedgedriver"` → empty                                                                                                                                      | yes         |
| 7   | `Client E2E (Windows native)` is a required check, runs on `windows-latest`, builds a `--no-bundle` exe and drives it over CDP, then drives signed NSIS test packages                                   | `docs/plans/b0-dev-branch-protection.sh:73`; `ci.yml:1263-1268,1298-1302,1317,1324`; `Client/tests/e2e/support/native-app.ts:11,31`                                                                                     | yes         |
| 8   | The packaged-update journey already covers corrupt/interrupted downloads, a successful update to a newer version, and relaunch persistence — but starts from test-built packages, not shipped artifacts | `Client/tests/e2e/native/packaged-update.spec.ts:15,57-126`; `Client/tests/e2e/scripts/build-native-updates.mjs:27-30`                                                                                                  | yes         |
| 9   | The client's updater endpoint is derived from the signed-in server URL; a static endpoint list is forbidden                                                                                             | `Client/src-tauri/src/update_commands.rs:127-136`; `Client/src-tauri/src/config_gates.rs:31-51`; `tauri.conf.json:61` (`"endpoints": []`)                                                                               | yes         |
| 10  | The update fixture serves `/api/v1/client-update/{target}/{current}` and a signed artifact over real TLS                                                                                                | `Client/tests/e2e/support/native-update-server.ts:41-71`                                                                                                                                                                | yes         |
| 11  | The Linux **media** helper refuses anything but x64, so an ARM64 media smoke needs arm64 archives added                                                                                                 | `Client/tests/e2e/scripts/install-livekit.mjs:8-13` (`archives` has `linux`/`win32` x64 only; `process.arch !== "x64"` throws)                                                                                          | yes         |
| 12  | `release.yml`'s hardening must be preserved: no cache restore, no persisted credentials, least privilege, tag-only gate                                                                                 | `release.yml:3-6,21`; `grep -c "package-manager-cache: false" .github/workflows/release.yml` → 9; `grep -c "persist-credentials: false"` → 9                                                                            | yes         |
| 13  | The reusable-workflow pattern for a non-required smoke already exists and is called from `release.yml`                                                                                                  | `.github/workflows/upgrade-rehearsal.yml:52-68,81-88`; `.github/workflows/release.yml:601-609`                                                                                                                          | yes         |
| 14  | `AppImage`s run without FUSE on CI runners via `--appimage-extract-and-run`                                                                                                                             | `Client/scripts/strip-appimage-bundled-libs.sh:44,47`                                                                                                                                                                   | yes         |
| 15  | `scripts/ci-select.mjs` gates jobs by capability; a `Client/` change selects `client,browser,integration,native`, and a `.github/` or `scripts/` change selects everything                              | `scripts/ci-select.mjs:56-66,195-203,240-246`                                                                                                                                                                           | yes         |
| 16  | The tag workflow re-runs no required check, so a job that first executes at tag time is the wrong place to find its bugs                                                                                | `release.yml:24-37`; `scripts/verify-gate-evidence.mjs:14-19`                                                                                                                                                           | yes         |
| 17  | BPR-010's evidence home is the traceability row, and its B7-half register row is BG-04                                                                                                                  | `docs/plans/beta-requirements-traceability-2026-08-23.md:56`; `docs/plans/repo-health-issue-register-2026-08-23.md:298`; `prd.md:378`                                                                                   | yes         |
| 18  | The four artifacts' update identity is `{os}-{arch}-{installer}` and the Windows updater artifact is the `.nsis.zip` pair, not the `.exe`                                                               | `Client/src-tauri/src/update_commands.rs:124-136`; `Server/updater/assets.go:39-43`; `release.yml:143-146`                                                                                                              | yes         |
| 19  | LiveKit `1.13.5` publishes `linux_arm64` and `windows_arm64` archives alongside the x64 pair the repo pins                                                                                              | GitHub release `livekit/livekit` `v1.13.5` asset list (fetched 2026-09-21); NOT a local command — re-confirm in Task 0                                                                                                  | external    |
| 20  | The Tauri v2 ARM64 NSIS updater artifact is suffixed `_arm64-setup.nsis.zip`, so the staging and updater rows must learn that name                                                                      | Built natively on `windows-11-arm` in probe run https://github.com/J3vb/OwnCord/actions/runs/35688561456 (2026-09-22): `OwnCord_1.2.0-alpha.4_arm64-setup.exe`, `OwnCord_1.2.0-alpha.4_arm64-setup.nsis.zip` (+ `.sig`) | yes (probe) |

**Row 20 is the first thing Task 0 settles.** Rows 1–3 are the gap the PRD's
evidence section names (`prd.md:132-138`); rows 4–5 are why "built" is not
"exercised"; rows 6 and 11 are the two hard platform gaps that decide the task
split (Windows reuses CDP, Linux needs a driver, ARM64 media needs archives).

## Patterns to Mirror

- **Reusable workflow + shared script, called from `release.yml`.** The smoke
  logic lives in one Node/Playwright harness under `Client/tests/e2e/`, called
  by a `client-artifact-smoke.yml` that supports `workflow_call`, `schedule` and
  `workflow_dispatch`, exactly as `upgrade-rehearsal.yml` does
  (`upgrade-rehearsal.yml:52-68`) and for the same reason: `release.yml` runs
  the harness on the artifacts it is about to publish, and the nightly keeps it
  from rotting.
- **Never a required-status name for a scheduled job.** `upgrade-rehearsal.yml`'s
  header spells out that a `schedule:` runs from the default branch and lands a
  `skipped`/red context under a required name, which `verify-gate-evidence.mjs`
  then refuses (`upgrade-rehearsal.yml:18-23`; `nightly-docker-smoke.yml:5-15`).
  The smoke workflow's job name is not a required context.
- **Smoke the exact artifact that ships.** `release-server`'s comment states why
  a compile is not a smoke: the release build's flags differ from CI's and the
  produced binary is never executed (`release.yml:301-304,318-328`). The client
  smoke installs the artifact `release.yml` produced, not a rebuilt exe.
- **Arch-native runners, never QEMU.** Every row builds and smokes on its own
  architecture because a cross/emulated build only proves the interpreter can
  run (`release.yml:301-304,487-490`). This is decision 4's basis.
- **Reuse the existing Windows driver.** `native-app.ts` already owns CDP
  attach, profile isolation, traces and teardown (`native-app.ts:7-64`); the
  artifact smoke parameterizes its binary path rather than writing a second
  driver.
- **A gate that cannot fail is not a gate.** B7-3/B7-6/B7-7 each observed red
  before trusting green. Task 3 proves the smoke fails on a deliberately broken
  install/launch before it is trusted.
- **Evidence is a dated append, not a rewritten row.** B7-12 added a dated
  BPR-033 evidence block to the traceability row
  (`docs/plans/beta-requirements-traceability-2026-08-23.md:82`); the BPR-010
  and BG-04 notes follow that shape and leave final reconciliation to B7-18.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                      | Change                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Server/updater/assets.go`                                | add the `windows-aarch64-nsis` row (decision 4)                                                    |
| `Server/updater/coverage_boost_test.go`                   | the arch row in `TestFindClientAssets_ByTarget` and the negative case                              |
| `Server/api/client_update_test.go`                        | the arm64 target returns the arm64 artifact, not 204                                               |
| `.github/workflows/release.yml`                           | the Windows ARM64 client build job; arch-parameterized staging; collect + publish the arm64 assets |
| `.github/workflows/client-artifact-smoke.yml`             | **new**: reusable smoke workflow (`workflow_call`/`schedule`/`workflow_dispatch`)                  |
| `Client/tests/e2e/artifact-smoke/**.spec.ts`              | **new**: the install/boot/connect/update/rollback/media/recovery specs, parameterized by artifact  |
| `Client/tests/e2e/scripts/run-artifact-smoke.mjs`         | **new**: resolve/download/install the artifact, then drive Playwright                              |
| `Client/tests/e2e/scripts/install-livekit.mjs`            | add the arm64 archives + digests so media runs on ARM64 (row 11)                                   |
| `Client/tests/e2e/support/native-app.ts`                  | accept an installed-artifact path (Windows) without changing the existing CDP semantics            |
| `Client/tests/e2e/support/artifact-app.ts`                | **new**: the Linux (tauri-driver/WebKitWebDriver) driver, Windows-shaped API                       |
| `Client/playwright.config.artifact.ts`                    | **new**: the artifact-smoke project set                                                            |
| `Client/package.json`                                     | one `test:e2e:artifact` script                                                                     |
| `Client/tests/e2e/support/native-update-server.ts`        | generalize the fixture to AppImage + NSIS targets (update/rollback)                                |
| `scripts/ci-select.mjs`, `scripts/ci-select.test.mjs`     | a capability/selection for the PR-time smoke leg **only if** Open question 1 chooses one           |
| `docs/contributing.md`                                    | the new smoke script/workflow in the Build & dev and check tables                                  |
| `docs/architecture/client.md`                             | the testing/release narrative (`:118-128`) gains the four-artifact smoke matrix                    |
| `docs/plans/beta-requirements-traceability-2026-08-23.md` | the BPR-010 evidence block (`:56`), a dated append                                                 |
| `docs/plans/repo-health-issue-register-2026-08-23.md`     | BG-04's B7-half closure note (`:298`), a dated append                                              |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `protocol/schema.json`, `gendocs:*` blocks,
`CHANGELOG.md`, the PRD, the roadmap, or any status row. The PRD's milestone row
and register/traceability final reconciliation are B7-18's; this plan adds
evidence notes only.

## Tasks

Commit after every task — conventional subject, scope `b7-17`, one task per
commit, no `Co-Authored-By` trailer. Every commit must leave
`node scripts/ci-select.mjs`'s unit suite, `npm run check:hygiene` and
`npx actionlint .github/workflows/*.yml` (after a workflow edit) green.

### Task 0: Branch, baseline and the artifact-name recount

- **Action:** create `feat/b7-17-desktop-artifact-matrix-smoke` from
  `92242f4a`. Re-run Verify rows 1–13 and record the output. Then settle row 20:
  build the NSIS bundle on a `windows-11-arm` runner (or read the pinned
  `@tauri-apps/cli` bundler) and record the **exact** ARM64 installer and
  updater-artifact filenames beside the x64 names `release.yml:140-146` already
  globs. Also record which of B7-12, B7-15's client flows, and B7-16 are on
  `dev` at this commit.
- **Why:** the matrix's staging, updater rows and publish downloads all key off
  the artifact filename, and row 20 is the one name the plan derived by
  inference rather than by command.
- **Validate:** `git rev-parse --short HEAD` equals the base; the recorded ARM64
  filenames are observed, not guessed; each Verify row's command output is kept
  in the task record.

### Task 1: The `windows-aarch64-nsis` updater row

- **Action:** add `"windows-aarch64-nsis": "_arm64-setup.nsis.zip"` (the exact
  suffix from Task 0) to `clientAssetSuffixByTarget`
  (`Server/updater/assets.go:39-43`), and extend
  `Server/updater/coverage_boost_test.go`'s `TestFindClientAssets_ByTarget`
  table plus the negative case so an unknown target still returns empty.
- **Why:** decision 4 requires the row, and without it the Windows ARM64 client
  the new build job produces can never be offered an update — the server answers
  204 for every target it does not know (`Server/api/client_update.go:76-81`).
- **Validate:** `cd Server && go test ./updater/ ./api/ -run 'FindClientAssets|ClientUpdate'` green;
  add one `client_update_test.go` case asserting the arm64 target serves the
  arm64 `.nsis.zip` pair and that a `.sig`-only asset still yields no update.
  `make sqlc-verify` unaffected. Commit.

### Task 2: The Windows ARM64 client build job and arch-aware staging

- **Action:** in `release.yml`, add `release-client-windows-arm64` on
  `windows-11-arm` (decision 4's first choice), mirroring
  `release-client-windows` (`:94-152`) with the same `permissions: contents:
read`, `persist-credentials: false` and `package-manager-cache: false`.
  Parameterize the staging step (`:136-146`) so the arm64 job selects the
  Task-0 arm64 installer/zip/sig names; upload as
  `windows-arm64-release-assets`. Add a `publish` download into `windows/`
  (`:832-836`) and add the job to `publish.needs` (`:795-804`).
- **Why:** the artifact matrix's fourth target does not exist today (rows 1–2),
  and staging would silently drop it (row 4).
- **Validate:** `npx actionlint .github/workflows/release.yml` and
  `zizmor --offline .github/workflows/` green; the job graph shows
  `publish` waiting on the arm64 job; `npx prettier --check` on the file. If the
  Tauri toolchain fails on `windows-11-arm`, record it and fall back to the
  cross-compile path with the smoke marked **declared** — decision 4's own
  fallback — rather than leaving the row absent. Commit.

### Task 3: The artifact-smoke harness skeleton (install, boot, connect)

- **Action:** add `Client/tests/e2e/scripts/run-artifact-smoke.mjs`,
  `playwright.config.artifact.ts` and the first
  `artifact-smoke/connect.spec.ts`. The runner takes `OS`, `ARCH`, `INSTALLER`
  and `ARTIFACT` paths, installs/extracts the artifact (`dpkg -x` or
  `dpkg -i` for deb, `--appimage-extract-and-run` for AppImage per row 14,
  silent NSIS `/S /D=` for Windows per `packaged-update.spec.ts:34`), starts the
  real server + LiveKit via the existing fixtures
  (`Client/tests/e2e/support/server.ts`, `install-livekit.mjs`), then drives the
  app. On Windows reuse `native-app.ts` (row 7); add `artifact-app.ts` for Linux
  using `tauri-driver` + `webkit2gtk-driver` under `xvfb-run`. The spec asserts
  the app boots to the connect page and logs in (the `nativeLogin` shape,
  `Client/tests/e2e/native/helpers.ts:55-89`).
- **Why:** this is the milestone's core — "exercised by CI, not just built".
- **Gotcha:** do not modify `native-app.ts`'s existing CDP path or the required
  native job; add an installed-binary parameter and leave every default
  unchanged (`native-app.ts:7-12`). The Linux driver is new code with a real
  version-coupling risk (`webkit2gtk-driver` must match the runner's WebKitGTK).
- **Validate:** **prove the gate can fail first** — run the runner against a
  deliberately truncated AppImage/renamed exe and observe a red boot assertion,
  then restore and observe green. Record both. `npm --prefix Client run
typecheck:e2e` and `lint` clean; `npx prettier --check` on the new files.
  Commit.

### Task 4: Media on both architectures (the ARM64 media gap)

- **Action:** extend `install-livekit.mjs`'s `archives` map (`:8-13`) with the
  `linux_arm64.tar.gz` and `windows_arm64.zip` entries and their pinned SHA-256
  digests from Task 0's verification of row 19, and drop the
  `process.arch !== "x64"` refusal. Add the media step to the smoke runner: join
  a voice channel and assert decoded media, reusing the native
  `voice-controls.spec.ts` control assertions (`:8-47`) and, where a second
  client is available, the fullstack decoded-media shape
  (`Client/tests/e2e/fullstack/media.spec.ts:8-23`).
- **Why:** row 11 — the media helper refuses non-x64 today, so without this the
  ARM64 legs could only claim "booted", not "used media", which BPR-010
  explicitly requires (`beta-requirements-traceability-2026-08-23.md:56`).
- **Gotcha:** do not weaken the digest check to make a download pass; a missing
  arm64 digest is a **BLOCKED**, not a fallback.
- **Validate:** the extended script still refuses an unknown platform/arch;
  its own digest check is observed failing on a mutated digest, then restored;
  the x64 Linux and Windows media legs still pass. Commit.

### Task 5: Update and rollback, on the shipped artifacts

- **Action:** generalize `native-update-server.ts` (`:13-123`) to serve an
  updater artifact for any target — NSIS for Windows, the `.AppImage.tar.gz`
  pair for Linux — so the fixture's `/api/v1/client-update/{target}/{current}`
  answers the target under test. Add `artifact-smoke/update.spec.ts`: install
  the artifact built for the **previous** published release (resolved the way
  `upgrade-rehearsal.yml:135-144` resolves it, with `gh`), boot it, point it at
  the fixture gateway, update to the artifact built for this commit, assert the
  version changed and the session/profile persisted, then **roll back** by
  reinstalling the previous artifact and asserting the version returned and the
  app still boots and connects.
- **Why:** "update" and "roll back" are two of BPR-010's seven verbs
  (`beta-requirements-traceability-2026-08-23.md:56`). The corrupt/interrupted
  rejection already has coverage (`packaged-update.spec.ts:57-75`); what is
  missing is the reverse direction and the shipped artifacts.
- **Gotcha:** the client updater refuses a foreign installer and a target with no
  artifact (`Server/api/client_update.go:76-81`); the fixture must serve the
  exact `{os}-{arch}-{installer}` the binary requests (row 18). A `.deb` install
  must get 204, never the AppImage (`update_commands.rs:193-205`).
- **Validate:** the update leg asserts a concrete version change and a rollback
  to the prior version, not just "no error"; the fixture is observed serving 204
  for a mismatched target. Commit.

### Task 6: Recovery smoke (gated on B7-15's client flows)

- **Action:** add `artifact-smoke/recover.spec.ts` driving B7-15's recovery flow
  against the real server through the installed artifact: enrol a recovery kit,
  log out, recover with the kit/recovery code, and assert the account is usable
  again. Reuse the mocked scenario B7-15 lands
  (`Client/tests/e2e/recovery-flow.spec.ts`, its plan's Task 9) as the spec of
  the journey, but run it on the artifact against the real server.
- **Why:** "recover an account" is BPR-010's last verb
  (`beta-requirements-traceability-2026-08-23.md:56`) and the reason B7-17 is
  ordered last (`prd.md:350-352`).
- **Gate:** if B7-15's client flows are not on `dev` at this task's start,
  record **BLOCKED** naming the missing flow and stop; do not stub the recovery
  path to make the leg green.
- **Validate:** the leg fails if recovery is not actually wired (observe red on
  the pre-B7-15 tree if it is safe to do so); the account is proven usable after
  recovery, not merely that the form submitted. Commit.

### Task 7: Wire the matrix: the reusable workflow and its callers

- **Action:** add `.github/workflows/client-artifact-smoke.yml` with
  `workflow_call`, `schedule` and `workflow_dispatch`
  (`upgrade-rehearsal.yml:52-68` shape), a per-OS job with an arch matrix
  (`windows-latest`/`windows-11-arm`, `ubuntu-22.04`/`ubuntu-22.04-arm`), each
  job following the release-workflow hardening (row 12) and running
  `run-artifact-smoke.mjs`. Call it from `release.yml` as a job that `needs` the
  four client build jobs (downloading their uploaded artifacts), and add it to
  `publish.needs` so nothing is published before the four artifacts have booted
  — mirroring `upgrade-rehearsal`'s placement, which gates the push and the
  release the same way (`release.yml:601-618`). Its job name is **not** a
  required context. Apply Open question 1's answer for any per-PR leg (which may
  add a `ci-select.mjs` capability, with its unit case).
- **Why:** the smoke is only "exercised by CI" if a workflow actually runs it,
  and it must not re-run at tag time a job whose bugs were never seen pre-merge
  (row 16). The reusable shape keeps the nightly and the release on one harness.
- **Validate:** `npx actionlint .github/workflows/*.yml` and
  `zizmor --offline .github/workflows/` green; `npm test` for `ci-select` green
  if it changed; `npx prettier --check` on the workflow. Confirm the workflow
  reports as `skipped` (not red) on a PR into `dev` when its capability is
  false. Commit.

### Task 8: Evidence, docs and the final gate

- **Action:** append a dated BPR-010 evidence block to
  `docs/plans/beta-requirements-traceability-2026-08-23.md:56` naming the
  workflow, the four targets, the per-verb evidence and the ARM64 runner used
  (native or declared per decision 4/row 20); append BG-04's B7-half closure
  note to `docs/plans/repo-health-issue-register-2026-08-23.md:298`; add the
  smoke script/workflow to `docs/contributing.md`'s tables; document the matrix
  where release artifacts are described. These are dated appends — B7-18 does the
  final reconciliation.
- **Why:** the milestone "carries the BPR-010 evidence" and closes BG-04's B7
  half (`prd.md:378`); a workflow that exists but is not recorded in the
  traceability row is not evidence.
- **Validate:**

  ```
  npm run check:docs
  npm run check:hygiene
  npx actionlint .github/workflows/*.yml
  npx prettier --check --ignore-unknown .claude/plans/b7-17-*.md .github/workflows/client-artifact-smoke.yml .github/workflows/release.yml
  ```

  Then the `ci-check` skill. Commit.

## Validation

```
# Task 0 / every task
git rev-parse --short HEAD                                   # base 92242f4a
grep -n "^  release-client" .github/workflows/release.yml    # three jobs, four after Task 2
sed -n '39,43p' Server/updater/assets.go                      # four rows after Task 1

# Server
cd Server && go test ./updater/ ./api/ -run 'FindClientAssets|ClientUpdate'

# Client harness
npm --prefix Client run typecheck:e2e
npm --prefix Client run lint
npx prettier --check --ignore-unknown .claude/plans/b7-17-*.md

# Workflows
npx actionlint .github/workflows/*.yml
zizmor --offline .github/workflows/

# Repo gates
npm run check:docs
npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The four-OS matrix costs more CI than the milestone is worth and gets disabled                            | High       | Medium | Open question 1: release-time + nightly by default, no per-PR matrix; the wiring is one task so placement can change without redesign (Summary, Task 7)                   |
| `tauri-driver`/`webkit2gtk-driver` version-couples to the runner and Linux driving silently stops working | High       | High   | Task 3 proves the Linux leg red on a broken boot before trusting it; the driver is pinned by the OS package and its failure is a loud boot assertion, not a skip (Task 3) |
| A smoke is "fixed" by weakening an assertion instead of the artifact                                      | Medium     | High   | Every task's Validate names the concrete fact asserted; a leg that needs an assertion loosened is a **BLOCKED**, not a pass (Task 4/5/6 gotchas)                          |
| The ARM64 artifact filename is guessed wrong and staging/publish drops it                                 | Medium     | High   | Row 20 is explicitly unverified and Task 0 settles it by building on `windows-11-arm` before any code depends on the name (Task 0)                                        |
| The ARM64 media smoke is claimed without real decoded media because the LiveKit arm64 archive is missing  | Medium     | High   | Task 4 pins arm64 digests and refuses to proceed without them; a missing digest is **BLOCKED** (Task 4)                                                                   |
| Windows ARM64 has no working Tauri toolchain on `windows-11-arm` and the milestone stalls                 | Medium     | High   | Decision 4's own fallback: cross-compile on `windows-latest` and mark the smoke **declared**, recorded in the BPR-010 evidence (Task 2, Task 8)                           |
| The tag workflow's hardening regresses when a new job is added to `release.yml`                           | Medium     | Medium | New jobs copy `permissions: contents: read`, `persist-credentials: false`, `package-manager-cache: false`; `zizmor --offline` runs in Task 7 and CI gates it              |
| A scheduled/nightly smoke under a required status name blocks every PR and the tag gate                   | Low        | High   | The workflow's job name is deliberately not a required context; Task 7 asserts it reports `skipped` on a disabled-capability PR (`upgrade-rehearsal.yml:18-23` precedent) |
| B7-15's recovery flows slip and the recovery smoke is stubbed to keep the matrix green                    | Medium     | High   | Task 6 is explicitly gated and records **BLOCKED** rather than stubbing (Dependencies; Task 6)                                                                            |

## Out of scope

- **Any production client or server behaviour change.** The only production
  edits are the updater asset row and the release workflow; a smoke that needs
  an app change is testing the wrong layer (Files to Change, Dependencies).
- **Rewriting the existing Windows native harness.** `native-app.ts`,
  `client-native` and its required status are reused, not replaced.
- **B7-11's long-session evidence.** This is a bounded journey, not a soak.
- **Server-side upgrade/rollback rehearsals.** `upgrade-rehearsal.yml` and
  `Server/cmd/smoke` already own those; the client smoke mirrors the structure,
  not the code.
- **BPR-001's release-page/download evidence** — B10's; this milestone proves the
  four artifacts, not the public release page.
- **The PRD, roadmap, register and traceability final reconciliation.** Dated
  evidence appends only; B7-18 reconciles.
- **HP-7.** It signs after B7-17 (`prd.md:395`) and is a separate milestone.

## Open questions for the owner

1. **When does the artifact smoke run?** Options: (a) release-time only, as a
   job in `release.yml` before `publish` gates on the four artifacts that
   actually ship; (b) release-time **plus** a nightly `schedule` drift run;
   (c) also a per-PR leg. **Recommendation: (b).** Release-time is the only
   placement that smokes the signed artifacts, and the nightly keeps the harness
   from rotting without paying four OS runners on every client PR — the Windows
   x64 exe is already driven per-PR by the required native job (row 7). A per-PR
   matrix would need a new `ci-select.mjs` capability and would roughly double
   the client PR cost; take (c) only if the owner accepts that.
2. **Which Linux driver, at what cost?** Options: (a) `tauri-driver` +
   `webkit2gtk-driver` under `xvfb-run`, driving the real UI on both Linux
   arches; (b) a narrower Linux leg that proves install + boot + a health
   signal, leaving connect/update/recovery to the shared TS suites.
   **Recommendation: (a)**, because BPR-010 asks for the same seven verbs on
   every target (`beta-requirements-traceability-2026-08-23.md:56`), and the
   repo's own Windows job already chose real UI driving over a signal. The cost
   is the version coupling the Risks table names; (b) is the fallback if (a)
   cannot be made stable.
3. **Which signing key does the smoke install?** Options: (a) the real signed
   artifacts produced by the release jobs (release-time), and an ephemeral test
   key for the nightly, as `build-native-updates.mjs` already does
   (`:14-24`); (b) the real key everywhere, including the nightly.
   **Recommendation: (a).** The release path gets the genuine artifact — which
   is the point — and the nightly needs no production signing secret on a
   schedule.
4. **How is a declared Windows ARM64 fallback recorded?** Decision 4 allows
   cross-compiling on `windows-latest` if the Tauri toolchain fails on
   `windows-11-arm`, "mark[ing] the smoke as declared". Options: (a) record the
   declaration in the BPR-010 evidence block and the workflow's job name/output;
   (b) treat a declared fallback as a failed acceptance and hold B7-17.
   **Recommendation: (a)**, matching BPR-010's own Linux-ARM64 clause that the
   evidence "states whether it is cross-build/emulated or real hardware"
   (`beta-requirements-traceability-2026-08-23.md:56`). Confirm a declared
   fallback does not fail the milestone.

## Acceptance

- [ ] `Server/updater/assets.go` carries the `windows-aarch64-nsis` row with the
      exact filename verified in Task 0, with `updater` and `api` tests
- [ ] `release.yml` builds the Windows ARM64 client on `windows-11-arm` first
      (decision 4), stages its arch-named assets, and `publish` waits on it —
      with no cache restore, no persisted credentials and least privilege
      preserved on every new job
- [ ] All four artifacts (Windows x64/ARM64, Linux x64/ARM64) are **installed
      and executed** by CI — not merely built — through one reusable
      `client-artifact-smoke.yml` shared by the release-time and nightly callers
- [ ] Each of install, boot, connect, media, update, rollback and recovery is
      asserted with a concrete observed fact; update asserts a version change and
      rollback asserts the version returned and the app still connects
- [ ] The smoke was **observed failing** on a broken install/launch before being
      trusted green; no assertion was weakened to make a leg pass
- [ ] ARM64 media runs on real arm64 LiveKit archives with pinned digests;
      `install-livekit.mjs` no longer refuses non-x64
- [ ] The recovery leg is real (B7-15's flow) or the task records **BLOCKED** —
      never a stub
- [ ] The workflow's job name is not a required status context and reports
      `skipped`, not red, on a PR whose capability is false
- [ ] The BPR-010 evidence block and BG-04's B7-half note are dated appends, and
      `docs/contributing.md` names the new script and workflow
- [ ] `check:docs`, `check:hygiene`, `actionlint`, `zizmor --offline`,
      `prettier --check` and the `ci-check` skill are green; no PRD, roadmap,
      status-row or other plan is edited
