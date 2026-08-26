# Contributing

How to set up the development environment and contribute to OwnCord.

## Development Setup

### Prerequisites

| Platform        | Server | Client       |
| --------------- | ------ | ------------ |
| Windows 10+ x64 | ✅     | ✅           |
| Linux x64       | ✅     | ✅           |
| Linux ARM64     | ✅     | ✅ (CI only) |

- **Go 1.26+** (server)
- **Node.js 24+** (client) — pinned in `Client/.nvmrc`; `engine-strict` makes a
  wrong major a hard failure, not a warning
- **Rust / Cargo** (Tauri client — not needed for server-only work)
- **Docker + Compose v2** (optional — alternative to building the server locally)

### Available Commands

#### Root facade — one entry point

From the repository root. These orchestrate the per-stack commands below; they
are a convenience, not a replacement. Nothing here needs `make`, and everything
works the same on Windows, macOS and Linux.

| Command                       | Description                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `npm run bootstrap`           | `npm ci` in all three package roots                                             |
| `npm run check`               | Everything CI gates on: server, client, Rust                                    |
| `npm run check:server`        | Server only — build variants, vet, race, deadlock, lint, generated-output drift |
| `npm run check:client`        | Client only — typecheck, lint, format, unit + integration tests                 |
| `npm run check:rust`          | Tauri backend — `cargo test --lib` and clippy                                   |
| `npm run check:docs`          | Fail if a watched document states a finding count the ledger contradicts        |
| `npm run format`              | Prettier over the client, `gofmt -w` over the server                            |
| `npm run generate`            | Regenerate protocol constants and the sqlc query layer                          |
| `npm run release:preflight`   | `check` plus a client production build                                          |
| `node scripts/run.mjs --list` | Print the exact command every task runs, and where                              |

Tools CI installs but you may not have — `golangci-lint`, `sqlc` — are skipped
with a printed reason rather than failing the run.

**Working on the server only? You never need Node.** The facade prints each
command it runs and the directory it runs it in; those are the commands in the
next section, and using them directly is equally correct.

#### Server (Go)

| Command                                                   | Description                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `go build -o chatserver.exe -ldflags "-s -w" .`           | Build server binary (Windows)                                            |
| `CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w" .` | Build server binary (Linux)                                              |
| `go build -tags otel .`                                   | Build with OpenTelemetry SDK (requires `go get` first — see Phase B)     |
| `go build -tags wazero .`                                 | Build with Wazero plugin runtime (requires `go get` first — see Phase C) |
| `go test ./...`                                           | Run all server tests                                                     |
| `go test ./... -cover`                                    | Run server tests with coverage                                           |
| `go test -race ./...`                                     | Run server tests with race detection                                     |

**Make targets** (run from `Server/`):

| Command                  | Description                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `make test`              | Run the test suite the way CI does (`-race`, 20 min timeout)                        |
| `make test-deadlock`     | Run the deadlock-detection pass CI also runs (`-tags deadlock`)                     |
| `make cover`             | Per-package coverage (what CI uploads) + a function summary                         |
| `make cover-all`         | Cross-package coverage — the honest number (also lists 0.0% functions)              |
| `make sqlc-install`      | Install the pinned sqlc version into `$GOBIN`                                       |
| `make sqlc-generate`     | Regenerate the type-safe Go query layer (`db/dbgen/`, SQLite engine)                |
| `make sqlc-verify`       | Fail if the committed `dbgen` output is stale (used by CI)                          |
| `make protocol-generate` | Regenerate the WS message-type constants (Go + TS) from `docs/protocol-schema.json` |
| `make protocol-verify`   | Fail if the committed protocol constants are stale (used by CI)                     |
| `make otel-up`           | Start Jaeger (traces) + Prometheus (metrics) via Docker for local OTel development  |
| `make otel-down`         | Stop and remove the OTel dev containers                                             |

#### Client (Tauri v2)

**Build & dev**

| Command               | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `npm run dev`         | Start Vite dev server with hot reload                            |
| `npm run build`       | TypeScript check + Vite production build                         |
| `npm run tauri dev`   | Launch Tauri app in dev mode                                     |
| `npm run tauri build` | Build release installer (NSIS on Windows, AppImage+deb on Linux) |

**Tests**

| Command                    | Description                            |
| -------------------------- | -------------------------------------- |
| `npm test`                 | Run all tests (vitest)                 |
| `npm run test:unit`        | Unit tests only                        |
| `npm run test:integration` | Integration tests only                 |
| `npm run test:e2e`         | Playwright E2E (mocked Tauri)          |
| `npm run test:e2e:native`  | Playwright E2E (real Tauri exe + CDP)  |
| `npm run test:e2e:prod`    | Playwright E2E (prod build)            |
| `npm run test:e2e:ui`      | Playwright UI mode                     |
| `npm run test:watch`       | Vitest watch mode                      |
| `npm run test:coverage`    | Coverage report                        |
| `npm run test:mutate`      | Stryker mutation testing               |
| `npm run test:mutate:dry`  | Stryker dry-run (no mutations applied) |
| `npm run test:browser`     | Vitest browser-mode tests              |

**Type checking, linting & formatting**

| Command                   | Description                           |
| ------------------------- | ------------------------------------- |
| `npm run typecheck`       | Full typecheck (all sources)          |
| `npm run typecheck:build` | Typecheck build config only           |
| `npm run lint`            | oxlint + ESLint check (src/)          |
| `npm run lint:fix`        | ESLint auto-fix                       |
| `npm run lint:ox`         | oxlint only (fast correctness checks) |
| `npm run format`          | Prettier format (src/ + tests/)       |
| `npm run format:check`    | Prettier check only (no writes)       |
| `npm run knip`            | Dead code and unused export detection |

### Git hooks (recommended)

Committed hooks in `.githooks/` catch the most common CI failures locally. Enable once per clone (from the repo root):

```bash
npm run hooks:install    # = git config core.hooksPath .githooks
```

| Hook         | What it runs                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | gofmt + `go vet` (when Go files staged), oxlint + prettier + `tsc --noEmit` (when client TS staged), `sqlc-verify` / `protocol-verify` (when their inputs staged) |
| `pre-push`   | Server build in all build-tag variants, client typecheck + type-aware ESLint. Set `OWNCORD_PREPUSH_TESTS=1` to also run `go test -race ./...`                     |

Bypass with `--no-verify` or `OWNCORD_SKIP_HOOKS=1` when needed — CI still enforces everything.

Neither hook needs `make`, and neither needs Node for the Go checks.

**`core.hooksPath` is exclusive.** Once set, Git resolves every hook against
`.githooks/` and never looks in `.git/hooks/` again. `.githooks/` holds only
`pre-commit` and `pre-push`, so `hooks:install` silently disables any other
hook you installed there (`post-commit`, `post-checkout`, ...). Nothing warns
you. Put it under `.githooks/` instead (untracked, so it stays yours), or skip
`hooks:install` and use `npm run check` before pushing.

## Plugin Development

Plugins are WASM modules loaded at runtime when the server is built with `-tags wazero`.
See `Server/plugin/examples/hello/README.md` for the full plugin ABI and build instructions.

**Toolchain requirements for building `.wasm` plugins with TinyGo:**

| Tool     | Version      | Notes                                                                                               |
| -------- | ------------ | --------------------------------------------------------------------------------------------------- |
| TinyGo   | 0.40.1       | Supports Go 1.19–1.25 only                                                                          |
| Go SDK   | 1.25.x       | Install alongside the system Go via `go install golang.org/dl/go1.25.3@latest && go1.25.3 download` |
| wasm-opt | Binaryen 129 | Required by TinyGo for the `wasi` target; download from Binaryen GitHub releases                    |

Any WASM toolchain (Rust/`wasm32-wasi`, AssemblyScript, etc.) that exports the five ABI
functions is equally valid — TinyGo is just the example toolchain used by `examples/hello/`.

---

## Branch and PR model

This section is the single source of truth for the branch model. Everywhere
else -- the root `README.md`, `CLAUDE.md`, the PR template -- summarises it and
links here rather than restating it.

- `dev` -- the integration branch. **All contributions target `dev`.**
- `main` -- releases only. `dev` is merged to `main` for a release, and release
  tags are cut from `main`.

`dev` is protected and PR-only: direct pushes are rejected, ten status checks
are required, `required_approving_review_count` is 0, and the rule is enforced
on admins. So a PR is self-mergeable once CI is green, but no commit reaches
`dev` without CI having run on it. Settings and rationale live in
[`docs/plans/b0-dev-branch-protection.sh`](plans/b0-dev-branch-protection.sh).

Two consequences worth knowing before you open a PR:

- The Docker and Tauri Full Build jobs are gated on `main` and report as
  _skipped_ on a PR into `dev`. That is expected, not a failure.
- Squash merge, and a conventional commit subject on the squashed commit.

## Branch Naming

- `feature/<name>` -- new features
- `fix/<name>` -- bug fixes
- `docs/<name>` -- documentation changes

## Commit Format

Use conventional commits:

```text
feat: add thread support to channels
fix: prevent duplicate WebSocket connections
refactor: extract permission checks into middleware
docs: update quick-start guide
test: add integration tests for invite flow
chore: bump Go dependencies
perf: cache role permissions in memory
ci: add lint step to GitHub Actions
```

## Pull Request Process

See [Branch and PR model](#branch-and-pr-model) above for what to branch from
and target.

1. Branch from `dev`
2. Open the PR against `dev`
3. All ten required checks must pass -- `dev` is protected, so a red PR cannot
   merge
4. Request code review
5. Squash merge, conventional commit subject

## Testing

The client suite enforces **70% coverage thresholds** in `vitest.config.ts`;
the Go suite has deliberately no floor (T-2026-07-25-19) — use `make cover-all`
to see the honest cross-package number. Follow a test-driven workflow and never
lower a threshold to make a change fit.

## Code Style

- **TypeScript**: See [Client Architecture](architecture/client.md)
- **Go**: `gofmt` + `golangci-lint`, standard library preferred
- **Rust**: `cargo fmt` + `cargo clippy`, minimal code (native APIs only)

## Dependency Policy

The policy behind what the lockfiles already enforce (decided 2026-08-05,
closing audit findings 2026-04-07 #8 / DC-11):

- **Lockfiles are authoritative.** `package-lock.json`, `go.sum` and
  `Cargo.lock` pin every transitive dependency; CI installs only from them
  (`npm ci`, module/registry verification — never a bare `npm install` in CI
  or hooks). `package.json` keeps ordinary caret ranges: exact-pinning it
  would duplicate what the lockfile does while making every security patch a
  manual edit.
- **Upgrades arrive as reviewed PRs, not ambient drift.** Dependabot runs
  weekly per ecosystem (`.github/dependabot.yml`) with semver-major updates
  ignored across the board — majors are adopted deliberately, by a human,
  reading the changelog. Peer-coupled groups (`vitest`/`@vitest/*`,
  `@stryker-mutator/*`) update as one PR so exact peer pins cannot wedge.
- **Security gates run on every PR:** `npm audit --omit=dev
--audit-level=high` (shipped deps only — dev-tooling advisories are
  triaged in the workflow comment instead of blocking on unfixable pins),
  `govulncheck` for Go, `cargo audit` for Rust, and `knip` refuses unused
  client dependencies outright.
- **Version skew is pinned at the toolchain level** too: `Client/.nvmrc`, every
  `actions/setup-node` in CI, and an `engines` block in all three
  `package.json` files say Node 24 — with `engine-strict=true` in each
  package's `.npmrc`, so a wrong major fails the install instead of warning.
  `Server/sqlc.version` pins sqlc, Go pins via `go.mod` (`GOTOOLCHAIN=auto`),
  and GitHub Actions are SHA-pinned with Dependabot bumping the pins.
