# Contributing

## Development Setup

### Server

- **Go 1.25+**

```bash
go install github.com/air-verse/air@latest
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
```

### Client (Tauri v2)

- **Node.js 20+**
- **Rust** (latest stable via rustup)
- **Visual Studio Build Tools 2022** (C++ workload)

```bash
cd Client/tauri-client
npm install
npm run tauri dev
```

## Branch Naming

- `feature/<name>` -- new features
- `fix/<name>` -- bug fixes
- `docs/<name>` -- documentation changes

## Active Branches

- `main` -- stable releases
- `dev` -- WPF client development (legacy)
- `tauri-migration` -- Tauri v2 client (active)

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

1. Branch from `tauri-migration` (for client work) or
   `dev` (for server work)
2. CI must pass (build + test + lint)
3. Request code review
4. Squash merge preferred

## Test Requirements

Target **80%+ coverage**. Follow TDD workflow: write tests
first, then implement.

### Server Tests

```bash
cd Server
go test ./... -cover
```

### Client Tests (Tauri v2)

```bash
cd Client/tauri-client
npm test                         # all tests
npm run test:unit                # unit only
npm run test:integration         # integration only
npm run test:e2e                 # E2E (Playwright)
npm run test:coverage            # with coverage
```

### Rust Tests

```bash
cd Client/tauri-client/src-tauri
cargo test
```

## Code Style

### TypeScript (Client)

- Strict mode enabled
- Immutable state updates (never mutate)
- No `any` types
- Path aliases: `@lib/`, `@stores/`, `@components/`

### Go (Server)

- `gofmt` + `golangci-lint`
- Standard library preferred
- `log/slog` for logging

### Rust (Tauri backend)

- `cargo fmt` + `cargo clippy`
- All FFI wrapped in `Result`
- Minimal code: only native APIs the webview can't access
