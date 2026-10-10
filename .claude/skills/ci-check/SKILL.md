---
name: ci-check
description: Run the local mirror of OwnCord's CI gates before pushing. Use when finishing a change, before a commit or push, or when asked to verify work — CI takes ~15 min and catches things a plain build/test does not.
---

# ci-check

`.github/workflows/ci.yml` is the source of truth. This mirrors it locally.

Run only the sections your change touches. Server and client are independent.

**A step added only to `release.yml` first runs at tag time.** `release.yml` is
tag-triggered and never gated by a PR, so a smoke/sign/strip step added there is
untested code on the critical path — its own bugs surface on the release, not on
a PR. Extract it to a script `ci.yml` also runs (`Server/scripts/docker-smoke.sh`
is the worked example) or duplicate it into `ci.yml` before merge.

From the repository root, `npm run check` runs all of it, and
`check:server` / `check:client` / `check:rust` / `check:hygiene` run one stack.
`node scripts/run.mjs --list` prints the exact command each step runs and the
directory it runs in — the per-stack commands below are those commands, and
staying with them is fine. Nothing here needs `make`, and server work needs no
Node.

## Server (from `Server/`)

All four build-tag variants must compile — the tags gate whole files, so a
default-build pass proves nothing about the others:

```bash
go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./...
go vet ./...
go test -race -timeout 20m ./...          # -timeout 20m matches CI; ws alone took 431 s here
go test -tags deadlock -count=1 ./...     # CI runs the WHOLE tree here (ci.yml), not just ./ws/
go test -count=1 -run '^TestRingBuffer_WriteDoesNotAllocate$' ./admin/...  # plain leg: logstream_alloc_test.go is !race && !deadlock
go test -count=1 -run '^TestWriteReady_AllocatesAFifthOfTheRoster$' ./ws/        # plain leg: serve_ready_alloc_test.go is !race && !deadlock
golangci-lint run                        # CI pins v2.14.0 — check `golangci-lint --version` first

# `ci.yml` also runs these three first, in `Server Lint & Invariants`, so they
# report in seconds rather than after the race run. Mirroring them locally is
# the fast path when iterating on a rule or a lint.
go test ./invariants/...
go test -count=1 ./cmd/dbinventory/ ./migrations/

# Generated output must not be stale. These are what `make sqlc-verify`,
# `make protocol-verify` and `make docs-verify` reduce to — make is not on PATH
# on a stock Windows box.
sqlc generate && git diff --exit-code db/dbgen
go run ./cmd/genprotocol && git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts
go run -tags otel,wazero ./cmd/gendocs && git diff --exit-code ../docs/api.md ../docs/schema.md ../docs/server-configuration.md
```

Add `-tags wazero` to `go vet`/`go test` when you touched `plugin/`.

**The deadlock leg is the whole tree, not `./ws/`.** This line used to say `./ws/` —
"where lock order actually varies" — and a B6-8 branch that touched no `Server/admin`
file still went red on `Server Build & Test (windows-latest)` in that leg, on an
`admin` test the narrower local command never ran. `ci.yml`'s step is
`go test -tags deadlock -count=1 ./...`; mirror it or the local run is not a mirror.
`./ws/` alone is still the right quick check while iterating on lock order — just not
the thing to call green before pushing.

**A `golangci-lint` already on PATH may be the wrong one, and says so
confusingly.** A build older than this module's Go target refuses outright:

```
can't load config: the Go language version (go1.26) used to build
golangci-lint is lower than the targeted Go version (1.27.1)
```

That is the binary's age, not a missing gate — it reads like "cannot run
here" and is not. Fetch the pinned version rather than skipping the step:

```bash
curl -sSfL -o /tmp/glci.tgz https://github.com/golangci/golangci-lint/releases/download/v2.14.0/golangci-lint-2.14.0-linux-amd64.tar.gz
tar xzf /tmp/glci.tgz -C /tmp && /tmp/golangci-lint-2.14.0-linux-amd64/golangci-lint --version
```

A `windows-latest` `-race` failure inside `ws` that matches `runtime.scanstack`
or `runtime.(*unwinder).next` is a Go 1.26.5 runtime GC fault, not your change.
The Go 1.26.6 toolchain shows a variant signature: `unexpected fault address
0xffffffffffffffff` / `fatal error: fault` (signal 0xc0000005) inside ordinary
stdlib frames such as `log/slog.(*Logger).Enabled` — same spurious runtime
fault, same verdict, especially when the diff touches no Go code. Rerun the
job (`gh run rerun --job <id>`); a job cannot be rerun while its parent run is
still in progress.

## Client (from `Client/`)

```bash
node --test ../scripts/check-tauri-versions.test.mjs
node ../scripts/check-tauri-versions.mjs
npm test
npm run typecheck
npm run typecheck:build   # tsconfig.build.json — the shipped app graph
npm run typecheck:e2e     # tsconfig.e2e.json — tests/e2e, EXCLUDED from the main tsconfig
npm run check:admin-types # Server/admin/static/js checkJs, shrink-only baseline
npm run lint
npm run build:budget && npm run check:budgets   # B7-7 gzip budgets; see bundle-budgets.json
```

**`npm run typecheck` does not cover `tests/e2e/`.** The main tsconfig excludes
it from the app graph, so a Playwright spec can fail `Client Static Checks`
while the local typecheck is clean — CI runs `tsc -p tsconfig.e2e.json` as its
own step. A branch adding or editing an e2e spec has not been checked until
`typecheck:e2e` has run.

The Tauri check reads resolved npm/Cargo lockfile versions without installing
or building. Paired core/API and official plugin packages must have matching
major/minor versions; independent npm and Cargo dependency updates must update
the other side when that pair moves to a new minor release. CI runs this in
Client Static Checks and before the Windows native build.

Formatting is no longer a client gate — Prettier is configured once at the
repository root and checked by `check:hygiene` below.

`NODE_OPTIONS=--no-experimental-webstorage` used to be required on the command
line. It is not any more: `vitest.config.ts` appends the flag to
`process.env.NODE_OPTIONS` in vitest's parent process, and every forked worker
inherits it (`poolOptions.forks.execArgv` does not work — vitest replaces
execArgv with its own list). jsdom's own `localStorage` and `Storage` are then
the only ones present, and `tests/setup.ts` throws if the flag did not reach
the worker (OC-0415). There is no shim; an earlier in-memory shim was
removed because it left Node's `Storage` class shadowing jsdom's and twelve
storage tests asserting nothing. CI runs Node 26 without setting the variable
(`ci.yml`), and the full suite was measured passing that way — 337 files /
7250 passed + 154 expected fail (7405 total) on 2026-09-27.
`npm audit --audit-level=high` (scoped to shipped deps, via
`scripts/npm-audit-gate.sh`) and `knip` both run in `Client Static Checks` and
both **block** — they are not advisory. The audit gate forgives only a
recognised registry outage, fail-closed on every real finding.

## Docs and ledger (from the repository root)

```bash
npm run check:docs
```

Which is `scripts/check-doc-counts.mjs` plus, since B1-6, an actual render of
the findings ledger:

```bash
node .superpowers/render-ledger.mjs
```

`.superpowers/FINDINGS.md` is **not tracked** — it is generated on demand and
gitignored, so there is no committed rendering to go stale. The gate is that
generation succeeds. Rendering subsumes `--check`: the renderer validates and
exits 1 before it writes, so a schema break (including an unranked `severity`)
fails here.

CI does one thing more, in `Docs & Ledger Consistency` — it renders **twice**
and compares, proving the output is a pure function of the ledger, then uploads
the rendering as the `findings-ledger-rendering` artifact so a reviewer can read
it without running Node.

## Hygiene (from the repository root)

```bash
npm run check:hygiene
```

Which is:

```bash
git ls-files -z | xargs -0 npx prettier --check --ignore-unknown   # tracked material sources, not the filesystem
shellcheck <tracked *.sh + .githooks/pre-commit + .githooks/pre-push>
actionlint .github/workflows/*.yml
```

`shellcheck` and `actionlint` have no clean Windows install, so `run.mjs` marks
them optional and prints `--- SKIP` instead of failing; CI runs them for real.
Prettier is not optional and runs everywhere.

Every file list comes from `git ls-files`, never a filesystem glob: `.opencode/`
holds git-excluded scratch a glob would happily lint, and
`Client/src-tauri/target/` is ~23 GB excluded only by a nested `.gitignore`.
`run.mjs` chunks the tracked list on Windows, where the command line is capped
at ~8 KB; in `check:hygiene` the prettier step is labelled `Prettier (chunk n/m)`
for that reason.

Go formatting is not here. `gofmt -l` prints offenders and still exits 0, so it
cannot fail a build; the `formatters` block in `Server/.golangci.yml` enforces
it inside `golangci-lint run`, and `.githooks/pre-commit` catches staged files.

## Rust (from `Client/src-tauri/`)

```bash
cargo fmt --all -- --check               # runs ahead of clippy in CI
cargo test --lib                         # CI runs --lib; plain `cargo test` also builds the bin target
cargo clippy --all-targets -- -D warnings
cargo install cargo-audit@0.22.1 --quiet && cargo audit   # CI runs this in tauri-build
```

`cargo audit` is the one gate here that turns red with **zero** local changes —
an advisory published upstream breaks a branch that was clean yesterday. Check the
advisory date before hunting your diff. The client equivalents, `npm audit --omit=dev
--audit-level=high` and `knip`, **block** in `Client Static Checks`.

`fallback_crypto` is `cfg(not(windows))`, so its tests compile to nothing on a
Windows box and only run on the Linux/macOS runners.

Do not attempt `npm run tauri build` locally — the full desktop build runs in
CI on PRs to `main` and pulls heavy system dependencies.

## Reading a red check

**Causality before forensics.** Before opening a failing job's log, diff the
PR's changed-file set against that job's input surface and ask whether the change
could reach it. A diff touching only `.github/workflows/*.yml` cannot cause a Go
goroutine leak — that failure is pre-existing or flaky by construction. Re-run
first, and check `dev`/`main` is green to tell "flaky" from "already red". Only
start log-reading once the change plausibly reaches the job.

**Compare against the baseline, never against zero.** For any gate a repo
knowingly runs red, the unit of verification is the _delta_ from a recorded
baseline, not pass/fail — absolute pass/fail only means something when the
intended state is zero. Get the delta with `git stash && <gate> > /tmp/base &&
git stash pop && <gate> | diff /tmp/base -`. This repo currently carries **no**
known-red gate: `golangci-lint`'s complexity backlog was cleared to zero, so a
red `golangci-lint` is now genuinely yours. If a budget is ever retuned upward,
record the new baseline here next to the command or the gate reports nothing.

**A dependency bump that breaks the build may be a fork, not a version.** When an
updated dependency suddenly demands configuration it never needed, suspect it was
inheriting that configuration from a shared resolution with another dependent.
Diff the lockfile _entry count_ for that dependency between base and PR: a 1 → 2
transition means the update forked it into two semver-incompatible copies, feature
unification stopped crossing the boundary, and the fix is to restore version
alignment with whatever else requires it — not to set the feature the new copy
asks for.

### Known infra flakes

Not your change. Match the signature, then recover.

| Signature                                                                                                                                                                                      | Verdict / recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windows-latest` `-race` fault in `ws`: `runtime.scanstack`, `runtime.(*unwinder).next`, or `unexpected fault address 0xffffffffffffffff` / `fatal error: fault` inside ordinary stdlib frames | Go runtime GC fault, not your code — see the Server section. `gh run rerun --job <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `##[error]The operation was canceled.` + `Terminate orphan process: ... playwright install --with-deps` + a wall of `Ign:N http://azure.archive.ubuntu.com/...` and no Playwright summary line | Pre-fix signature, from before the install was bounded: a runner apt-mirror outage held the whole job until its `timeout-minutes` cancelled it. Cannot occur once the install is bounded (a hang now fails only the `Install Playwright browser` step, see the next row); if it appears, a workflow regressed to the unbounded one-liner (`check-workflow-guards.mjs` fails on it). `gh run cancel` then `gh run rerun --failed`                                                                                                                      |
| Red `Install Playwright browser` step (`scripts/ci/playwright-install.sh`) after `Ign:`/`Err:` apt lines, or `The action ... has timed out after 8 minutes`                                    | Runner apt-mirror outage, now bounded at the step: apt gets 30 s timeouts and 3 retries (`/etc/apt/apt.conf.d/99-owncord-ci`) and the step has `timeout-minutes: 8`, so only this step goes red and the job is not cancelled. The browser itself is cached in `~/.cache/ms-playwright`, so the download phase is a no-op on a cache hit. Red in the `install-deps` phase = mirror down for the whole window: `gh run rerun --failed`. Red in `install chromium` = the browser download (cache miss); also re-run. Any other Playwright error is yours |
| Red `Lint` step with zero linters actually run                                                                                                                                                 | `golangci-lint`'s network schema fetch failed. Re-run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `[WebServer] abort: Lazy deopt after a fast API call with return value is unsupported` + a storm of `ERR_CONNECTION_REFUSED at http://localhost:1420/`                                         | Node 26 V8 bug in the dev-server transform path. `Client/playwright.config.ts` starts Vite with `--no-turbo-fast-api-calls`; if this appears again the flag was lost (`tests/unit/playwright-devserver-v8-flag.test.ts` pins it). Re-run, then restore the flag                                                                                                                                                                                                                                                                                       |

`gh run view --log` refuses while a run is in progress; `gh api
repos/<owner>/<repo>/actions/jobs/<id>/logs` works. A job cannot be rerun while
its parent run is still in progress. `tauri-build` has no `timeout-minutes`, so a
hung apt step can hold a run open for the 6 h default — cancel it rather than wait.

## Hooks

`npm run hooks:install` (once per clone) points `core.hooksPath` at
`.githooks/`: `pre-commit` runs fast staged-file checks, `pre-push` runs the
server build variants plus tsc and eslint. `OWNCORD_PREPUSH_TESTS=1` adds
server tests. Bypass with `--no-verify` or `OWNCORD_SKIP_HOOKS=1` — CI still
enforces everything.

**`core.hooksPath` is exclusive, not additive.** Once set, Git resolves every
hook against `.githooks/` and stops consulting `.git/hooks/` entirely.
`.githooks/` holds only `pre-commit` and `pre-push`, so running
`hooks:install` **silently disables any locally installed hook** of any other
name (`post-commit`, `post-checkout`, ...). Nothing warns you. If you need one,
re-install it under `.githooks/` (untracked, and it stays yours), or skip
`hooks:install` and run the checks through `npm run check` instead.
