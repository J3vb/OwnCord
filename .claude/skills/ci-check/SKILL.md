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
go test -race ./...
go test -tags deadlock -count=1 ./ws/    # deadlock detector; ws is where lock order actually varies
golangci-lint run                        # CI pins v2.11.3

# Generated output must not be stale. These are what `make sqlc-verify` and
# `make protocol-verify` reduce to — make is not on PATH on a stock Windows box.
sqlc generate && git diff --exit-code db/dbgen
go run ./cmd/genprotocol && git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts
```

Add `-tags wazero` to `go vet`/`go test` when you touched `plugin/`.

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
npm test
npm run typecheck
npm run lint
```

Formatting is no longer a client gate — Prettier is configured once at the
repository root and checked by `check:hygiene` below.

`NODE_OPTIONS=--no-experimental-webstorage` used to be required here. It is not
any more: `tests/setup.ts` installs an in-memory `localStorage` shim, CI runs
Node 24 without the flag (`ci.yml`), and the full suite was measured passing
without it — 192 files / 5257 tests, identical to the flagged run.

`npm audit --audit-level=high` and `knip` also run in CI but are advisory.

## Hygiene (from the repository root)

```bash
npm run check:hygiene
```

Which is:

```bash
npx prettier --check .          # every material tracked source, not just client TS
shellcheck <tracked *.sh + .githooks/pre-commit + .githooks/pre-push>
actionlint .github/workflows/*.yml
```

`shellcheck` and `actionlint` have no clean Windows install, so `run.mjs` marks
them optional and prints `--- SKIP` instead of failing; CI runs them for real.
Prettier is not optional and runs everywhere.

The file lists come from `git ls-files`, never a filesystem glob:
`.claude/worktrees/` holds gitignored copies of the tree that a glob would
happily lint.

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
advisory date before hunting your diff. It is skipped on Dependabot PRs by design
(it overlaps the scanning that opened them), so a clean Dependabot run does not
mean the advisory set is clean. The client equivalents, `npm audit --omit=dev
--audit-level=high` and `knip`, are advisory in CI.

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

| Signature                                                                                                                                                                                      | Verdict / recovery                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `windows-latest` `-race` fault in `ws`: `runtime.scanstack`, `runtime.(*unwinder).next`, or `unexpected fault address 0xffffffffffffffff` / `fatal error: fault` inside ordinary stdlib frames | Go runtime GC fault, not your code — see the Server section. `gh run rerun --job <id>`                                                                             |
| `##[error]The operation was canceled.` + `Terminate orphan process: ... playwright install --with-deps` + a wall of `Ign:N http://azure.archive.ubuntu.com/...` and no Playwright summary line | Runner apt-mirror outage during "Install Linux system dependencies". The job was **canceled by timeout**, not failed. `gh run cancel` then `gh run rerun --failed` |
| Red `Lint` step with zero linters actually run                                                                                                                                                 | `golangci-lint`'s network schema fetch failed. Re-run                                                                                                              |

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
