# OwnCord

Self-hosted chat platform (alpha). `Server/` is a Go 1.26 REST + WebSocket
server over SQLite with LiveKit voice/video; `Client/tauri-client/` is a Tauri
v2 desktop app (TypeScript frontend, thin Rust backend). Per-component detail
lives in `Server/CLAUDE.md` and `Client/tauri-client/CLAUDE.md`; the protocol
and schema are documented in `docs/protocol.md`, `docs/schema.md`, and
`docs/architecture/README.md`.

## Generated code — never hand-edit

CI fails on drift, and the next generator run silently discards your edit.

| Generated | Source of truth | Workflow |
| --- | --- | --- |
| `Server/db/dbgen/` | `Server/db/queries/*.sql`, `Server/migrations/` | `db-change` skill |
| `Server/ws/message_types.go` **and** `Client/tauri-client/src/lib/protocolTypes.ts` | `docs/protocol-schema.json` | `protocol-change` skill |
| `Client/tauri-client/src/generated/` | `tauri-typegen` | CI patches known typegen bugs — see `.github/workflows/ci.yml` |

## Gotchas

- **Verify with the `ci-check` skill**, not with an ad-hoc `go build && go test`.
  CI compiles four Go build-tag variants and runs a deadlock-detection pass;
  the default build proves nothing about the tagged ones.
- **The client unit suite is green and must stay green.** Never make a failing
  test pass by weakening its assertions.
- Security issues go through GitHub Security Advisories, never public issues
  (`docs/security.md`). This repo is public — unfixed defects do not belong in
  commits, issues, or PR descriptions.
- Branch from `main`, PR to `main`, squash merge, conventional commit subjects.
