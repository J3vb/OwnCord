# Contributing

## Development Setup

See **SETUP.md** for tooling requirements and
**CLAUDE.md** for build commands.

## Active Branches

- `main` -- stable releases
- `tauri-migration` -- active development

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

1. Branch from `tauri-migration`
2. CI must pass (build + test + lint)
3. Request code review
4. Squash merge preferred

## Testing

Target **80%+ coverage**. Follow TDD workflow.
See **TESTING-STRATEGY.md** for full details and
**CLAUDE.md** for test commands.

## Code Style

- **TypeScript**: See CLIENT-ARCHITECTURE.md
- **Go**: `gofmt` + `golangci-lint`, standard
  library preferred
- **Rust**: `cargo fmt` + `cargo clippy`, minimal
  code (native APIs only)
