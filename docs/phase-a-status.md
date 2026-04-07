# Phase A Implementation Status

**Branch:** `claude/phase-a-foundation-plan-eUys1`

This document tracks what shipped during Phase A (Foundation) and what is still pending. The original Phase A design brief (`phase-a-foundation.md`) was removed from the repo root on `dev`; this status doc preserves the actionable follow-up work.

## Done

- **Step 1 — Service layer + permission cache.** `Server/service/` contains 12 service files covering message, channel, permission, moderation, user, dm, block, invite, voice. Services depend on `store.Store`, not `*db.DB`. PermissionService maintains a per-user cache. REST and WS handlers (auth, channel, dm, profile, upload, chat, reaction, presence, voice) are migrated. Service tests live in `service/message_test.go` and `service/permission_test.go`.
- **Step 2 — sqlc adoption.** `Server/sqlc.yaml` configures both the SQLite engine (queries in `Server/db/queries/sqlite/`, generated output in `Server/db/dbgen/`) and the PostgreSQL engine (queries in `Server/db/queries/postgres/`, output in `Server/db/pgdbgen/`). sqlc v1.30.0 is pinned in `Server/sqlc.version`. `Server/Makefile` exposes `sqlc-install`, `sqlc-generate`, `sqlc-verify` targets covering both engines. 14 SQL query files per engine cover all DB domains; the SQLite `dbgen` package is committed, the PostgreSQL `pgdbgen` package will be generated on the next `make sqlc-generate` run. FTS search queries remain hand-written; transactional multi-step operations are unchanged.
- **Step 3 (partial) — Store interface + SQLiteStore + MemStore.** `Server/store/store.go` defines the full Store interface (12 sub-interfaces). `Server/store/sqlite.go` wraps `*db.DB`. `Server/store/memstore.go` provides an in-memory implementation used by service tests.
- **Step 4 — Logging consolidation.** OwnCord code uses `log/slog` exclusively. `go.uber.org/zap` and `rs/zerolog` appear only as transitive dependencies of livekit and are not imported by any OwnCord `.go` file. The plan's "pick one and find-and-replace" item is satisfied.
- **Step 5 — Pub/sub broadcast model.** `Server/ws/pubsub.go`, `topic_rate_limiter.go`, `ringbuffer.go`, and the three-tier priority queue (commit `7ccc93f`) implement the topic-based broadcast model with global rate limits, backpressure, and priority tiers.

## Pending

### Step 3 — PostgreSQL backend (final wiring)

Scaffolding has landed on this branch:

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

### One-way sqlite → postgres data migration

Operators who start a community on the default sqlite backend and later outgrow it must be able to carry their history over. The migration must be forward-only (once postgres is selected, the server stays on postgres unless the operator deliberately wipes the postgres database and re-initialises), both to keep the contract simple and to avoid the support burden of "I reverted to sqlite yesterday and now my data is gone".

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

## Verification status

`go build ./...` and `go test ./...` were not run in the session that produced this branch — the development environment lacked network access to fetch the Go 1.25.0 toolchain required by `go.mod`. Manual audit of the touched Go files (the `go-build-check` skill) found no compile errors. The branch should be verified locally by the next operator before merge.

## Actionable TODOs

Scannable checklist extracted from the prose above. Work top-to-bottom; most items unblock the ones below them.

### Verification (do first, cheap)

- [ ] Run `go build ./...` in `Server/` to confirm the branch compiles
- [ ] Run `go test ./...` in `Server/` and fix any regressions
- [ ] Run `go build -tags postgres ./...` after adding pgx (below) to verify `store/postgres.go` compiles under the postgres tag

### Postgres enablement (Step 3 final wiring)

- [ ] `cd Server && go get github.com/jackc/pgx/v5 && go mod tidy` — add pgx to the module graph
- [ ] `make sqlc-generate` — produce `Server/db/pgdbgen/` from the committed `db/queries/postgres/*.sql`
- [ ] Commit the generated `Server/db/pgdbgen/` output
- [ ] Replace each stub in `Server/store/postgres.go` with a real implementation wrapping `pgdbgen`; keep the `//go:build postgres` tag. Expect per-method type conversion (sqlite `string` timestamps vs postgres `time.Time`, sqlite `int64` bools vs postgres `bool`)
- [ ] Implement FTS dispatch: `SearchMessages` and `SearchMessagesInChannels` currently use sqlite `MATCH`; add a postgres branch using `@@ to_tsquery(...)` against `messages.fts`
- [ ] Remove `ErrPostgresNotImplemented` once every method is real

### Store-everywhere boundary refactor (unblocks runtime backend selection)

- [ ] Audit every `*db.DB` parameter in `Server/api/` and `Server/ws/`; replace with `store.Store` where possible, using `store.Store.SQLDb()` at the leaves that truly need `*sql.DB` (backups, migrations)
- [ ] Update `Server/api/router.go`'s `NewRouter` signature: take `store.Store` instead of `*db.DB`
- [ ] Update every `Mount*Routes(r, database, …)` call site to pass the store
- [ ] Update `ws.NewHub` and `auth.NewPersistentRateLimiter` to accept `store.Store`
- [ ] Update `Server/admin/handler.go` (`admin.NewHandler`) the same way
- [ ] Update `Server/main.go` to construct the store via a factory, `store.Open(&cfg.Database)`, that dispatches on `cfg.Database.Type`
- [ ] Delete the explicit postgres error in `main.go`'s switch — selecting postgres should Just Work once PostgresStore is real
- [ ] Fix all handler tests that construct handlers from `*db.DB` — they now take `store.Store` (use `store.MemStore` for unit tests)

### Data migration (one-way sqlite → postgres)

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

### CI

- [ ] Add a postgres job to `.github/workflows/*.yml` that spins up a postgres service container and runs `go test -tags postgres ./...`
- [ ] Keep the existing sqlite job unchanged
- [ ] Add a `sqlc-verify` job that runs `make sqlc-verify` to catch stale generated code

### Hygiene (optional, do whenever)

- [ ] Expand `Server/service/*_test.go` coverage — currently only `message_test.go` and `permission_test.go` exist; add channel, dm, voice, invite, moderation tests using `store.MemStore`
- [ ] Split the postgres migration file if it grows beyond ~300 lines; for now it's consolidated intentionally
