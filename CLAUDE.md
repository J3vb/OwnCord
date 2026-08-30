# OwnCord

Self-hosted chat platform (alpha). `Server/` is a Go 1.26 REST + WebSocket
server over SQLite with LiveKit voice/video; `Client/` is a Tauri
v2 desktop app (TypeScript frontend, thin Rust backend). Per-component detail
lives in `Server/CLAUDE.md` and `Client/CLAUDE.md`; the protocol
and schema are documented in `docs/protocol.md`, `docs/schema.md`, and
`docs/architecture/README.md`.

## Generated code — never hand-edit

CI fails on drift, and the next generator run silently discards your edit.

| Generated                                                                             | Source of truth                                                         | Workflow                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Server/db/dbgen/`                                                                    | `Server/db/queries/*.sql`, `Server/migrations/`                         | `db-change` skill                                              |
| `Server/ws/message_types.go` **and** `Client/src/lib/protocolTypes.ts`                | `protocol/schema.json`                                                  | `protocol-change` skill                                        |
| `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md` | `Server/api/router.go`, `Server/migrations/`, `Server/config/config.go` | `cd Server && go run ./cmd/gendocs` (`make docs-verify` in CI) |
| `Client/src/generated/`                                                               | `tauri-typegen`                                                         | CI patches known typegen bugs — see `.github/workflows/ci.yml` |

## Bug-hunt ledger

`.superpowers/findings-ledger.json` is the shared ledger of hunt findings and
the only tracked copy — open a PR against it to add one. The readable
`FINDINGS.md` is **not tracked**: generate it whenever you want to read one
(gitignored, under a second, and CI uploads it as a build artifact):

```
node .superpowers/render-ledger.mjs           # write a local FINDINGS.md
node .superpowers/render-ledger.mjs --check   # validate the ledger only
```

Statuses: `open`, `fixed`, `declined`, `refuted`, `duplicate`, `blocked`;
`severity` must be `critical`, `high`, `medium` or `low`. Edit the ledger, never
the rendering — a hand-edited `FINDINGS.md` is overwritten by the next render
and committed by nothing. Everything else under `.superpowers/` is per-session
scratch and stays local.

## Gotchas

- **Verify with the `ci-check` skill**, not with an ad-hoc `go build && go test`.
  CI compiles four Go build-tag variants and runs a deadlock-detection pass;
  the default build proves nothing about the tagged ones.
- **The client unit suite is green and must stay green.** Never make a failing
  test pass by weakening its assertions.
- Security issues go through GitHub Security Advisories, never public issues
  (`docs/security.md`). This repo is public — unfixed defects do not belong in
  commits, issues, or PR descriptions.
- Branch from `dev` and PR to `dev` — `dev` is the integration branch and is
  PR-only; `main` carries releases. Squash merge, conventional commit subjects.
  Full model: [docs/contributing.md](docs/contributing.md#branch-and-pr-model).
