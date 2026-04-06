# OwnCord — Phase A: Foundation

**Steps 1–5 | Weeks 1–7 | Community Scale Edition**

*Service Layer • Type-Safe DB • PostgreSQL Target • Logging • Pub/Sub Hub*

---

## Phase Overview

Phase A builds the server-side foundation that everything else depends on. These 5 steps transform the Go backend from a working alpha into an architecture that can carry 100+ concurrent users and 146 remaining features. Nothing in Phase B or C works well without this foundation in place.

The service layer (Step 1) is the prerequisite for the pub/sub hub (Step 5) and the DB interface (Step 3). sqlc (Step 2) feeds into Step 3. Logging consolidation (Step 4) is a quick win done in any gap. The pub/sub refactor (Step 5) was Phase B in v1 but moves up here because at community scale the iterate-and-filter broadcast model breaks down.

### Timeline

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 1 | Extract service/domain layer + permission cache | 2–3 weeks | — | No |
| 2 | Adopt sqlc | 1 week | — | Yes (with 1) |
| 3 | Abstract DB + PostgreSQL target | 2–3 weeks | Steps 1+2 | No |
| 4 | Consolidate logging | 1–2 days | — | Yes (anytime) |
| 5 | Refactor hub to pub/sub + global rate limits | 2–3 weeks | Step 1 | After Step 1 |

### Milestone Gate

**After Phase A:** The server has a clean service layer, type-safe queries, a dual-database backend, efficient pub/sub broadcasting, and consistent logging. You can start building community-scale features (roles, permissions, moderation) on a foundation that will carry them.

---

## Step 1: Extract Service / Domain Layer

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

Business logic is scattered across REST handlers (api/), WebSocket handlers (ws/), and database queries (db/). When a feature like message editing needs permission checks, content validation, slowmode enforcement, notification triggers, read state updates, and a broadcast event, that logic must exist in both the REST path and the WebSocket path. Without a central service layer, logic is duplicated, tested twice, and inevitably diverges. At community scale, this divergence becomes a source of permission bypass bugs and inconsistent behavior.

### Solution

Create a Server/service/ package containing domain services: MessageService, ChannelService, PermissionService, ModerationService, UserService. Both REST and WebSocket handlers become thin adapters that parse input, call the appropriate service method, and format the response. All business rules, validation, and side effects live in one place.

### Community Scale Considerations

At 100+ users, the service layer also becomes the natural place for connection-scoped permission caching. Rather than querying the database for permissions on every message send, the PermissionService maintains a cached permission set per user that gets invalidated on role changes or channel permission updates. This is critical for broadcast performance — the pub/sub layer (Step 5) needs fast permission lookups, not database round-trips.

### Pros & Cons

| Pros | Cons |
|------|------|
| Single source of truth for all business rules | Upfront refactoring cost across existing handlers |
| Handlers become trivial to write and review | Requires defining clear service interfaces |
| Service methods are independently unit-testable | Adds an abstraction layer (more files to navigate) |
| Eliminates logic duplication between REST and WS | Must migrate carefully to avoid breaking tests |
| Natural home for permission caching at scale | Permission cache invalidation adds complexity |
| Clean dependency injection via deps.go pattern | |

### Implementation Plan

1. Define service interfaces for each domain (MessageService, ChannelService, etc.) with methods matching the operations you need.
2. Extract existing business logic from handlers into service implementations. Start with MessageService since chat is the most active domain.
3. Add a PermissionService with an in-memory cache per user. Cache is populated on connection, invalidated on role/channel permission changes via an internal event.
4. Wire services via dependency injection through the existing deps.go pattern. Handlers receive a service instance, not a DB connection.
5. Migrate one handler domain at a time using the strangler-fig pattern already established in the V2 migration.

---

## Step 2: Adopt sqlc for Type-Safe Database Access

**Effort:** Low (1 week) | **Impact:** High | **Phase:** A — Foundation

### Problem

Every database query is hand-written Go code with manual struct mapping. Each new feature adds more queries, and each query is a chance for silent field mismatches or type errors that only surface at runtime. With PostgreSQL as a second backend (Step 3), maintaining two sets of hand-written queries would be unsustainable.

### Solution

Adopt sqlc. Write SQL queries in .sql files, run sqlc generate, get type-safe Go functions with correct structs. You keep full control over the SQL (critical for SQLite-specific features like FTS5 and permission bitfields) but get compile-time safety for free. sqlc also supports generating queries for both SQLite and PostgreSQL from the same schema, which directly enables Step 3.

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **sqlc** | SQL-first: you write SQL, it generates Go. Full control over queries, compile-time type safety, zero runtime overhead. Supports both SQLite and PostgreSQL. | **RECOMMENDED** |
| sqlx | Query builder with compile-time checking. More dynamic but less control. Heavier runtime. | VIABLE |
| GORM / Ent | Full ORM. Hides SQL behind Go structs. Fights you on complex queries, FTS5, bitfields. Performance overhead at scale. | AVOID |
| Status quo | Continue hand-writing query functions. Doesn't scale, doubles work when adding PostgreSQL. | AVOID |

### Pros & Cons (sqlc)

| Pros | Cons |
|------|------|
| Compile-time type safety for every query | Adds a code generation step to the build |
| Auto-generated structs match your schema exactly | Dynamic queries (variable WHERE clauses) need workarounds |
| You still write raw SQL — full control | Team must learn sqlc conventions and annotations |
| Zero runtime overhead (no reflection) | Some SQLite/PostgreSQL differences need separate query files |
| Supports generating for both SQLite and PostgreSQL | |
| Mechanical migration: copy existing SQL into .sql files | |

---

## Step 3: Abstract DB + PostgreSQL as First-Class Target

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

SQLite serializes all writes through a single WAL. At 100+ concurrent users generating messages, reactions, presence updates, read state changes, and typing indicators, write contention creates latency spikes. The pure-Go SQLite driver (modernc.org/sqlite) is slower than CGO alternatives, compounding this. Community hub mode requires a database that handles concurrent writes gracefully.

### Solution

Define a **store.Store** interface that the service layer calls. Implement both **SQLiteStore** (default for friend groups, zero-config) and **PostgresStore** (for community hubs, configurable in owncord.toml). SQLite remains the default. PostgreSQL is opt-in for operators who need scale.

#### PostgreSQL-Specific Requirements

- **Connection pooling:** Use pgxpool for connection management. Community hubs need 20–50 pooled connections to handle concurrent reads and writes.
- **Full-text search:** SQLite uses FTS5. PostgreSQL uses tsvector/tsquery with GIN indexes. The Store interface must abstract search so the caller doesn't know which engine is running.
- **Migrations:** Maintain parallel migration sets — one for SQLite, one for PostgreSQL. sqlc can generate query code for both from the same logical queries.
- **Config:** owncord.toml gets a database section: type = "sqlite" (default) or type = "postgres" with a connection string.

### Options (PostgreSQL Driver)

| Option | Details | Verdict |
|--------|---------|---------|
| **pgx + pgxpool** | Pure Go PostgreSQL driver. High performance, connection pooling built in, excellent type support. | **RECOMMENDED** |
| lib/pq | Older Go PostgreSQL driver. Stable but no longer actively developed. No built-in pooling. | AVOID |
| SQLite only | Skip PostgreSQL entirely. Works for friend groups but creates a hard ceiling for community hubs. | AVOID |

### Pros & Cons

| Pros | Cons |
|------|------|
| PostgreSQL handles concurrent writes natively | Two database backends to maintain and test |
| SQLite stays as zero-config default | FTS5 vs tsvector differences need careful abstraction |
| In-memory store for faster unit tests | Parallel migration sets add maintenance cost |
| Self-hosters choose the DB that fits their scale | PostgreSQL adds an external dependency for community hubs |
| pgxpool handles connection lifecycle automatically | Interface design requires upfront thought |
| Forces clean separation between queries and logic | CI must test both backends |

---

## Step 4: Consolidate to One Logging Library

**Effort:** Low (1–2 days) | **Impact:** Medium | **Phase:** A — Foundation

### Problem

The server imports both uber.org/zap and rs/zerolog. They serve the same purpose but produce different output formats, require separate configuration, and create ambiguity about which to import. At community scale, consistent log formatting matters because operators need to parse logs reliably for monitoring and alerting.

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **zerolog** | Lower allocations, simpler API, smaller binary. Fits the lean single-binary philosophy. Zero-allocation JSON output. | **RECOMMENDED** |
| zap | Larger ecosystem, more middleware integrations. Slightly higher allocation but battle-tested. | VIABLE |
| log/slog | Go standard library (1.21+). No external dependency, structured logging, pluggable backends. | VIABLE |
| Keep both | Inconsistent logs, double config, operator confusion. Unacceptable at community scale. | AVOID |

### Recommendation

**zerolog** is the recommended choice. It aligns with OwnCord's lean-binary philosophy and produces zero-allocation JSON logs. **log/slog** is a strong alternative if you want zero external logging dependencies. Either way, pick one and do a project-wide find-and-replace. This is a one-session task.

---

## Step 5: Refactor Hub to Pub/Sub Broadcast Model

> **MOVED UP FROM PHASE B** — This step was Phase B in v1. At community scale it is foundational — the iterate-and-filter broadcast model breaks down at 100+ connections.

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

The hub currently iterates all connections and checks permissions per message. At 100 users across 20 channels, that's 100 permission checks for every message in any channel — 80 of which are wasted because those users aren't in that channel. Add role-based visibility, DND suppression, notification overrides, and thread subscriptions, and every broadcast becomes a complex routing computation that scales linearly with total connections, not with relevant subscribers.

### Solution

Refactor to an internal pub/sub model. Each chat channel maps to a topic. Connections subscribe to topics based on their current permissions (fed by the PermissionService cache from Step 1). Broadcasting becomes publishing to a topic — the routing is pre-computed at subscription time, not evaluated per message.

### Community Scale Additions

- **Global rate limiting:** Add server-wide throughput caps alongside per-connection limits. A busy channel should not saturate the broadcast loop and starve other channels.
- **Backpressure handling:** When a slow client can't keep up, the pub/sub layer should drop low-priority events (typing indicators first, then presence) or force a reconnect.
- **Priority queues:** Direct mentions and DMs should have higher priority than typing indicators or presence updates. The pub/sub model should support priority tiers.

### Pros & Cons

| Pros | Cons |
|------|------|
| Broadcast cost is O(subscribers) not O(all connections) | Requires rethinking the current hub architecture |
| Permission checks happen at subscribe time, not per message | Subscription management adds complexity (stale subscriptions) |
| Natural model for threads, DMs, and announcement channels | Permission changes trigger re-subscription (must be fast) |
| Cleanly separates connection management from message routing | Priority queue implementation adds complexity |
| Enables priority tiers and backpressure handling | Testing pub/sub is more involved than testing a simple loop |
| Global rate limiting becomes straightforward per-topic | |

---

## Phase A Implementation Status

**Branch:** `claude/phase-a-foundation-plan-eUys1`

This section tracks what shipped on this branch versus what is still pending.

### Done

- **Step 1 — Service layer + permission cache.** `Server/service/` contains 12 service files covering message, channel, permission, moderation, user, dm, block, invite, voice. Services depend on `store.Store`, not `*db.DB`. PermissionService maintains a per-user cache. REST and WS handlers (auth, channel, dm, profile, upload, chat, reaction, presence, voice) are migrated. Service tests live in `service/message_test.go` and `service/permission_test.go`.
- **Step 2 — sqlc adoption.** `Server/sqlc.yaml` configures both the SQLite engine (queries in `Server/db/queries/sqlite/`, generated output in `Server/db/dbgen/`) and the PostgreSQL engine (queries in `Server/db/queries/postgres/`, output in `Server/db/pgdbgen/`). sqlc v1.30.0 is pinned in `Server/sqlc.version`. `Server/Makefile` exposes `sqlc-install`, `sqlc-generate`, `sqlc-verify` targets covering both engines. 14 SQL query files per engine cover all DB domains; the SQLite `dbgen` package is committed, the PostgreSQL `pgdbgen` package will be generated on the next `make sqlc-generate` run. FTS search queries remain hand-written; transactional multi-step operations are unchanged.
- **Step 3 (partial) — Store interface + SQLiteStore + MemStore.** `Server/store/store.go` defines the full Store interface (12 sub-interfaces). `Server/store/sqlite.go` wraps `*db.DB`. `Server/store/memstore.go` provides an in-memory implementation used by service tests.
- **Step 4 — Logging consolidation.** OwnCord code uses `log/slog` exclusively. `go.uber.org/zap` and `rs/zerolog` appear only as transitive dependencies of livekit and are not imported by any OwnCord `.go` file. The plan's "pick one and find-and-replace" item is satisfied.
- **Step 5 — Pub/sub broadcast model.** `Server/ws/pubsub.go`, `topic_rate_limiter.go`, `ringbuffer.go`, and the three-tier priority queue (commit `7ccc93f`) implement the topic-based broadcast model with global rate limits, backpressure, and priority tiers.

### Pending

- **Step 3 — PostgreSQL backend (final wiring).** Scaffolding has landed on this branch:
  - `Server/migrations/postgres/001_initial_schema.sql` — consolidated postgres schema with `tsvector` + GIN full-text search, `CITEXT` usernames, native CHECK constraints replacing SQLite triggers, and seeded role/setting rows.
  - `Server/migrations/postgres/migrations.go` — embed FS for the postgres migration set.
  - `Server/db/queries/postgres/*.sql` — 14 query files (users, sessions, roles, invites, channels, messages, reactions, voice, attachments, admin, dm, blocks, lockouts, profile) translated to postgres dialect: `$N` placeholders, `NOW()`/native `TIMESTAMPTZ`, `TRUE`/`FALSE` for BOOLEAN columns, `ON CONFLICT ... DO UPDATE` for upserts, `RETURNING id` for creates (postgres has no `LastInsertId`), `:execrows` for mutations that need rows-affected.
  - `Server/sqlc.yaml` — second engine entry (`engine: "postgresql"`, `sql_package: "pgx/v5"`) generating into the `pgdbgen` package under `Server/db/pgdbgen/`.
  - `Server/Makefile` — `sqlc-generate` and `sqlc-verify` cover both engines.
  - `Server/store/postgres.go` — `PostgresStore` type behind the `//go:build postgres` tag, implementing the full `store.Store` interface. Connection lifecycle (`OpenPostgres`, `Close`, `SQLDb`, `WithTx`) is fully implemented using `database/sql` + the pgx stdlib driver. Query methods are stubs that return `ErrPostgresNotImplemented`, waiting for the `pgdbgen` querier to land so they can be replaced with wrappers around generated code. The build tag keeps pgx out of the default build; operators who want to enable postgres run `go get github.com/jackc/pgx/v5 && go build -tags postgres ./...`.
  - `Server/config/config.go` — `DatabaseConfig` extended with `Type`, `Host`, `Port`, `User`, `Password`, `Name`, `SSLMode`, `MaxConns`. Defaults set to `type: "sqlite"` so existing operators are unaffected.
  - `Server/main.go` — explicit dispatch on `database.type`. Selecting `postgres` produces a clear startup error pointing at the remaining work, instead of silently falling through to sqlite.

  What still needs to land for postgres to be runnable:
  1. Add `github.com/jackc/pgx/v5` to `go.mod` and run `go mod tidy`. This happens naturally the first time an operator runs `go get github.com/jackc/pgx/v5` — the package only needs to be in the module graph when building with `-tags postgres`.
  2. Run `make sqlc-generate` to produce `Server/db/pgdbgen/` from the committed query files. This requires either network access to download sqlc or a pre-installed `sqlc` binary at v1.30.0.
  3. Replace the stub query methods in `Server/store/postgres.go` with real implementations that wrap the generated `pgdbgen` querier. The connection lifecycle and interface assertion are already in place; each stub carries the same method signature as the sqlite version, so the migration is mechanical. Where the schema produces different Go types than sqlite (e.g. `bool` vs `int64` for boolean columns, `time.Time` vs `string` for timestamps), the store wrapper performs the conversion so services see a uniform API.
  4. Refactor `main.go` and `Server/api/router.go` to thread `store.Store` through the boundary instead of `*db.DB`. Today the router constructs `dbstore.NewSQLiteStore(database)` inline, so services are store-aware but everything else still consumes `*db.DB` directly. The store-everywhere migration is the gating step before either backend can be swapped at runtime.
  5. FTS dispatch in `MessageStore.SearchMessages` / `SearchMessagesInChannels` — sqlite uses `MATCH` against the FTS5 virtual table, postgres uses `@@ to_tsquery(...)` against the `messages.fts` tsvector column. Both remain hand-written (outside the sqlc-generated set) for their respective backends.
  6. CI matrix to run the test suite against both backends.
  7. **One-way sqlite → postgres data migration.** Operators who start a community on the default sqlite backend and later outgrow it must be able to carry their history over. The migration must be forward-only (once postgres is selected, the server stays on postgres unless the operator deliberately wipes the postgres database and re-initialises), both to keep the contract simple and to avoid the support burden of "I reverted to sqlite yesterday and now my data is gone".

      Proposed design:
      - A one-shot CLI flag, e.g. `chatserver --migrate-to-postgres`, that exits after completion. No continuous sync.
      - Pre-flight checks: `database.type` in config is already `postgres`; postgres connection succeeds; the target postgres database contains no rows in `users` (or equivalent sentinel) — if it does, refuse to run, printing the exact row count so the operator can confirm they meant to target this database.
      - Open sqlite read-only alongside postgres. Begin one postgres transaction for the entire migration so partial failures roll back cleanly.
      - Copy rows in foreign-key order (`roles` → `users` → `channels` → `channel_overrides` → `messages` → `reactions` → `attachments` → `invites` → `sessions` → `voice_states` → `dm_participants` → `dm_open_state` → `read_states` → `audit_log` → `user_blocks` → `rate_lockouts` → `settings` → `emoji` → `sounds`). Disable the `trg_messages_fts_update` trigger for the bulk copy and re-populate `messages.fts` in a single `UPDATE messages SET fts = to_tsvector('simple', content)` at the end, so FTS doesn't fire per row.
      - Convert types at the boundary: sqlite RFC3339 strings → postgres `TIMESTAMPTZ` via `time.Parse`, sqlite `INTEGER` boolean (0/1) → postgres `BOOLEAN`. Drop the preserved `id` values straight through since both schemas are `BIGINT`-compatible.
      - After copying, reset every postgres sequence with `SELECT setval('<table>_id_seq', COALESCE(MAX(id), 1)) FROM <table>` so subsequent inserts don't collide with migrated IDs.
      - Write a marker row into `settings`: `migrated_from_sqlite = <RFC3339 timestamp>`. On subsequent startups with `type: postgres`, the marker's presence (or simply the presence of a non-empty `users` table) is the signal that the migration has already run and must not be repeated.
      - Uploaded files on disk (`data/uploads/`) are not touched — the migration only moves database rows. Attachments reference filenames, not blobs, so the filesystem copy is a separate `cp -a data/uploads old-host:/new-path` step the operator does out-of-band.
      - **No reverse migration.** The code does not include a postgres → sqlite path. If an operator wants to return to sqlite, they stop the server, restore a sqlite backup, edit `config.yaml` back to `type: sqlite`, and start fresh. This is deliberately inconvenient.

      This feature is gated on PostgresStore's query methods being real (pending item 3). The migration implementation itself lives in a new `Server/migrate/sqlite_to_postgres.go` file and is invoked from `main.go` before the normal startup path.

### Verification status

`go build ./...` and `go test ./...` were not run in the session that produced this branch — the development environment lacked network access to fetch the Go 1.25.0 toolchain required by `go.mod`. Manual audit of the touched Go files (the `go-build-check` skill) found no compile errors. The branch should be verified locally by the next operator before merge.

### Actionable TODOs

Scannable checklist extracted from the prose above. Work top-to-bottom; most items unblock the ones below them.

**Verification (do first, cheap)**

- [ ] Run `go build ./...` in `Server/` to confirm the branch compiles
- [ ] Run `go test ./...` in `Server/` and fix any regressions
- [ ] Run `go build -tags postgres ./...` after adding pgx (below) to verify `store/postgres.go` compiles under the postgres tag

**Postgres enablement (Step 3 final wiring)**

- [ ] `cd Server && go get github.com/jackc/pgx/v5 && go mod tidy` — add pgx to the module graph
- [ ] `make sqlc-generate` — produce `Server/db/pgdbgen/` from the committed `db/queries/postgres/*.sql`
- [ ] Commit the generated `Server/db/pgdbgen/` output
- [ ] Replace each stub in `Server/store/postgres.go` with a real implementation wrapping `pgdbgen`; keep the `//go:build postgres` tag. Expect per-method type conversion (sqlite `string` timestamps vs postgres `time.Time`, sqlite `int64` bools vs postgres `bool`)
- [ ] Implement FTS dispatch: `SearchMessages` and `SearchMessagesInChannels` currently use sqlite `MATCH`; add a postgres branch using `@@ to_tsquery(...)` against `messages.fts`
- [ ] Remove `ErrPostgresNotImplemented` once every method is real

**Store-everywhere boundary refactor (unblocks runtime backend selection)**

- [ ] Audit every `*db.DB` parameter in `Server/api/` and `Server/ws/`; replace with `store.Store` where possible, using `store.Store.SQLDb()` at the leaves that truly need `*sql.DB` (backups, migrations)
- [ ] Update `Server/api/router.go`'s `NewRouter` signature: take `store.Store` instead of `*db.DB`
- [ ] Update every `Mount*Routes(r, database, …)` call site to pass the store
- [ ] Update `ws.NewHub` and `auth.NewPersistentRateLimiter` to accept `store.Store`
- [ ] Update `Server/admin/handler.go` (`admin.NewHandler`) the same way
- [ ] Update `Server/main.go` to construct the store via a factory, `store.Open(&cfg.Database)`, that dispatches on `cfg.Database.Type`
- [ ] Delete the explicit postgres error in `main.go`'s switch — selecting postgres should Just Work once PostgresStore is real
- [ ] Fix all handler tests that construct handlers from `*db.DB` — they now take `store.Store` (use `store.MemStore` for unit tests)

**Data migration (one-way sqlite → postgres)**

- [ ] Create `Server/migrate/sqlite_to_postgres.go`
- [ ] Add `--migrate-to-postgres` CLI flag to `main.go`, parsed before normal startup
- [ ] Pre-flight: verify `database.type == postgres`, verify target postgres `users` table is empty, refuse with exact row count if not
- [ ] Implement bulk copy in FK order: `roles → users → channels → channel_overrides → messages → reactions → attachments → invites → sessions → voice_states → dm_participants → dm_open_state → read_states → audit_log → user_blocks → rate_lockouts → settings → emoji → sounds`
- [ ] Disable `trg_messages_fts_update` during bulk message copy; repopulate `messages.fts` in one statement at the end
- [ ] Convert types at the boundary: `time.Parse(time.RFC3339, …)` for timestamps, `int != 0` for booleans
- [ ] Reset every `<table>_id_seq` with `SELECT setval(…, COALESCE(MAX(id), 1))` after copy
- [ ] Write marker row: `INSERT INTO settings (key, value) VALUES ('migrated_from_sqlite', NOW()::text)`
- [ ] Wrap everything in one postgres transaction so partial failures roll back
- [ ] **Do NOT implement a reverse migration** — documented as deliberately unavailable

**CI**

- [ ] Add a postgres job to `.github/workflows/*.yml` that spins up a postgres service container and runs `go test -tags postgres ./...`
- [ ] Keep the existing sqlite job unchanged
- [ ] Add a `sqlc-verify` job that runs `make sqlc-verify` to catch stale generated code

**Hygiene (optional, do whenever)**

- [ ] Expand `Server/service/*_test.go` coverage — currently only `message_test.go` and `permission_test.go` exist; add channel, dm, voice, invite, moderation tests using `store.MemStore`
- [ ] Split the postgres migration file if it grows beyond ~300 lines; for now it's consolidated intentionally

