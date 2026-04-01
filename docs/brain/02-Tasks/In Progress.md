# In Progress

Tasks currently being worked on.

## Active

*No tasks currently in progress.*

## Completed This Session (2026-04-01)

- [x] **T-438:** Install & configure mutation testing tools (Stryker + go-gremlins)
  - Stryker config at `Client/tauri-client/stryker.config.mjs`
  - go-gremlins config at `Server/.gremlins.yaml`
  - npm scripts: `test:mutate`, `test:mutate:dry`
  - Added to TESTING-STRATEGY.md Section 15
- [x] **T-439:** Install & configure k6 WebSocket load testing
  - Script at `Server/scripts/k6/ws-load.js`
  - Added to CLAUDE.md build commands
- [x] **T-440:** Install & configure toxiproxy chaos testing
  - Script at `Server/scripts/toxiproxy/chaos-test.sh`
  - Added to CLAUDE.md build commands
- [x] **T-441:** Install & configure Coraza WAF (OWASP CRS middleware)
  - Config fields: `server.waf_enabled`, `server.waf_paranoia_level`
  - Code at `Server/api/waf.go` (opt-in via config)
  - Added to Server-Configuration.md
- [x] **T-442:** Add Zod runtime schema validation
  - Installed via npm, already in package.json
- [x] **T-443:** Fix IPv6 loopback detection in livekitSession.ts
  - `::1` loopback now handled correctly in `resolveLiveKitUrl`
- [x] **T-444:** Fix Go migration split statements for CREATE TRIGGER
  - `splitStatements` now handles multi-line `BEGIN...END` blocks
- [x] **T-445:** Resolve all 57 oxlint warnings → 0
  - `.sort()` → `.toSorted()`
  - `.reverse()` → `.toReversed()`
  - Event listener fixes, no-await-in-loop fixes, etc.
- [x] **T-446:** Add 182 new tests (2,962 → 3,144 total)
  - Key files: ws.ts, notifications.ts, audioPipeline.ts, livekitSession.ts
- [x] **T-447:** Documentation updates for all new tools
  - Updated CLAUDE.md with new commands
  - Created Testing-Tools.md guide
  - Updated TESTING-STRATEGY.md with mutation section
  - Updated Server-Configuration.md with WAF config

## Queued (Not Yet Started)

### Test Coverage Session 1 (remaining)
- API upgrades: auth_handler, channel_handler, dm_handler, invite_handler, upload_handler, middleware, contract edge cases
- Auth upgrades: password, ratelimit, session, totp, tls edge cases
- DB missing: invite_queries_test.go, role_queries_test.go
- DB upgrades: message_queries, channel_queries, dm_queries, migrate
- Config upgrades: env overrides, malformed YAML
