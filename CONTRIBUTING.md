# Contributing

## Development Setup

- **Go 1.25+** for the server
- **.NET 8 SDK** for the client

Install dev tools:

```bash
go install github.com/air-verse/air@latest                                  # hot reload
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest        # linter
```

## Branch Naming

- `feature/<name>` — new features
- `fix/<name>` — bug fixes
- `docs/<name>` — documentation changes

## Commit Format

Use conventional commits:

```
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

1. Branch from `main`
2. CI must pass (build + test + lint)
3. Request code review
4. Squash merge preferred

## Test Requirements

Target **80%+ coverage**. Follow TDD workflow: write tests first, then implement.

### Server Tests

```bash
cd Server
go test ./... -cover
```

### Client Tests

```bash
dotnet test Client/OwnCord.Client.Tests/
```
