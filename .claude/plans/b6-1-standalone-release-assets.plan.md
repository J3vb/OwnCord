# Plan: B6-1 — Standalone release assets

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-1 — Standalone release assets (roadmap workstream 1)
**Complexity**: Medium
**Drafted**: 2026-09-10 at `dev` `3221fe9e`

## Summary

Today the release pipeline ships exactly two server assets — `chatserver.exe`
(Windows amd64) and `chatserver-linux-amd64.tar.gz` — and boot-smokes them with
an inline script that proves only "starts and answers `healthcheck`". B6-1's
outcome needs four assets (Windows x64/ARM64, Linux x64/ARM64) and a smoke that
proves the full owner-visible lifecycle: **starts, migrates, becomes healthy,
drains, restarts on its own data directory**. Shipping ARM64 assets also
un-gates the self-updater, which currently refuses to update any non-amd64 host
by design.

## Verify before you implement

Facts established from source at `3221fe9e`; re-check any that a parallel branch
may have moved.

| Claim                                                      | Status        | Evidence                                                                                                                                      |
| ---------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Only amd64 server assets are built                         | **Confirmed** | `.github/workflows/release.yml:236-241` — matrix is `windows-latest` + `ubuntu-latest`, no ARM entries                                        |
| The updater deliberately refuses non-amd64                 | **Confirmed** | `Server/updater/download.go:256-259` returns `""` for any `goarch != "amd64"`; locked by `Server/updater/updater_test.go:458-464`             |
| The boot smoke does not exercise drain or restart          | **Confirmed** | `.github/workflows/release.yml:276-302` — start, poll `healthcheck`, `kill`, done. No SIGTERM budget, no second boot on the same data dir.    |
| The standalone smoke is inline YAML, not a reusable script | **Confirmed** | Same block. Contrast `Server/scripts/docker-smoke.sh`, which `ci.yml` and `release.yml` both call                                             |
| The update manifest hard-codes two assets                  | **Confirmed** | `.github/workflows/release.yml:578-587` — a `printf` naming exactly `chatserver.exe` and `chatserver-linux-amd64.tar.gz`                      |
| Only the Windows binary and the manifest are minisigned    | **Confirmed** | `.github/workflows/release.yml:591-601`; the Linux archive is covered by manifest SHA plus `checksums.sha256` only                            |
| Cross-compilation is viable (no cgo)                       | **Confirmed** | `Server/go.mod:43` uses `modernc.org/sqlite` (pure Go); the Linux build already sets `CGO_ENABLED=0`                                          |
| A native ARM64 Linux runner is already proven here         | **Confirmed** | `.github/workflows/release.yml:326` — `release-client-linux-arm64` runs on `ubuntu-22.04-arm`                                                 |
| Workstream 13's four ARM64 blockers are closed             | **Confirmed** | PRD "Satisfied preconditions"; OC-0320/0332/0344/0339 are `fixed` in `.superpowers/findings-ledger.json`. Re-verify at the RC, do not re-plan |

## Patterns to Mirror

| Category       | Source                                     | Pattern                                                                                             |
| -------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Smoke script   | `Server/scripts/docker-smoke.sh:1-45`      | `set -euo pipefail`, `trap cleanup EXIT`, 30x1s poll loop, `::error::` annotations, logs on failure |
| Shared smoke   | `.github/workflows/ci.yml` + `release.yml` | One script called from both, so a regression is caught pre-merge instead of at tag time             |
| Build matrix   | `.github/workflows/release.yml:232-242`    | `strategy.matrix.include` with an `artifact` name per row; `if:` guards for OS-specific steps       |
| ARM64 runner   | `.github/workflows/release.yml:324-326`    | `runs-on: ubuntu-22.04-arm`, otherwise identical to the x86_64 job                                  |
| Asset naming   | `Server/updater/updater.go:39-40`          | Named constants, never string literals at use sites                                                 |
| Arch mapping   | `Server/updater/download.go:256-268`       | `serverDownloadAssetName(goos, goarch)`; unknown combinations return `""` and fail closed           |
| Table test     | `Server/updater/updater_test.go:455-469`   | `{goos, goarch, want}` rows including the deliberate empty-string cases                             |
| Action pinning | every `uses:` line in `release.yml`        | Full commit SHA plus a `# vX.Y.Z` comment                                                           |

## Files to Change

| File                                        | Action | Why                                                                                                     |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `Server/cmd/smoke/main.go`                  | CREATE | Reusable start → migrate → healthy → drain → restart harness, mirroring `docker-smoke.sh`'s job         |
| `Server/cmd/smoke/stop_windows.go`          | CREATE | CTRL_BREAK to the server's own console process group — Windows has no SIGTERM                           |
| `Server/cmd/smoke/stop_other.go`            | CREATE | SIGTERM to the server's own process group                                                               |
| `Server/go.mod`                             | UPDATE | `golang.org/x/sys` moves from indirect to direct; no new dependency                                     |
| `Server/updater/download.go`                | UPDATE | Extend `serverDownloadAssetName` to the two new arm64 assets                                            |
| `Server/updater/updater.go`                 | UPDATE | Add `windowsServerArm64Binary` / `linuxServerArm64Archive` constants next to the existing pair          |
| `Server/updater/updater_test.go`            | UPDATE | Flip the two `""` arm64 rows to the new names; keep an unknown-arch row failing closed                  |
| `.github/workflows/release.yml`             | UPDATE | 2 → 4 matrix rows, per-row asset names, call the new smoke script, extend the manifest and signing loop |
| `.github/workflows/ci.yml`                  | UPDATE | Run `go run ./cmd/smoke` on PRs, so the harness itself is exercised pre-merge                           |
| `docs/server-configuration.md` (or sibling) | UPDATE | Name the four assets and which architecture each targets                                                |
| `CHANGELOG.md`                              | UPDATE | Unreleased entry — new ARM64 server assets, self-update now available on ARM64                          |
| `docs/plans/b6-*.prd.md`                    | UPDATE | B6-1 row → `in-progress`, `Plan` cell → this file                                                       |

## Tasks

### Task 1: Extract and deepen the standalone smoke — DONE 2026-09-10

- **Action**: Replace the inline boot smoke with `go run ./cmd/smoke <binary>`.
  Phases, each annotated with `::error::` and the server's log: (1) cold boot in
  an empty temp dir — writes `config.yaml`, a self-signed cert, migrates a fresh
  DB; (2) poll the binary's own `healthcheck`; (3) graceful stop, then assert a
  **clean exit** inside a 20s budget; (4) restart against the **same** directory,
  reach healthy again, and assert `config.yaml` is byte-identical and the
  database still present — a restart that recreated either would pass for the
  wrong reason.
- **Mirror**: `Server/scripts/docker-smoke.sh` (annotation prefix, poll loop,
  log-on-failure) and the `Server/cmd/*` command layout.
- **Why Go, not the bash script this plan first specified**: the graceful stop is
  the entire point of the milestone, and **Windows has no SIGTERM**. MSYS
  `kill -TERM` cannot signal a native Windows binary — it terminates it. The
  first bash draft was run on this machine and failed exactly there
  (`exited with status 143 after SIGTERM, expected 0`), which would have left the
  drain claim unproven on half the shipped assets. Console control events are the
  only graceful stop Windows offers and must be addressed to a process group, so
  the harness lives where process-group creation is expressible. Go's runtime
  maps CTRL_BREAK to `os.Interrupt`, which `internal/app/lifecycle.go:397` already
  listens for, so both platforms reach the same teardown path.
- **Validate**: proven locally on Windows —

  ```
  graceful stop: CTRL_BREAK
  cold boot: healthy after 1s
  cold boot: config.yaml and a migrated database exist
  drain: drained cleanly in 165ms
  restart: healthy after 1s
  restart: reused the existing config and database
  restart drain: drained cleanly in 12ms
  standalone smoke passed: boot, migrate, healthy, drain, restart
  ```

  Negative check: pointed at a non-server binary it reports
  `cold boot: server exited before reporting healthy: exit status 1` and attaches
  the log. `GOOS=linux go vet ./cmd/smoke/` passes; the SIGTERM path still needs a
  real Linux run in CI.

### Task 2: Teach the updater about arm64 (test first)

- **Action**: Add the two constants, extend `serverDownloadAssetName` to a
  `goos`/`goarch` switch, keep the fail-closed `""` default. Write the test rows
  before the change — the current rows assert `""` for arm64, so the suite must
  go red first.
- **Mirror**: `Server/updater/download.go:256-268` and the table test at
  `Server/updater/updater_test.go:455-469`.
- **Validate**: `cd Server && go test ./updater/...`
- **Ordering**: this must merge **with or after** the release change that actually
  publishes the arm64 assets. An updater that asks for an asset no release has
  produced strands every ARM64 host — the same failure class as OC-0320, inverted.

### Task 3: Build the four assets

- **Action**: Expand the `release-server` matrix to four rows:

  | os                 | GOOS    | GOARCH | asset                           |
  | ------------------ | ------- | ------ | ------------------------------- |
  | `windows-latest`   | windows | amd64  | `chatserver.exe`                |
  | `windows-11-arm`   | windows | arm64  | `chatserver-windows-arm64.exe`  |
  | `ubuntu-latest`    | linux   | amd64  | `chatserver-linux-amd64.tar.gz` |
  | `ubuntu-22.04-arm` | linux   | arm64  | `chatserver-linux-arm64.tar.gz` |

  Native runners, not cross-compilation — the point of B6-1 is a **smoked**
  asset, and a cross-compiled binary cannot be executed on the builder. Each row
  builds with the existing ldflags, runs `go run ./cmd/smoke`, then packages.

- **Mirror**: `release.yml:232-242` for the matrix shape, `:324-326` for the ARM runner.
- **Validate**: a `workflow_dispatch` dry run, or a throwaway pre-release tag on a
  fork, produces four artifacts and four green smokes.
- **Watch**: keep the existing filename `chatserver.exe` for Windows amd64
  unchanged — deployed 1.x servers verify that exact name (`release.yml:562-568`
  warns about this class of break).

### Task 4: Extend manifest, checksums and signing

- **Action**: Generate the manifest's `assets` array from the four files instead of
  a hard-coded `printf`, keeping the legacy top-level `asset`/`sha256` pair bound
  to `chatserver.exe` for old servers. Minisign the new Windows ARM64 binary
  alongside the existing Windows binary, and extend the verify-against-pinned-key
  loop to cover it.
- **Mirror**: `release.yml:571-601`.
- **Validate**: the "Verify signed assets against pinned server update key" step
  passes for every signed asset; `checksums.sha256` lists bare filenames only
  (the prefix trap at `release.yml:562-565`).

### Task 5: Pre-merge coverage and documentation

- **Action**: Call `go run ./cmd/smoke` from `ci.yml` on the host-native build so
  the harness is exercised on every PR. Document the four asset names, their target
  architectures, and the drain/restart expectation for an owner.
- **Mirror**: the shared-smoke rationale comment at `release.yml:288-291`.
- **Validate**: `ci-check` skill, then `node .superpowers/render-ledger.mjs --check`.

## Validation

```bash
# Go side
cd Server && go test ./updater/...

# The new harness, against a locally built binary
cd Server && go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .
cd Server && go run ./cmd/smoke ./chatserver.exe

# Full gate before pushing — four build-tag variants plus the deadlock pass.
# Use the ci-check skill, not an ad-hoc `go build && go test`.

# Formatting of the touched workflow files
npx prettier --check .github/workflows/release.yml .github/workflows/ci.yml
```

## Risks

| Risk                                                                           | Likelihood | Impact | Mitigation                                                                                                           |
| ------------------------------------------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `windows-11-arm` runner unavailable or lacks Go 1.26 support                   | Medium     | High   | Fall back to cross-compiling Windows ARM64 and mark it **qualified, not smoked** in the exit evidence; say so openly |
| Updater ships before the assets do, stranding ARM64 hosts                      | Medium     | High   | Land Task 2 and Task 3 in one PR, or gate Task 2 behind the first tag that publishes arm64                           |
| Renaming any existing asset breaks deployed 1.x self-update                    | Low        | High   | The existing two names are frozen; new names are additive only                                                       |
| SIGTERM semantics differ on Windows, making the drain assertion flaky          | Medium     | Medium | Assert on the `healthcheck` CLI plus the process exit code, never on a log-string match                              |
| Smoke's restart phase hides a migration bug by starting from a clean directory | Low        | High   | Phase 4 must reuse phase 1's directory; assert the DB file changed, not merely that boot succeeded                   |

## Open questions for the owner

1. **Do ARM64 assets ship in B6, or does B6 only qualify them?** (PRD open
   question, still unanswered.) This plan assumes **ship** — the milestone text
   says an owner _downloads_ an ARM64 asset. If the answer is "qualify only",
   Task 2 and Task 4 drop out and Task 3 stops at artifact upload.
2. ~~**Windows ARM64 native runner, or cross-compile?**~~ **Decided 2026-09-10
   by the owner: the native `windows-11-arm` runner.** Every published asset is
   executed on its own architecture before it ships; cross-compilation is the
   documented fallback only if that runner cannot provide Go 1.26, and an asset
   built that way must be labelled _qualified, not smoked_ in the exit evidence.

## Status 2026-09-10

All five tasks implemented on `feat/b6-1-standalone-release-assets`. Verified
locally: four Go build-tag variants, `go vet`, `golangci-lint run` (0 issues),
`go test -race ./...`, the `-tags deadlock` `ws` leg, the untagged `admin` leg,
`check:hygiene` (prettier + actionlint) and `check:docs`. The lifecycle harness
was executed against a real release-ldflags build on Windows.

**Not verified locally, and honestly so:** the release pipeline itself only runs
at tag time. The manifest step's `jq` block could not be executed here (`jq` is
not installed on this machine; it is preinstalled on `ubuntu-latest`, where that
job runs), and neither ARM64 runner exists locally — the `windows-11-arm` and
`ubuntu-22.04-arm` rows are first exercised by the next release run. The
`cmd/smoke` harness is shared with `ci.yml`, so the harness itself is gated
pre-merge even though the release job is not.

## Acceptance

- [ ] Four server assets build, smoke and upload on a release run — **awaits a tag run**
- [x] `cmd/smoke` proves start → migrate → healthy → drain → restart (Windows verified 2026-09-10; Linux pending CI)
- [x] The same harness runs pre-merge in `ci.yml` (`server-build-test`, both OS rows)
- [ ] The update manifest and `checksums.sha256` cover all four assets — **awaits a tag run**
- [ ] Signed assets verify against the pinned key — **awaits a tag run**
- [x] `serverDownloadAssetName` resolves both arm64 hosts and still fails closed elsewhere, and `serverSignatureAssetName` pairs the detached signature with the asset actually downloaded
- [x] `ci-check` green across all four build-tag variants
- [x] Patterns mirrored from `docker-smoke.sh` and the existing matrix, not reinvented
