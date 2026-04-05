# Contributing

How to set up the development environment and contribute to OwnCord.

## Development Setup

### Prerequisites

- **Windows 10+** (x64)
- **Go 1.25+** (server)
- **Node.js 20+** (client)
- **Rust / Cargo** (Tauri client)

### Available Commands

#### Server (Go)

| Command | Description |
|---------|-------------|
| `go build -o chatserver.exe -ldflags "-s -w" .` | Build server binary |
| `go test ./...` | Run all server tests |
| `go test ./... -cover` | Run server tests with coverage |
| `go test -race ./...` | Run server tests with race detection |

#### Client (Tauri v2)

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with hot reload |
| `npm run build` | TypeScript check + Vite production build |
| `npm run tauri dev` | Launch Tauri app in dev mode |
| `npm run tauri build` | Build release installer |
| `npm test` | Run all tests (vitest) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:e2e` | Playwright E2E (mocked Tauri) |
| `npm run test:e2e:native` | Playwright E2E (real Tauri exe + CDP) |
| `npm run test:e2e:prod` | Playwright E2E (prod build) |
| `npm run test:e2e:ui` | Playwright UI mode |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run typecheck` | Full typecheck (all sources) |
| `npm run typecheck:build` | Typecheck build config only |
| `npm run lint` | ESLint check (src/) |
| `npm run lint:fix` | ESLint auto-fix |

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
