<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~600 -->

# Testing Codemap

## Test Infrastructure Summary

| Layer | Framework | Test Files | Approx Tests | Coverage Target |
|-------|-----------|-----------|--------------|-----------------|
| Client unit | Vitest | 103 | ~2,905 | 95%+ |
| Client integration | Vitest | 1 | varies | -- |
| Client E2E (mocked) | Playwright | 20 | ~100+ | critical flows |
| Client E2E (native) | Playwright + CDP | 10 | ~50+ | real Tauri exe |
| Rust backend | cargo test | 10 (inline) | ~25 | key IPC commands |
| Go server | go test | 58 | ~400+ | 80%+ |

## Client Tests (Client/tauri-client/tests/)

### Unit Tests (103 files)
- Pattern: `tests/unit/*.test.ts`
- Framework: Vitest with jsdom
- Mocking: Tauri IPC mocked via `@tauri-apps/api` stubs
- Run: `npm test` or `npm run test:unit`
- Coverage: `npm run test:coverage` (Istanbul via Vitest)

Key test areas:
- Store tests (messages, voice, channels, members, dm, auth, ui, roles)
- Component tests (MessageList, MessageInput, VoiceWidget, Settings tabs)
- Lib tests (ws, api, dispatcher, livekitSession, audioPipeline, profiles)
- Page tests (ConnectPage, MainPage, SidebarArea)

### E2E Tests -- Mocked Tauri (20 files)
- Pattern: `tests/e2e/*.spec.ts`
- Framework: Playwright
- Environment: Vite dev server + mocked Tauri APIs
- Run: `npm run test:e2e`
- Covers: connect flow, chat, DMs, settings, overlays, message actions

### E2E Tests -- Native (10 files)
- Pattern: `tests/e2e/native/*.spec.ts`
- Framework: Playwright + WebView2 CDP
- Environment: Real Tauri exe + real Go server
- Run: `npm run test:e2e:native`
- Covers: auth, channel nav, chat ops, DMs, reconnection, themes
- Note: 60s login timeout due to server rate limiting

### Integration Tests (1 file)
- Pattern: `tests/integration/*.test.ts`

## Go Server Tests (Server/)

### Test Files: 58
- Pattern: `*_test.go` across all packages
- Run: `go test ./...` or `go test -race -cover ./...`
- Key packages with tests:
  - `ws/` -- hub, handlers, voice, reconnect, ring buffer
  - `api/` -- all handlers, middleware, router, contracts
  - `db/` -- queries, migrations, backup
  - `auth/` -- rate limiter, sessions, TOTP, TLS, password
  - `admin/` -- handlers, middleware, logstream, setup, updates
  - `config/` -- config loading

## Rust Tests (src-tauri/src/)

### Inline Tests: ~25
- Pattern: `#[cfg(test)] mod tests` in source files
- Run: `cd Client/tauri-client/src-tauri && cargo test`
- Covers: settings key allowlist validation, fingerprint format validation

## Test Commands Quick Reference
```bash
# Client
npm test                    # all vitest tests
npm run test:unit           # unit only
npm run test:coverage       # coverage report
npm run test:e2e            # mocked Playwright
npm run test:e2e:native     # real Tauri + server
npm run test:e2e:ui         # Playwright UI mode

# Server
go test ./...               # all Go tests
go test -race -cover ./...  # with race + coverage

# Rust
cd Client/tauri-client/src-tauri && cargo test
```
