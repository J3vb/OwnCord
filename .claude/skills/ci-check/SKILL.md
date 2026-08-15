---
name: ci-check
description: Run the local mirror of OwnCord's CI gates before pushing. Use when finishing a change, before a commit or push, or when asked to verify work — CI takes ~15 min and catches things a plain build/test does not.
---

# ci-check

`.github/workflows/ci.yml` is the source of truth. This mirrors it locally.

Run only the sections your change touches. Server and client are independent.

## Server (from `Server/`)

All four build-tag variants must compile — the tags gate whole files, so a
default-build pass proves nothing about the others:

```bash
go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./...
go vet ./...
go test -race ./...
go test -tags deadlock -count=1 ./ws/    # deadlock detector; ws is where lock order actually varies
golangci-lint run                        # CI pins v2.11.3
make sqlc-verify protocol-verify         # generated output must not be stale
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

## Client (from `Client/tauri-client/`)

```bash
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run typecheck
npm run lint
npm run format:check
```

The `NODE_OPTIONS` flag is mandatory on Node 22+ — see the client CLAUDE.md.

`npm audit --audit-level=high` and `knip` also run in CI but are advisory.

## Rust (from `Client/tauri-client/src-tauri/`)

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

`fallback_crypto` is `cfg(not(windows))`, so its tests compile to nothing on a
Windows box and only run on the Linux/macOS runners.

Do not attempt `npm run tauri build` locally — the full desktop build runs in
CI on PRs to `main` and pulls heavy system dependencies.

## Hooks

`npm run hooks:install` (once per clone) points `core.hooksPath` at
`.githooks/`: `pre-commit` runs fast staged-file checks, `pre-push` runs the
server build variants plus tsc and eslint. `OWNCORD_PREPUSH_TESTS=1` adds
server tests. Bypass with `--no-verify` or `OWNCORD_SKIP_HOOKS=1` — CI still
enforces everything.
