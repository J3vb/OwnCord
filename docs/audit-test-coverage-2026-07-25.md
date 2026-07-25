# OwnCord — Test-Coverage Audit
**Date:** 2026-07-25
**Branch:** claude/test-coverage-audit-tvp07j (audited tree: `70caa6c` = main)
**Scope:** "does everything that should have a test have a test?" — measured, not estimated, across all three surfaces (Go server, TypeScript client, Rust Tauri backend), plus the CI configuration that decides which of those tests actually run.
**Relationship to prior audits:** narrower and newer than [audit-2026-07-19.md](audit-2026-07-19.md), which remains the closure tracker for architectural findings. Prior test-related items (#6 `store/` untested, #7 client unit coverage, A-2026-07-04 client suite red) are closed there and are not restated.

Unlike the prior audits, this one shipped its fixes: the findings below are recorded together with the change that closed them.

---

## 1. How coverage was measured (and why the CI number is wrong)

`go test ./... -coverprofile` — the invocation in `.github/workflows/ci.yml` — instruments
each package **only for itself**. A package whose code is mostly exercised through another
package's tests reports far below its real coverage. Concretely, `service` reported 36.7%
while its true cross-package exercise was 85%.

Everything in this document therefore uses `-coverpkg=./...`. Both numbers are now one
command away — see `make cover` and `make cover-all` in `Server/Makefile` (§4).

The client and Rust numbers come from `vitest run --coverage` and a per-file census of
`#[cfg(test)]` modules respectively; there is no Rust coverage instrumentation in the repo
(§5, standing gap).

---

## 2. Finding closure status

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| T-2026-07-25-01 | HIGH | `Server/admin` reported **0.3% coverage despite 307 passing tests**, and `go test` printed "[no tests to run]" for it. `TestSpawnDetached_*` re-execs the test binary; the child inherited `GOCOVERDIR` and the parent's stdout, so it clobbered the coverage profile and polluted the result stream. CI's uploaded `coverage.out` artifact was wrong for this package | **RESOLVED** — `Server/admin/middleware_and_spawn_test.go` now points the child's counters at `t.TempDir()` and uses `-test.list` (silent exit) instead of `-test.run`. Package reports **71.4%** |
| T-2026-07-25-02 | HIGH | User blocking had **zero coverage at every layer** — `db.BlockUser`/`UnblockUser`/`IsBlocked`/`ListBlockedUsers`, all of `service/block.go`, and the `PUT`/`DELETE`/`GET /api/v1/blocks` routes. A whole user-facing feature, including the DM-authorization predicate `IsEitherBlocked` | **RESOLVED** — `Server/db/block_queries_test.go`, `Server/service/block_test.go`, `Server/api/blocks_handler_test.go` |
| T-2026-07-25-03 | HIGH | Auth lockout **persistence** untested (`UpsertLockout`, `CleanupExpiredLockouts`, `DeleteLockout`). `auth/ratelimit_test.go` covers the in-memory limiter but not the DB round-trip that makes a brute-force lockout survive a restart | **RESOLVED** — `Server/db/lockout_queries_test.go` |
| T-2026-07-25-04 | HIGH | Rust: `ws_proxy.rs` (340 LOC) and `livekit_proxy.rs` (332 LOC) had **no tests at all** — the two proxies carrying every byte of app traffic, including TOFU cert pinning and proxy header rewriting | **RESOLVED** — pure helpers extracted (matching the existing `tofu.rs` pattern) and tested: cert-fingerprint validation, `remote_host` CRLF/charset validation, `Host`/`Origin` rewriting, TLS server-name parsing |
| T-2026-07-25-05 | HIGH | Rust unit tests ran **only on PRs to `main`**, inside the expensive `tauri-build` job. Pushes and PRs to `dev` never compiled `#[cfg(test)]` code, so it could rot for a full release cycle | **RESOLVED** — standalone `rust-tests` job in `ci.yml`, runs on every event, with `cargo clippy --all-targets` (the existing lib-only clippy skips test code) |
| T-2026-07-25-06 | HIGH | **40 Playwright spec files had never run in CI.** No e2e job existed in any workflow | **RESOLVED (partial)** — new `client-e2e` job runs the mocked-Tauri config, `continue-on-error: true` for a soak period per backlog #10. The native config still is not wired (needs a real server + built binary) |
| T-2026-07-25-07 | MEDIUM | `vitest.config.ts` excluded **2,229 LOC** from coverage with no stated reason — including `window-state.ts` and `UpdateNotifier.ts`, which *already had passing tests*. Coverage for those never appeared in any report | **RESOLVED** — exclude list cut to three entries, each justified inline. `credentials.ts` and `updater.ts` gained tests and were un-excluded |
| T-2026-07-25-08 | MEDIUM | Plugin install/enable/disable/uninstall lifecycle and the entire plugin KV store untested. `plugin/registry.go` (558 LOC) was the largest untested source file in the repo; the KV namespace is the isolation boundary between plugins | **RESOLVED** — `Server/plugin/registry_test.go`, `Server/db/plugin_queries_test.go` (including a namespace-isolation test and cascade-on-uninstall) |
| T-2026-07-25-09 | MEDIUM | `handleWebhookParticipantJoined` untested — the guard that evicts a LiveKit participant presenting a replayed or unmatched join token. Untrusted-input entry point | **RESOLVED** — `Server/ws/livekit_webhook_joined_test.go` |
| T-2026-07-25-10 | MEDIUM | `proxyWebSocket` / `copyWS` untested: the existing `livekit_proxy_test.go` stopped at the path allowlist and Origin check, before the upgrade. Every LiveKit signalling frame flows through the untested half | **RESOLVED** — `Server/api/livekit_proxy_ws_test.go` (real backend WS server, round-trip, 502 on backend failure, blocked-path and cross-origin upgrades) |
| T-2026-07-25-11 | MEDIUM | `api.HandleLiveKitHealthForTest` **re-implemented** `handleLiveKitHealth` instead of calling it. Eight test call sites asserted against a copy, so the production handler had 0% coverage and the two could drift silently | **RESOLVED (partial)** — added `LiveKitHealthHandlerForTest`, which returns the real handler, plus tests through it. The old hook is retained with a comment marking it as a duplicate; migrating its eight callers is follow-up work |
| T-2026-07-25-12 | MEDIUM | Client: six modules well under the 70% threshold with no test file of their own — `livekitDiagnostics` 30.4%, `drag-reorder` 38.8%, `deep-link` 44.1%, `roomEventHandlers` 57.1%, `screenShare` 61.1%, `volume-menu` 77.7% | **RESOLVED** — eight new test files; all now ≥96% except `screenShare`, whose remaining gap is the untested-by-design capture paths |
| T-2026-07-25-13 | MEDIUM | Event replay/retention partly untested (`GetMaxEventSeq` seeds the hub's sequence counter at startup; `PruneEventsOlderThan` is the retention job) | **RESOLVED** — `Server/db/event_queries_test.go`, including the channel filter that stops a replay leaking events for channels a client cannot see |
| T-2026-07-25-14 | MEDIUM | Admin live-log stream: 11 consecutive uncovered functions in the `multiHandler` slog fan-out, including `Subscribe` — what a connected admin's SSE session hangs off | **RESOLVED** — `Server/admin/multihandler_test.go` |
| T-2026-07-25-15 | MEDIUM | `Server/Makefile` had **no test target at all**, so there was no blessed way to reproduce the CI run or read coverage locally | **RESOLVED** — `test`, `test-deadlock`, `cover`, `cover-all` added; `cover-all` prints the zero-coverage function list |
| T-2026-07-25-16 | MEDIUM | `-tags wazero` and `-tags otel` are only ever **built** in CI, never tested. ~598 lines of already-written tests (`plugin/sandbox_wazero_test.go`, `telemetry/telemetry_otel_test.go`) never execute, and the real WASM sandbox is untested in the default build | **OPEN — accepted for now.** Out of scope for this pass by explicit scoping decision. Single highest-leverage remaining CI change: add `go test -tags wazero ./plugin/...` and `go test -tags otel ./telemetry/...` |
| T-2026-07-25-17 | LOW | `Server/main.go` (452 LOC, `package main`) and `Server/scripts/seed.go` (371 LOC dev tool) have no tests | **OPEN.** `main.go` is wiring with no seam below the integration level; `seed.go` is a developer tool. Both are low-risk, but `main.go` is the largest untested single file on the server |
| T-2026-07-25-18 | LOW | `src/pages/MainPage.ts` (561 LOC orchestrator) and `src/main.ts` (597 LOC bootstrap) remain excluded from client coverage | **OPEN (documented).** Both exclusions now carry a written justification; `MainPage.ts` is explicitly tracked for unit tests, `main.ts` is bootstrap covered by e2e |
| T-2026-07-25-19 | LOW | No coverage threshold or ratchet on the Go side; no coverage instrumentation for Rust at all. The client's 70% vitest threshold is the only enforced floor anywhere | **OPEN.** Deliberately not added — a floor set below current coverage (84–92% per package) is theatre, and a ratchet needs a baseline store this repo does not have |
| T-2026-07-25-20 | LOW | `Server/ws` failed twice under full-suite `-coverpkg` runs, but passed 5/5 in isolation and under `-race`, and the failing test name was not captured | **OPEN — watch.** Load-sensitive and unreproduced. Not present in the `-race` gate CI actually runs |

---

## 3. Measured baselines (diff against these next time)

### Go — cross-package (`make cover-all`)

| Package | Before | After | | Package | Before | After |
|---|---|---|---|---|---|---|
| `permissions` | 100% | 100% | | `db` | 76% | **84%** |
| `logctx` | 76% | **96%** | | `api` | 79% | **84%** |
| `stackutil` | 94% | 94% | | `plugin` | 61% | **77%** |
| `ws` | 90% | **92%** | | `telemetry` | 70% | **75%** |
| `service` | 85% | **91%** | | `admin` | 67% | **86%** |
| `config` | 91% | 91% | | `updater` | 86% | 86% |
| `auth` | 90% | 90% | | `storage` | 89% | 89% |

Package-local (the CI artifact view), after: `permissions` 100%, `stackutil` 94%, `logctx` 88.9%,
`storage` 86.5%, `config` 85.7%, `telemetry` 85.1%, `ws` 82.2%, `api` 79.6%, `db` 78.6%,
`admin` 77.9%, `auth` 77.5%, `updater` 76.7%, `plugin` 67.5%, `service` 41.9%.
The `service` figure is the measurement artifact described in §1, not a real gap.

**Functions with zero coverage** (excluding generated `db/dbgen`, `scripts/`, `main.go`):
**~70 → 21.** The remainder are `sandbox_default.go` build-tag stubs, no-op telemetry
shims, `updater.downloadWindowsBinaryAndVerify` (Windows-only), and trivial accessors.

### Client (`npx vitest run --coverage`)

|  | Before | After |
|---|---|---|
| Test files | 121 | **129** |
| Tests | 3371 | **3572** |
| Statements | 92.93% | **94.87%** |
| Branches | 91.20% | **92.06%** |
| Functions | 93.51% | **94.28%** |

Statement coverage rose *despite* un-excluding previously hidden files. Per-module:
`livekitDiagnostics` 30.4→**100%**, `roomEventHandlers` 57.1→**100%**, `volume-menu`
77.7→**100%**, `credentials` excluded→**100%**, `updater` excluded→**100%**, `deep-link`
44.1→**96.6%**, `drag-reorder` 38.8→**96.5%**, `window-state` excluded→**95.7%**.

Modules that *looked* untested by filename but were already well covered indirectly —
recorded here so they are not re-flagged: `fenwick.ts` 95.9%, `formatting.ts` 100%,
`content-parser.ts`, `AccountTab.ts` 98.4%, `LoginForm.ts` 97.5%.

Still below 85% and untouched by this pass (pre-existing): `MessageList.ts` 83.5%,
`attachments.ts` 82.7%, `MemberList.ts` 81.4%, `livekitSession.ts` 79.4%,
`screenShare.ts` 61.1%, `UserProfilePopup.ts` 55.2% *branches*.

### Rust (`cargo test --lib`)

**47 → 74 tests.** Files with `#[cfg(test)]` modules: 6 of 12 → 8 of 12.
`tray.rs` (92 LOC), `lib.rs` (158 LOC), `main.rs` and `constants.rs` remain untested —
all plugin registration and menu wiring, accepted.

---

## 4. Two bugs surfaced by writing the tests

Both are pinned by tests describing actual behaviour, not silently patched.

**`Server/logctx` — `WithGroup` nests the correlation IDs.** `Handle` calls `r.AddAttrs`
after the inner handler has opened a group, so `req_id` is emitted as `http.req_id`.
A log search for a bare `req_id` stops matching. Harmless today because no production
code opens a logger-level group — which is exactly the condition the source comment says
to revisit. `TestHandlerSurvivesWithGroup` documents it.

**`drag-reorder.ts` — the listener ref-count never reaches zero.**
`attachDragHandlers` calls `ensureGlobalDragListeners()` once per *channel element*
(`ChannelSidebar.ts:431`, inside the per-channel render), while
`releaseGlobalDragListeners` is called once per *sidebar destroy* (`ChannelSidebar.ts:703`).
A sidebar with N channels takes N refs and returns 1, and every re-render takes N more.
The `AbortController` never fires, so both document listeners and the `activeDrag` closure
they capture live for the process lifetime. Currently benign — the handlers return
immediately while no drag is active — so the test pins the real behaviour under a
`KNOWN BUG` comment rather than changing sidebar lifecycle semantics.

---

## 5. CI gates after this pass

| Gate | Before | After |
|---|---|---|
| Go tests (`-race`, `-tags deadlock`) | every PR | unchanged |
| Go coverage artifact | uploaded, **wrong for `admin`** | uploaded, correct |
| Client unit tests + 70% threshold | every PR (blocking) | unchanged |
| Rust unit tests | **PRs to `main` only** | **every event** (`rust-tests`) |
| Rust clippy | lib only | lib (`tauri-build`) **+ `--all-targets`** (`rust-tests`) |
| Playwright e2e | **never** | **every PR, non-blocking** (`client-e2e`) |
| `-tags wazero` / `-tags otel` tests | never | **still never** (T-…-16) |
| Coverage floor / ratchet (Go, Rust) | none | none (T-…-19) |

---

## 6. Backlog

| # | Item | Finding | Sev |
|---|---|---|---|
| 1 | Run tag-gated tests in CI (`-tags wazero ./plugin/...`, `-tags otel ./telemetry/...`) — unlocks ~598 lines of existing tests | T-…-16 | MEDIUM |
| 2 | Promote `client-e2e` to blocking once it has soaked | T-…-06 | MEDIUM |
| 3 | Fix the `drag-reorder.ts` ref-count asymmetry and update its pinning test | §4 | MEDIUM |
| 4 | Migrate the eight `HandleLiveKitHealthForTest` callers to `LiveKitHealthHandlerForTest` and delete the duplicated hook | T-…-11 | LOW |
| 5 | Unit tests for `src/pages/MainPage.ts`, then remove its coverage exclusion | T-…-18 | LOW |
| 6 | Decide on `logctx.WithGroup` nesting before any logger-level group is introduced | §4 | LOW |
| 7 | Watch for the `ws` flake under instrumented full runs; capture the test name if it recurs | T-…-20 | LOW |
| 8 | `gofmt` misalignment in `Server/storage/storage.go` (pre-existing; CI runs golangci-lint, not `gofmt -l`) | — | LOW |
