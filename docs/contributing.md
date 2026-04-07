# Contributing

How to set up the development environment and contribute to OwnCord.

## Development Setup

### Prerequisites

| Platform | Server | Client |
|----------|--------|--------|
| Windows 10+ x64 | ✅ | ✅ |
| Linux x64 | ✅ | ✅ |
| Linux ARM64 | ✅ | ✅ (CI only) |

- **Go 1.25+** (server)
- **Node.js 20+** (client)
- **Rust / Cargo** (Tauri client — not needed for server-only work)
- **Docker + Compose v2** (optional — alternative to building the server locally)

### Available Commands

#### Server (Go)

| Command | Description |
|---------|-------------|
| `go build -o chatserver.exe -ldflags "-s -w" .` | Build server binary (Windows) |
| `CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w" .` | Build server binary (Linux) |
| `go build -tags otel .` | Build with OpenTelemetry SDK (requires `go get` first — see Phase B) |
| `go build -tags wazero .` | Build with Wazero plugin runtime (requires `go get` first — see Phase C) |
| `go build -tags postgres .` | Build with PostgreSQL backend (requires pgx in go.mod) |
| `go test ./...` | Run all server tests |
| `go test ./... -cover` | Run server tests with coverage |
| `go test -race ./...` | Run server tests with race detection |

**Make targets** (run from `Server/`):

| Command | Description |
|---------|-------------|
| `make sqlc-install` | Install the pinned sqlc version into `$GOBIN` |
| `make sqlc-generate` | Regenerate type-safe Go for both SQLite (`db/dbgen/`) and PostgreSQL (`db/pgdbgen/`) engines |
| `make sqlc-verify` | Fail if committed `dbgen` / `pgdbgen` output is stale (used by CI) |
| `make otel-up` | Start Jaeger (traces) + Prometheus (metrics) via Docker for local OTel development |
| `make otel-down` | Stop and remove the OTel dev containers |

#### Client (Tauri v2)

**Build & dev**

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with hot reload |
| `npm run build` | TypeScript check + Vite production build |
| `npm run tauri dev` | Launch Tauri app in dev mode |
| `npm run tauri build` | Build release installer (NSIS on Windows, AppImage+deb on Linux) |

**Tests**

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests (vitest) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:e2e` | Playwright E2E (mocked Tauri) |
| `npm run test:e2e:native` | Playwright E2E (real Tauri exe + CDP) |
| `npm run test:e2e:prod` | Playwright E2E (prod build) |
| `npm run test:e2e:ui` | Playwright UI mode |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run test:mutate` | Stryker mutation testing |
| `npm run test:mutate:dry` | Stryker dry-run (no mutations applied) |
| `npm run test:browser` | Vitest browser-mode tests |

**Type checking, linting & formatting**

| Command | Description |
|---------|-------------|
| `npm run typecheck` | Full typecheck (all sources) |
| `npm run typecheck:build` | Typecheck build config only |
| `npm run lint` | oxlint + ESLint check (src/) |
| `npm run lint:fix` | ESLint auto-fix |
| `npm run lint:ox` | oxlint only (fast correctness checks) |
| `npm run format` | Prettier format (src/ + tests/) |
| `npm run format:check` | Prettier check only (no writes) |
| `npm run knip` | Dead code and unused export detection |

## Plugin Development

Plugins are WASM modules loaded at runtime when the server is built with `-tags wazero`.
See `Server/plugin/examples/hello/README.md` for the full plugin ABI and build instructions.

**Toolchain requirements for building `.wasm` plugins with TinyGo:**

| Tool | Version | Notes |
|------|---------|-------|
| TinyGo | 0.40.1 | Supports Go 1.19–1.25 only |
| Go SDK | 1.25.x | Install alongside the system Go via `go install golang.org/dl/go1.25.3@latest && go1.25.3 download` |
| wasm-opt | Binaryen 129 | Required by TinyGo for the `wasi` target; download from Binaryen GitHub releases |

Any WASM toolchain (Rust/`wasm32-wasi`, AssemblyScript, etc.) that exports the five ABI
functions is equally valid — TinyGo is just the example toolchain used by `examples/hello/`.

---

## Active Branches

- `main` -- stable releases
- `dev` -- active development

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

1. Branch from `dev` (the active development branch)
2. PRs target `dev`; `main` is for stable releases only
3. CI must pass (build + test + lint)
4. Request code review
5. Squash merge preferred

## Testing

Target **80%+ coverage**. Follow test-driven development workflow.

## Code Style

- **TypeScript**: See [Client Architecture](client-architecture.md)
- **Go**: `gofmt` + `golangci-lint`, standard library preferred
- **Rust**: `cargo fmt` + `cargo clippy`, minimal code (native APIs only)
