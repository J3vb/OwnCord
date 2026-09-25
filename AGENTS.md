# AGENTS.md

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the source documents win.

Tool-neutral instructions for AI coding agents (Codex, Cursor, and similar) working in this repository. `.codex/AGENTS.md` supplements this file with Codex-specific baseline config.

## Project context

OwnCord is a self-hosted chat platform (alpha):

- `Server/` — Go 1.26 REST + WebSocket server over SQLite, with LiveKit voice/video. Key deps: chi (HTTP), sqlc-generated SQLite layer, LiveKit server SDK, coraza WAF, prometheus.
- `Client/` — Tauri v2 desktop app: TypeScript frontend (Vite, vanilla TS, no React/Vue) plus a deliberately thin Rust backend (`src-tauri/`) for native APIs only. LiveKit handles voice/video.

Per-component detail lives in [Server/CLAUDE.md](Server/CLAUDE.md) and [Client/CLAUDE.md](Client/CLAUDE.md). The protocol and schema are documented in [docs/protocol.md](docs/protocol.md), [docs/schema.md](docs/schema.md), and [docs/architecture/README.md](docs/architecture/README.md).

## Before you start

Read before making non-trivial changes:

- [PRD.md](PRD.md) — product requirements
- [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — UI design system
- [CODE_STYLE.md](CODE_STYLE.md) — code style conventions
- [DATABASE.md](DATABASE.md) — schema and query conventions
- [API.md](API.md) — REST API surface
- [SECURITY.md](SECURITY.md) — security policy
- [docs/protocol.md](docs/protocol.md) — WebSocket protocol semantics
- [docs/schema.md](docs/schema.md) — database schema reference

**Inspect existing code before creating new components or helpers.** OwnCord has established layouts and extraction patterns per component (see Server/CLAUDE.md and Client/CLAUDE.md) — reuse them rather than introducing a parallel structure.

## General rules

- `dev` is the integration branch; `main` carries releases only. Branch from `dev`, PR to `dev`. `dev` is protected and PR-only: direct pushes are rejected and all required checks must pass.
- Squash merge, with a conventional commit subject on the squashed commit (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).
- Branch naming: `feature/<name>`, `fix/<name>`, `docs/<name>`.
- For anything non-trivial, the commit body carries the reasoning (what was wrong, why the obvious fix is wrong, what was done, a `Verified:` paragraph) — not a restatement of the diff. End with a `Not included:` line naming adjacent scope deliberately left out.
- If a change is one an operator would notice, add a `CHANGELOG.md` entry under `## Unreleased`, following that file's "How to write an entry" section.
- Never make a failing test pass by weakening its assertions — the client unit suite is green and must stay green.
- Never lower a coverage threshold or floor to make a change fit (`Server/coverage-floor.json`, `Client/coverage-floor.json`, `Client/vitest.config.ts`).
- Follow a test-driven workflow.
- Claude Code users: see [CLAUDE.md](CLAUDE.md).

## Code guidelines

- **Go**: `gofmt` + `golangci-lint` (CI pins v2.11.3), standard library preferred. Prefer the standard library over hand-rolled concurrency primitives — `Server/syncutil/` exists so lock usage is uniform and detectable; `Server/invariants/` enforces this at `go test` time.
- **TypeScript**: see [Client Architecture](docs/architecture/client.md). Vanilla TS, no React/Vue. New or extracted client code goes under `src/features/`, using relative imports.
- **Rust**: `cargo fmt` + `cargo clippy`, minimal code — native APIs only, no business logic.
- Formatting is enforced by Prettier (client + repo-wide) and `gofmt` (server); match surrounding code rather than reasoning about style from scratch.
- `src/` (Client) has no import cycles — `npm run lint:cycles` runs at `--max-warnings=0`. Invert the dependency edge rather than importing upward.
- Server: only `db/` and `service/` import `db` freely; a new persistence path goes behind a service, not a handler. Only `permissions/` calls the raw permission-bit helpers — everywhere else resolves a `permissions.Subject` and calls the predicate that owns the property.
- Client WebSocket events reach domain stores only through the single `ws.on(...)` subscription point in `src/lib/dispatcher.ts`; handler bodies live in `src/features/*/wsHandlers.ts`.

## Design rules

- See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) for the UI design system.
- Client CSS: `src/styles/app.css` is an `@import` manifest over `src/styles/app/*.css`; its import order is the cascade — add rules to the owning fragment, never reorder imports or move rules between fragments in a visual PR.
- All user-generated content renders via `textContent`/`setText`, never `innerHTML`. URLs are validated via `isSafeUrl` (rejects `javascript:`, `data:`, `vbscript:`).

## Security rules

- Security vulnerabilities go through [GitHub Security Advisories](https://github.com/J3vb/OwnCord/security/advisories/new) — **never** a public issue, pull request, or discussion. This repository is public: a commit message, PR description, or branch name is a disclosure channel. Do not describe a weakness in the public change that repairs it.
- Public artifacts (commits, issues, PR descriptions, changelogs) may carry only an opaque identifier, the affected property, safe acceptance criteria, and a status — never reproduction steps or exploit conditions.
- The canonical reporting policy is the repository-root `SECURITY.md`; [docs/security.md](docs/security.md) has the detail on what stays private and for how long.
- Full detail: [SECURITY.md](SECURITY.md), [docs/security.md](docs/security.md).

## Commands

Root facade (from the repository root) — orchestrates the per-stack commands; `node scripts/run.mjs --list` prints the exact command each task runs and where:

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `npm run bootstrap`         | `npm ci` in all three package roots                                             |
| `npm run check`             | Everything CI gates on: server, client, Rust                                    |
| `npm run check:server`      | Server only — build variants, vet, race, deadlock, lint, generated-output drift |
| `npm run check:client`      | Client only — typecheck, lint, knip, coverage-gated tests, bundle budgets       |
| `npm run check:rust`        | Tauri backend — `cargo test --lib` and clippy                                   |
| `npm run check:docs`        | Doc/ledger consistency check                                                    |
| `npm run check:hygiene`     | Prettier check, shellcheck, actionlint over tracked files                       |
| `npm run format`            | Prettier over the client, `gofmt -w` over the server                            |
| `npm run generate`          | Regenerate protocol constants and the sqlc query layer                          |
| `npm run release:preflight` | `check` plus a client production build                                          |

**This is the local mirror of OwnCord CI — run the matching section before pushing.** Run only the sections your change touches; server and client are independent.

Server (from `Server/`):

```bash
go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./...
go vet ./...
go test -race ./...
go test -tags deadlock -count=1 ./...
golangci-lint run
```

Client (from `Client/`):

```bash
npm run dev            # Vite dev server (Tauri overlay)
npm run build          # typecheck + production build
npm test               # vitest run (all tests, incl. contract)
npm run test:unit      # unit tests only
npm run test:integration
npm run test:contract
npm run test:e2e       # Playwright, mocked Tauri
npm run test:e2e:native   # Playwright, real Tauri exe + CDP
npm run test:e2e:admin    # Playwright, real Go server + SPA
npm run typecheck
npm run typecheck:build
npm run lint           # oxlint (warnings denied) + import cycles + ESLint
npm run knip           # dead code / unused exports
```

Rust (from `Client/src-tauri/`):

```bash
cargo fmt --all -- --check
cargo test --lib
cargo clippy --all-targets -- -D warnings
```

Do not run `npm run tauri build` or `cargo build`/`tauri build` targeting the full desktop installer locally — the full desktop build is CI-only.

sqlc / protocol regeneration (from `Server/`):

```bash
make sqlc-generate       # regenerate Server/db/dbgen/ from Server/db/queries/*.sql + migrations
make sqlc-verify         # fail if committed dbgen output is stale (CI)
make protocol-generate   # regenerate WS message-type constants (Go + TS) from protocol/schema.json
make protocol-verify     # fail if committed protocol constants are stale (CI)
```

If `make` is unavailable, the underlying commands are `sqlc generate` (db layer, pinned version in `Server/sqlc.version`) and `go run ./cmd/genprotocol` (protocol constants), each followed by `git diff --exit-code` on the generated paths.

gendocs (from `Server/`):

```bash
go run -tags otel,wazero ./cmd/gendocs
```

Regenerates the `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md` from `Server/api/router.go`, `Server/migrations/`, and `Server/config/config.go`.

### Tools table

Optional CLI tools that make a task cheaper — none is required to build or test. The last four are also CI checks, gated by which paths changed.

| Tool               | Reach for it when                                                        |
| ------------------ | ------------------------------------------------------------------------ |
| `ast-grep`         | searching/rewriting a structural pattern across TS/Go/Rust               |
| `gotestsum`        | a failing Go run where you want the failures, not the wall of `ok` lines |
| `lk` (livekit-cli) | checking voice/video without a browser                                   |
| `ctx7`             | looking up current library docs rather than trusting memory              |
| `osv-scanner`      | after moving any lockfile (`Server/go.mod`, npm, Cargo)                  |
| `cargo-deny`       | after changing `Client/src-tauri/Cargo.toml`/`.lock`                     |
| `zizmor`           | after editing anything under `.github/workflows/`                        |
| `actionlint`       | after editing a workflow                                                 |

Claude Code users: see [CLAUDE.md](CLAUDE.md) for exact install/run invocations and skills that wrap these commands.

## Boundaries

### Generated code — never hand-edit

CI fails on drift, and the next generator run silently discards a hand edit.

| Generated                                                                             | Source of truth                                                         | Regeneration command                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `Server/db/dbgen/`                                                                    | `Server/db/queries/*.sql`, `Server/migrations/`                         | `make sqlc-generate` (from `Server/`)                 |
| `Server/ws/message_types.go` **and** `Client/src/lib/protocolTypes.ts`                | `protocol/schema.json`                                                  | `make protocol-generate` (from `Server/`)             |
| `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md` | `Server/api/router.go`, `Server/migrations/`, `Server/config/config.go` | `cd Server && go run -tags otel,wazero ./cmd/gendocs` |

### Branch model

- `dev` — the integration branch. All contributions target `dev`.
- `main` — releases only. `dev` is merged to `main` for a release, and release tags are cut from `main`.
- Squash merge, with a conventional commit subject on the squashed commit.
- Full model: [docs/contributing.md](docs/contributing.md#branch-and-pr-model).

### Other boundaries

- Do not run `npm run tauri build` locally — the desktop installer build is CI-only.
- A Linux Rust build (`cargo test`/`clippy`/`tauri build`) needs a prerequisite toolchain: run `eval "$(Client/scripts/linux-webrtc-toolchain.sh)"` in each shell first (installs clang >= 21 and a prebuilt libwebrtc). Windows and server-only work need nothing. Details: [Client/CLAUDE.md](Client/CLAUDE.md), [docs/contributing.md](docs/contributing.md#client-tauri-v2).
- Only `db/` and `service/` (Server) import `db` freely; anywhere else needs an explicit allowlist entry.
- `src/platform/desktop/` (Client) is the only place under `src/` a `@tauri-apps` import may appear — eslint enforces it.

## Sources

- [CLAUDE.md](CLAUDE.md)
- [Server/CLAUDE.md](Server/CLAUDE.md)
- [Client/CLAUDE.md](Client/CLAUDE.md)
- [docs/contributing.md](docs/contributing.md)
- [docs/security.md](docs/security.md)
- [.codex/AGENTS.md](.codex/AGENTS.md)
- [package.json](package.json)
- [Client/package.json](Client/package.json)
- [.claude/skills/ci-check/SKILL.md](.claude/skills/ci-check/SKILL.md)
- [.claude/skills/db-change/SKILL.md](.claude/skills/db-change/SKILL.md)
- [.claude/skills/protocol-change/SKILL.md](.claude/skills/protocol-change/SKILL.md)
