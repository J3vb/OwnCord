# OwnCord

Self-hosted chat platform (alpha). Two components in one repo:

- `Server/` — Go 1.26 server: REST API (chi), WebSocket hub, SQLite (sqlc), LiveKit voice/video, admin panel.
- `Client/tauri-client/` — Tauri v2 desktop client: Rust backend, TypeScript frontend (Vite, no framework), vitest + Playwright tests.

Docs live in `docs/` — start with `docs/architecture/README.md`, `docs/protocol.md`, `docs/schema.md`. Deeper per-component guidance is in `Server/CLAUDE.md` and `Client/tauri-client/CLAUDE.md`.

## Golden rules

1. **Never hand-edit generated code.** `Server/db/dbgen/` comes from `make sqlc-generate`; `Server/ws/message_types.go` and `Client/tauri-client/src/lib/protocolTypes.ts` come from `make protocol-generate` (source of truth: `docs/protocol-schema.json`). CI fails if generated output drifts. Use the `db-change` / `protocol-change` skills for these workflows.
2. **The client unit test suite is GREEN and must stay green.** Run `npm test` before pushing; the full suite must pass 100%. Never make a failing test pass by weakening its assertions, and any test you add must pass.
3. **Run the CI mirror before pushing** (use the `ci-check` skill, or the commands below). CI runs on every PR to `main`/`dev` and takes ~15 min; catching errors locally is much faster.
4. Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`). Branch from `main`; PRs target `main`; squash merge preferred.
5. Security issues go through GitHub Security Advisories, never public issues (`docs/security.md`).

## Commands

### Server (run from `Server/`)

```bash
go build ./...                    # build (CGO_ENABLED=0 for release binaries)
go build -tags otel ./...         # each tag variant must also compile:
go build -tags wazero ./...       # otel, wazero, otel+wazero (CI checks all three)
go test -race ./...               # tests (CI adds -timeout 20m and coverage)
go test -tags deadlock -count=1 ./...  # deadlock-detection pass (CI runs this too)
go vet ./...
make sqlc-install sqlc-verify     # generated db code must not be stale
make protocol-verify              # generated protocol constants must not be stale
```

Lint: `golangci-lint run` (CI pins v2.11.3). Go 1.26 required — older local toolchains auto-download it via `GOTOOLCHAIN=auto`.

### Client (run from `Client/tauri-client/`)

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint + eslint (type-aware)
npm run format:check # prettier
npm test             # vitest (see golden rule 2)
npm run test:unit -- tests/unit/<file>   # single test file
npm run dev          # Vite dev server; `npm run tauri dev` for the full app
```

CI also runs `npm audit --audit-level=high` and `knip` (advisory).

## Git hooks (fast CI-error catching)

Committed hooks live in `.githooks/`. Enable once per clone:

```bash
npm run hooks:install   # = git config core.hooksPath .githooks
```

- `pre-commit` — fast, staged-file-aware: gofmt/go vet, oxlint/prettier, generated-code staleness when their inputs changed.
- `pre-push` — server build (all tag variants) + tsc + eslint. Set `OWNCORD_PREPUSH_TESTS=1` to also run server tests.
- Bypass in an emergency with `--no-verify` or `OWNCORD_SKIP_HOOKS=1`, but CI will still enforce everything.

## Repo layout notes

- `Server/db/queries/*.sql` + `Server/migrations/` → sqlc inputs; `Server/sqlc.version` pins the sqlc binary.
- `Server/scripts/genprotocol/` generates WS message-type constants for both Go and TS.
- `.github/workflows/ci.yml` is the source of truth for what must pass; hooks and the `ci-check` skill mirror it.
- Release signing keys/secrets are documented in README; never commit keys.
