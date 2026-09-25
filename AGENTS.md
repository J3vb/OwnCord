# Agent instructions

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the source documents win.

Instructions for AI coding agents (Codex, Cursor and similar) working in this repository. Claude Code reads [CLAUDE.md](CLAUDE.md) instead of this file when both exist; CLAUDE.md carries the same rules plus Claude-specific skills and hooks. Codex's repository baseline config lives in `.codex/`.

## Project context

OwnCord is a self-hosted chat platform (alpha):

- `Server/`: Go 1.26 REST + WebSocket server over SQLite, with LiveKit voice/video. Key dependencies: chi (HTTP), a sqlc-generated SQLite layer, the LiveKit server SDK, the Coraza WAF, Prometheus.
- `Client/`: Tauri v2 desktop app, a TypeScript frontend (Vite, vanilla TS, no React/Vue) plus a deliberately thin Rust backend (`src-tauri/`) for native APIs.
- `protocol/schema.json`: the single source of truth for WebSocket message types, generated into both sides.

Prerequisites ([README.md](README.md#prerequisites)):

- Go 1.26+, plus a C compiler on PATH for the `-race` tests. On Windows use a MinGW-w64 gcc such as WinLibs. Without a compiler, Go disables cgo and `go test -race` fails with `-race requires cgo`.
- Node.js 26.x with npm 11.x (`Client/.nvmrc`); a different major fails `npm ci`.
- Rust via rustup. `Client/src-tauri/rust-toolchain.toml` pins 1.98.1 with clippy and rustfmt, installed on the first cargo run.

## Before you start

Read the file for the area you are changing, not all of them:

| Changing…                                              | Read first                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Product scope or a user-facing feature                 | [PRD.md](PRD.md)                                                           |
| How components connect, data flow, deployment          | [ARCHITECTURE.md](ARCHITECTURE.md)                                         |
| Client UI, CSS, themes, accessibility                  | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)                                       |
| Any code: formatting, lint rules, tests                | [CODE_STYLE.md](CODE_STYLE.md)                                             |
| Schema, migrations, SQL queries                        | [DATABASE.md](DATABASE.md), then [docs/schema.md](docs/schema.md)          |
| REST routes or WebSocket messages                      | [API.md](API.md), then [docs/protocol.md](docs/protocol.md)                |
| Auth, permissions, secrets, E2EE, input handling       | [SECURITY.md](SECURITY.md)                                                 |
| Server or client internals and their component gotchas | [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md) |

Inspect existing code before creating a new component, helper or pattern. OwnCord has established layouts and extraction patterns per component; reuse them rather than introducing a parallel structure. If these files conflict, or a decision you need is missing, ask before making a major assumption.

## General rules

- **Branches:** branch from `dev` and open the PR against `dev`. `dev` is protected and PR-only (every required check must pass); `main` carries releases only. Branch names: `feature/<name>`, `fix/<name>`, `docs/<name>`. Full model: [docs/contributing.md](docs/contributing.md#branch-and-pr-model).
- **Commits:** squash merge, with a conventional-commit subject on the squashed commit (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`). For anything non-trivial the body carries the reasoning, a `Verified:` paragraph and a `Not included:` line; the full rule is in [CODE_STYLE.md](CODE_STYLE.md#commits-and-prs).
- **Changelog:** a change an operator would notice gets a `CHANGELOG.md` entry under `## Unreleased`, following that file's "How to write an entry" section.
- **Tests:** follow a test-driven workflow. The rules on assertions and coverage are under [Boundaries](#boundaries).
- **Verify before pushing:** run `npm run check:<stack>` for every stack you touched (see [Commands](#commands)), plus the extra CI-only checks that apply to your change. CI (`.github/workflows/ci.yml`) is the source of truth.
- **Dependencies:** add one only when it is necessary. A manifest or lockfile change triggers the supply-chain scan (osv-scanner, cargo-deny), which fails closed on a new finding.

## Code guidelines

Full rules: [CODE_STYLE.md](CODE_STYLE.md). Match the surrounding code rather than reasoning about style from scratch.

- **Go:** `gofmt` + `golangci-lint` (CI pins v2.11.3). Prefer the standard library, except for the concurrency-heavy packages: in `ws/` and `service/` declare `syncutil.Mutex`/`syncutil.RWMutex` (`Server/syncutil/`), never a raw `sync.Mutex`/`sync.RWMutex`. `syncutil` gains deadlock detection under `-tags deadlock`, and the `syncutil-locks` rule in `Server/invariants/` fails `go test` on a raw lock outside the frozen set — the rule's scope is `ws/` and `service/`, and a handful of other production files use raw locks deliberately (`Server/invariants/syncutil_locks.go` lists them).
- **Server layering:** `api → service → db`. Only `db/` and `service/` import `db` freely; new persistence goes behind a service, not into a handler. New authorization code resolves a `permissions.Subject` and calls the predicate that owns the property; only `permissions/` and a frozen residue listed in `AuthzResidueAllow` (`Server/invariants/authz_chokepoint.go`) call the raw permission-bit helpers.
- **TypeScript:** vanilla TS, no UI framework. New or extracted client code goes under `src/features/`, using relative imports, but `messages.store` mutators come from the `@stores/messages.store` facade, never its reducer modules ([Client/CLAUDE.md](Client/CLAUDE.md)). `src/` has no import cycles (`npm run lint:cycles`, `--max-warnings=0`); invert the dependency edge rather than importing upward.
- **Client platform seam:** `src/platform/desktop/` is the only place under `src/` a `@tauri-apps` import may appear; ESLint enforces it.
- **Client WebSocket events** reach domain stores only through the single `ws.on(...)` subscription point in `src/lib/dispatcher.ts`; handler bodies live in `src/features/*/wsHandlers.ts`.
- **Rust:** `cargo fmt` + `cargo clippy`, minimal code, native APIs only. Native services live there (the TOFU proxies, the external-content broker, and on Linux the native voice session); a Linux-only voice behaviour belongs in the adapter or the Rust session, never as a branch in `joinOrchestration`/`mediaControl`.

## Design rules

Full rules: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

- Colours, spacing, radii and type sizes come from the tokens in `Client/src/styles/tokens.css`. Text on an accent fill is `var(--on-accent)`, the accent used as text is `var(--accent-text)`, and a focus indicator is `var(--focus-ring)`, never `var(--accent)`.
- `src/styles/app.css` is an `@import` manifest over `src/styles/app/*.css`, and its import order is the cascade: add rules to the owning fragment, and never reorder imports or move rules between fragments in a visual PR.
- User-generated content renders via `textContent`/`setText`, never `innerHTML`. URLs pass `isSafeUrl` (`src/components/message-list/attachments.ts`), which accepts only `http:` and `https:`.
- A UI PR runs the shared accessibility checks in `Client/tests/e2e/support/b9-accessibility.ts` against its own journey.

## Security rules

- Report vulnerabilities through [GitHub Security Advisories](https://github.com/J3vb/OwnCord/security/advisories/new), **never** a public issue, pull request or discussion. This repository is public: a commit message, PR description, changelog entry or branch name is a disclosure channel, so never describe an unfixed weakness in one. Public artifacts carry only an opaque identifier, the affected property, safe acceptance criteria and a status, never reproduction steps or exploit conditions.
- Never put a password, token, TOTP secret, private key or message body in a log line, an audit-log detail or a commit. Never widen what reaches the webview: it holds the session token and the voice-E2EE identity key by design, but the remembered password stays Rust-side and never returns over IPC.
- Validate input at every trust boundary, and verify authorization server-side through the owning permission predicate. Never trust a client-side check or a client-supplied role.
- Never weaken a test-locked security invariant: the authorization chokepoint inventory, the audit-safety assertions, the E2EE staleness and verification guards, the log redaction helpers.
- Details: [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

## Commands

From the repository root. `node scripts/run.mjs --list` prints the exact command each task runs, and in which directory.

| Command                     | What it runs                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run bootstrap`         | `npm ci` in the root, `Client/` and `tools/mcp-introspect/`                                                                 |
| `npm run hooks:install`     | Once per clone: points `core.hooksPath` at `.githooks/` (`pre-commit`, `pre-push`)                                          |
| `npm run check`             | All five stacks below                                                                                                       |
| `npm run check:server`      | Four Go build-tag variants, vet, `-race` tests, the whole-tree `-tags deadlock` pass, golangci-lint, generated-output drift |
| `npm run check:client`      | Typecheck, lint, knip, coverage-gated tests, bundle budgets                                                                 |
| `npm run check:rust`        | `cargo fmt --check`, `cargo test --lib`, clippy                                                                             |
| `npm run check:docs`        | Doc counts and citations, migration immutability, the findings-ledger render                                                |
| `npm run check:hygiene`     | Prettier, shellcheck, actionlint, and the workflow, release and Node-policy guards                                          |
| `npm run generate`          | Protocol constants, the sqlc layer and the `gendocs` blocks (see [Boundaries](#boundaries))                                 |
| `npm run format`            | Prettier over the whole repository, `gofmt -w` over `Server/`, `cargo fmt --all` over the Tauri backend                     |
| `npm run release:preflight` | `check` plus a client production build                                                                                      |

`npm run check` is the local mirror of CI's static, unit and drift gates. It does **not** run the Playwright jobs, govulncheck, npm audit, the coverage-floor scripts, `typecheck:e2e`, or the tag-gated Go tests below. A step whose tool is not on PATH (golangci-lint, sqlc, shellcheck, actionlint, gofmt) prints `--- SKIP` and the run still reports passed. Server and client checks are independent, except across the contract paths listed in `scripts/ci-select.mjs` (`SERVER_READS_OUTSIDE`, `CLIENT_READS_OUTSIDE`). For example, a change to `protocol/schema.json`, anything under `Server/admin/static/` or a regenerated `docs/api.md` needs both.

Client (from `Client/`):

```bash
npm run dev                  # Vite dev server for the desktop webview
npm run build                # typecheck (tsconfig.build.json) + production build
npm test                     # jsdom vitest: tests/unit, integration, contract + colocated src/**/*.test.ts
npm run test:browser         # tests/browser (real browser APIs), excluded from `npm test`
npm run test:unit            # tests/unit only (NOT the colocated src/**/*.test.ts files)
npx vitest run tests/unit/example.test.ts   # one file
npm run typecheck            # app and unit tests
npm run typecheck:e2e        # tests/e2e: excluded from `typecheck`, checked separately in CI
npm run lint                 # oxlint (warnings denied) + import cycles + ESLint
npm run test:e2e             # Playwright against mocked Tauri
npx playwright test tests/e2e/example.spec.ts   # one spec
npm run test:e2e:native      # Windows only; needs a built exe, and binaries are built in CI only
```

Server (from `Server/`):

```bash
go test -race ./...                               # every package
go test -race -count=1 -run '^TestName$' ./ws/    # one test; -run exits 0 when nothing matches, so check the output names it
go test -tags deadlock -count=1 ./...             # the deadlock pass CI runs over the whole tree
go test -tags wazero -count=1 ./plugin/...        # tag-gated legs CI runs; the build variants only compile them
go test -tags otel -count=1 ./telemetry/... ./api/...
golangci-lint run
```

Rust (from `Client/src-tauri/`): `cargo fmt --all -- --check`, `cargo test --lib`, `cargo clippy --all-targets -- -D warnings`. A Linux Rust build first needs, in each shell, `eval "$(Client/scripts/linux-webrtc-toolchain.sh)"` run from the repository root (from `Client/src-tauri/` the path is `../scripts/linux-webrtc-toolchain.sh`). It uses `CC`/`CXX` or an installed clang >= 21, installs clang-21 from apt.llvm.org only on Debian/Ubuntu (elsewhere, install clang >= 21 yourself), and fetches a pinned libwebrtc. Windows and server-only work need none of this ([Client/CLAUDE.md](Client/CLAUDE.md)).

`Server/Makefile` wraps the generators (`sqlc-generate`, `protocol-generate`, `docs-generate`) and their `*-verify` twins, but `make` is not on a stock Windows PATH. Every `*-verify` target is its generator followed by `git diff --exit-code` on the generated paths.

### Optional tools

None is required to build or test. The last four are also CI checks, and each fails closed on a new finding: actionlint runs on every PR (Repository Hygiene); zizmor runs when `.github/**`, `scripts/**` or another shared CI input changes; osv-scanner and cargo-deny run when a manifest, a lockfile, `osv-scanner.toml` or `Client/src-tauri/deny.toml` changes. Run the matching one locally before pushing that kind of change.

| Tool               | Reach for it when                                                        |
| ------------------ | ------------------------------------------------------------------------ |
| `ast-grep`         | searching or rewriting a structural pattern across TS/Go/Rust            |
| `gotestsum`        | a failing Go run where you want the failures, not the wall of `ok` lines |
| `lk` (livekit-cli) | checking voice/video without a browser                                   |
| `ctx7`             | looking up current library docs rather than trusting memory              |
| `osv-scanner`      | after moving any lockfile (`Server/go.mod`, npm, Cargo)                  |
| `cargo-deny`       | after changing `Client/src-tauri/Cargo.toml` or `Cargo.lock`             |
| `zizmor`           | after editing anything under `.github/workflows/`                        |
| `actionlint`       | after editing a workflow                                                 |

Install commands for each are in [CLAUDE.md](CLAUDE.md#tools-for-agents). ast-grep, lk, zizmor and actionlint are listed there as `brew install`; on Windows, install those from their GitHub release binaries. CI pins each linter's version in `ci.yml`.

## Boundaries

Do not change these without explicit approval.

### Generated code: never hand-edit

CI fails on drift, and the next generator run silently discards a hand edit. `npm run generate` regenerates the first three rows, but prints `--- SKIP` and leaves `Server/db/dbgen/` stale when `sqlc` is not on PATH. Run each generator from `Server/`.

| Generated                                                                             | Source of truth                                                            | Generator                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Server/db/dbgen/`                                                                    | `Server/db/queries/sqlite/*.sql`, `Server/migrations/`                     | `sqlc generate` (version pinned in `Server/sqlc.version`: `go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(cat sqlc.version)`) |
| `Server/ws/message_types.go` **and** `Client/src/lib/protocolTypes.ts` (commit both)  | `protocol/schema.json`                                                     | `go run ./cmd/genprotocol`                                                                                                    |
| `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md` | `Server/api/router.go`, `Server/migrations/`, `Server/config/config.go`    | `go run -tags otel,wazero ./cmd/gendocs`                                                                                      |
| `dbinventory` block in `docs/architecture/server-boundaries.md`                       | `DBImportAllow` in `Server/invariants/db_import_boundary.go`, and the tree | `go run ./cmd/dbinventory`, pasted between the `dbinventory:start`/`end` markers                                              |

### Tests and coverage

- Never make a failing test pass by weakening its assertions; the client unit suite is green and must stay green.
- Never lower a coverage threshold or floor to make a change fit (`Server/coverage-floor.json`, `Client/coverage-floor.json`, `Client/vitest.config.ts`).

### Other boundaries

- A migration that has shipped is immutable; write a new migration instead. A new one is numbered one past the highest on `dev`. `scripts/check-migrations.mjs` enforces both; see [DATABASE.md](DATABASE.md#migrations-and-rollback).
- The `DBImportAllow` and `AuthzResidueAllow` inventories in `Server/invariants/` only shrink. Put new persistence behind a service, and new authorization behind a permission predicate, rather than adding a row.
- Never run `npm run tauri build` locally; the full desktop installer build is CI-only (the `tauri-build` job, on PRs to `main`). `cargo build --example native_voice_interop` (the native-voice interop proof) is fine.
- `.superpowers/findings-ledger.json` is the bug-hunt ledger and its only tracked copy. `FINDINGS.md` is generated (`node .superpowers/render-ledger.mjs`, gitignored): edit the ledger, never the rendering. Statuses are `open`, `fixed`, `declined`, `refuted`, `duplicate`, `blocked`; `severity` is `critical`, `high`, `medium` or `low`.

## Sources

- [CLAUDE.md](CLAUDE.md), [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md)
- [README.md](README.md), [docs/contributing.md](docs/contributing.md), [docs/security.md](docs/security.md)
- [package.json](package.json), [Client/package.json](Client/package.json), [scripts/run.mjs](scripts/run.mjs), [scripts/ci-select.mjs](scripts/ci-select.mjs), [scripts/check-migrations.mjs](scripts/check-migrations.mjs)
- [.github/workflows/ci.yml](.github/workflows/ci.yml), [Server/Makefile](Server/Makefile), [Server/sqlc.yaml](Server/sqlc.yaml)
- [Server/invariants/syncutil_locks.go](Server/invariants/syncutil_locks.go), [Server/invariants/db_import_boundary.go](Server/invariants/db_import_boundary.go), [docs/architecture/server-boundaries.md](docs/architecture/server-boundaries.md)
- [Client/src/components/message-list/attachments.ts](Client/src/components/message-list/attachments.ts), [Client/playwright.config.native.ts](Client/playwright.config.native.ts), [Client/vitest.config.ts](Client/vitest.config.ts), [Client/scripts/linux-webrtc-toolchain.sh](Client/scripts/linux-webrtc-toolchain.sh), [Client/src-tauri/rust-toolchain.toml](Client/src-tauri/rust-toolchain.toml)
- [.claude/skills/ci-check/SKILL.md](.claude/skills/ci-check/SKILL.md), [.claude/skills/db-change/SKILL.md](.claude/skills/db-change/SKILL.md), [.claude/skills/protocol-change/SKILL.md](.claude/skills/protocol-change/SKILL.md)
