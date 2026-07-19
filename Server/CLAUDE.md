# OwnCord Server (Go)

Go 1.25, module `github.com/owncord/server`. Standard library preferred; key deps: chi (HTTP), koanf (config), sqlc-generated SQLite layer, LiveKit server SDK, coraza WAF, prometheus.

## Layout

- `api/` REST handlers · `ws/` WebSocket hub + generated `message_types.go` · `auth/` sessions/TOTP · `permissions/` role checks
- `db/` hand-written query wrappers + tests; `db/dbgen/` is **generated** (sqlc) from `db/queries/*.sql` and `migrations/` — never edit by hand
- `admin/` web admin panel · `updater/` self-update + signature verification · `plugin/` WASM plugin runtime (`-tags wazero`)
- `telemetry/` OTel (`-tags otel`) · `syncutil/` lock helpers with deadlock-detection build tag

## Rules

- After changing `db/queries/`, `migrations/`, or `sqlc.yaml`: run `make sqlc-generate` and commit the regenerated `db/dbgen/`. CI runs `make sqlc-verify`.
- After changing `../docs/protocol-schema.json`: run `make protocol-generate` (regenerates Go **and** TS constants) and commit both. CI runs `make protocol-verify`.
- All three build-tag variants must compile: `-tags otel`, `-tags wazero`, `-tags otel,wazero`.
- Tests must pass under `-race` and `-tags deadlock`. Prefer table-driven tests next to the code (`*_test.go`).
- Lint gate is `golangci-lint` (v2.11.3 in CI) plus `govulncheck`.
