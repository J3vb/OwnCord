# Phase B + C — Local Follow-up TODO

This file enumerates everything from `phase-b-acceleration.md` and
`phase-c-differentiation.md` that **could not be completed inside the
sandboxed Claude session** because the work requires:

- network access to fetch new modules / npm packages,
- a Go toolchain matching `go.mod`'s `go 1.25.0` directive,
- a WASM toolchain (TinyGo / Rust / AssemblyScript),
- a real machine that can run `npm install`, `cargo`, `tauri`, etc.

The session **branch is `claude/plan-phases-b-c-bGpoS`**. Everything below
must be run on a developer machine (or CI) before the branch is mergeable.

The session-resident plan that was actually executed lives in
`/root/.claude/plans/woolly-wiggling-wolf.md` (not in this repo).

---

## Verification (do first — confirms the in-session work compiles)

- [ ] `cd Server && go build ./...` — The repo's `go.mod` requires
      Go 1.25.0; the sandbox only had 1.24.7, so `go build` and `go vet`
      could not be run. Manual file-by-file audit found no errors, but a
      compile is the source of truth.
- [ ] `cd Server && go test ./store/... ./ws/... ./plugin/... ./telemetry/...`
      — Exercises the new EventStore, EventPersister, telemetry no-op
      provider, and plugin manifest/loader tests.
- [ ] `cd Server && go vet ./...`
- [ ] `cd Client/tauri-client && npm install && npm run lint && npm run build`
      — Pulls in `solid-js`, `vite-plugin-solid`, and
      `@solidjs/testing-library` (added to `package.json`); confirms the
      Solid pipeline compiles inside the existing Vite + TS setup.
- [ ] `cd Client/tauri-client && npm run test` — runs the new
      `Badge.test.tsx` smoke test.

---

## Phase B Step 6 — Solid.js migration (rest of the components)

The session landed:
- Vite + TS toolchain wiring (`vite.config.ts`, `tsconfig.json`)
- `solid-js` + `vite-plugin-solid` + `@solidjs/testing-library` in
  `package.json`
- `src/lib/solidAdapter.ts` (wraps custom stores as Solid signals)
- `src/lib/solidMount.ts` (`{mount, destroy}` adapter for Solid roots)
- `src/components/solid/Badge.tsx` — first leaf
- `src/components/solid/ChannelListItem.tsx` — store-subscribed leaf
- `src/components/solid/Badge.test.tsx` — pipeline smoke test
- `src/components/solid/README.md` — migration recipe

Still TODO locally:

- [ ] Run `npm install` and verify the build passes (sandbox had no
      network).
- [ ] Migrate the remaining leaf components in
      `src/components/` one PR at a time, following the recipe in
      `src/components/solid/README.md`. Suggested order: presence pills,
      typing indicators, message attachments, voice volume meters, then
      containers (channel list, member list, message list).
- [ ] Once every leaf is migrated, replace the manual `mountSolid` calls
      in containers with native Solid components and delete the old
      vanilla DOM utilities (`createComponent`, factory shells) referenced
      from `src/components/`.
- [ ] Add a Vitest config preset under `vitest.config.ts` that pulls in
      `@solidjs/testing-library` automatically (currently the test imports
      it directly).

---

## Phase B Step 7 — Event persistence

The session landed:
- `Server/migrations/014_events_table.sql` (SQLite)
- `events` table appended to `Server/migrations/postgres/001_initial_schema.sql`
- `Server/db/queries/sqlite/events.sql`, `Server/db/queries/postgres/events.sql`
- `Server/db/persisted_event.go` — domain type
- `EventStore` sub-interface added to `Server/store/store.go`
- SQLite implementation in `Server/store/sqlite_events.go` (raw SQL via
  `*sql.DB`, no `dbgen` dependency)
- MemStore implementation in `Server/store/memstore_events.go`
- Postgres stubs returning `ErrPostgresNotImplemented`
- `Server/ws/event_persister.go` — batched async writer
- `Server/ws/event_pruner.go` — retention pruner goroutine
- Three `replayBuf.Push` call sites in `Server/ws/hub.go` now also call
  `h.persistEvent(...)`
- Tiered reconnect replay in `Server/ws/serve.go` (buffer → DB → full)
- Reconnect-tier metrics in the hub + telemetry counter
- `EventPersistenceConfig` added to `Server/config/config.go` with
  defaults `{enabled: true, retention_hours: 24, batch_size: 50,
  batch_flush_ms: 100, pruner_interval_minutes: 60}`
- `Server/main.go` wires the persister + pruner
- `Server/ws/event_persister_test.go` — batching, drop, drain tests

Still TODO locally:

- [ ] Run `make sqlc-generate` so `db/dbgen` and `db/pgdbgen` learn about
      `events.sql`. The session used raw SQL through `*sql.DB` (matching
      the existing `pgdbgen` workaround), so this is optional for SQLite
      but required for the postgres backend.
- [ ] Replace the postgres EventStore stubs in `Server/store/postgres.go`
      with real wrappers around the generated `pgdbgen` code (the same
      mechanical work tracked in `docs/phase-a-status.md` for the other
      stub methods).
- [ ] Add an integration test that pushes more than 1000 events through a
      real hub with a 1000-slot buffer, disconnects at seq=500, and asserts
      the DB tier returns the missing events. The session test
      (`event_persister_test.go`) covers the persister in isolation but
      not the buffer→DB handoff inside `handleReconnect`.
- [ ] Add a `replay_source` field to the auth_ok payload so the client
      can log the tier. The hub already records the tier in metrics; the
      client surface change is a separate UX call.
- [ ] Document the new `event_persistence` block in `defaultYAML` inside
      `Server/config/config.go` (the struct and defaults landed; the
      sample config comments did not).

---

## Phase B Step 8 — OpenTelemetry

The session landed:
- `Server/telemetry/telemetry.go` — public API + no-op provider
- `Server/telemetry/telemetry_default.go` — default-build `Init`
- `Server/telemetry/telemetry_otel.go` — wazero/postgres-style build-tag
  skeleton (build with `-tags otel`); compiles only when the OTel modules
  are in `go.mod` and is currently a structural placeholder
- `Server/telemetry/metrics.go` — `AppMetrics` bundle
- `Server/telemetry/middleware.go` — `HTTPMiddleware` + `PrometheusHandler`
- `Server/telemetry/telemetry_test.go`
- `Server/api/router.go` mounts `telemetry.HTTPMiddleware()`
  unconditionally and the Prometheus exporter when non-nil
- `Server/main.go` calls `telemetry.Init` early and defers `Shutdown`
- `TelemetryConfig` added to `Server/config/config.go`
- Spans added to `MessageService.SendMessage`,
  `PermissionService.HasChannelPerm`,
  `ChannelService.ListVisibleChannels`
- Reconnect-tier counter wired into `WSReconnectTierTotal` from
  `Server/ws/serve.go`

Still TODO locally:

- [ ] Add the OTel modules to `go.mod`:
  ```sh
  cd Server
  go get go.opentelemetry.io/otel@latest \
         go.opentelemetry.io/otel/sdk@latest \
         go.opentelemetry.io/otel/exporters/prometheus@latest \
         go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@latest \
         go.opentelemetry.io/contrib/instrumentation/github.com/go-chi/chi/v5/otelchi@latest
  go mod tidy
  ```
- [ ] Replace the placeholder body of `telemetry/telemetry_otel.go`'s
      `Init` with the real tracer + meter provider construction and the
      `otelchi.Middleware` wiring (see the inline TODO comment with the
      call graph).
- [ ] Build with `-tags otel` once the SDK is in `go.mod` and add a CI
      job that exercises the tagged build.
- [ ] Add spans to the remaining service-layer entry points
      (`DMService`, `VoiceService`, `InviteService`, `ModerationService`,
      `BlockService`, `UserService`). The pattern is identical to the
      three already done in this branch.
- [ ] Document the new `telemetry` block in `defaultYAML` inside
      `Server/config/config.go`.
- [ ] Add a `make otel-up` target that spins up Jaeger via
      docker-compose for local tracing development.

---

## Phase C Step 9 — Wazero plugin runtime

The session landed:
- `Server/plugin/manifest.go` — JSON manifest parser + capability checks
- `Server/plugin/loader.go` — directory scan + entrypoint validation
- `Server/plugin/registry.go` — registry + lifecycle (install/enable/uninstall)
- `Server/plugin/host_commands.go`, `host_storage.go`, `host_events.go`,
  `host_http.go`, `host_ui.go` — capability surfaces
- `Server/plugin/sandbox_default.go` — no-op runtime (default build)
- `Server/plugin/sandbox_wazero.go` — `-tags wazero` skeleton
- `Server/plugin/errors.go`
- `Server/plugin/plugin_test.go`
- `Server/plugin/examples/hello/plugin.json` + `README.md`
- `Server/migrations/015_plugins.sql` (SQLite)
- `plugins` + `plugin_kv` tables appended to the postgres schema
- `Server/db/queries/sqlite/plugins.sql`,
  `Server/db/queries/postgres/plugins.sql`
- `PluginStore` sub-interface in `Server/store/store.go` with SQLite,
  MemStore, and postgres-stub implementations
- `Server/api/plugins_handler.go` — admin REST surface
- `Server/api/router.go` mounts the admin plugin handler
- `Server/main.go` constructs and starts the registry when
  `cfg.Plugins.Enabled`
- `PluginsConfig` added to `Server/config/config.go`
- `Client/tauri-client/src/lib/pluginBridge.ts` — iframe + postMessage host
- `Client/tauri-client/src/components/solid/PluginContainer.tsx` — Solid
  host component for plugin tabs

Still TODO locally:

- [ ] Add wazero to `go.mod`:
  ```sh
  cd Server
  go get github.com/tetratelabs/wazero@latest
  go mod tidy
  ```
- [ ] Replace the placeholder body in `Server/plugin/sandbox_wazero.go`
      with real wazero runtime construction. The file contains an inline
      TODO with the exact API call graph.
- [ ] Replace JSON-only manifest parsing with TOML support behind the
      `wazero` build tag (the design doc names `plugin.toml`). Add
      `github.com/BurntSushi/toml` and a `parseTOML` shim that falls back
      to the existing `ParseManifest` if no `plugin.toml` is found.
- [ ] Wire `Server/plugin/host_events.go` into the WS pub/sub hub
      (`Server/ws/pubsub.go`). The session left this as a stub because
      the registration surface needs to be designed alongside the actual
      plugin event format — the hub-side code path is straightforward
      once the format is fixed.
- [ ] Wire `Server/plugin/host_commands.go` into the WS slash-command
      dispatcher. **There is currently no slash-command dispatcher in the
      WS layer.** Either add one (small surface) or fold plugin commands
      into the REST layer first. The plugin Registry already exposes
      `DispatchCommand` so the hookup is one call site.
- [ ] Pass the live `*plugin.Registry` from `Server/main.go` into
      `NewPluginAdminHandler` (the router currently constructs the
      handler with a nil registry so list works but enable/disable returns
      503).
- [ ] Add a precompiled trivial `.wasm` blob under
      `Server/plugin/examples/hello/hello.wasm` so the example plugin can
      actually be loaded by an integration test once wazero is wired.
      Build it locally with TinyGo:
  ```sh
  cd Server/plugin/examples/hello
  tinygo build -o hello.wasm -target wasi ./main.go
  ```
- [ ] Implement plugin marketplace install path
      (`POST /api/v1/admin/plugins/install` with multipart zip). The
      handler is scaffolded but the install endpoint is currently absent.
- [ ] Replace plugin postgres stubs in `Server/store/postgres.go` with
      real `pgdbgen`-backed implementations once `make sqlc-generate`
      runs (same blocker as Phase B Step 7).
- [ ] Build the first real plugin: game detection. Pulls Steam API,
      tracks playtime, exposes `/playtime` slash command. This is the
      acceptance criterion in `phase-c-differentiation.md`.

---

## Build-tag matrix the user should set up in CI

| Tag set | What it builds | Why |
|---|---|---|
| (none) | Default sqlite-only server, no OTel SDK, no wazero | Existing path |
| `otel` | Above + OpenTelemetry SDK + Prometheus exporter | Phase B Step 8 |
| `wazero` | Above + plugin runtime executes WASM modules | Phase C Step 9 |
| `postgres` | Replaces sqlite with postgres backend | Phase A pending |
| `otel,wazero,postgres` | Full community-hub build | Production target |

Each tag is independently selectable; CI should test every combination at
least minimally so the build-tag boundaries don't drift.

---

## Things explicitly **out of scope** for this branch

(Documenting so reviewers don't expect them.)

- Migration of the entire vanilla TypeScript component tree to Solid. Two
  proof-of-concept components landed; the rest is mechanical PRs.
- Full OTel SDK wiring (only the public API + no-op default + structural
  build-tag skeleton landed).
- Real Wazero `.wasm` execution (only the registry, host APIs, and a
  build-tag skeleton landed).
- Real game-detection plugin (the manifest fields and host APIs needed to
  build it are in place).
- A reverse postgres → sqlite migration (Phase A documented this is
  deliberately unavailable; nothing changed here).
