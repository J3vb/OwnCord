# Database

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the code wins, then the source documents.

OwnCord stores all durable state in a single SQLite file. This page is the map for an agent working on `Server/db/` or `Server/migrations/`: engine configuration, how queries reach the database, what the schema contains, how migrations and rollbacks work, how to change the schema, and the destructive or retention paths (erasure, retention, backups, uploads) that touch the file on disk.

## Engine and driver

- **Engine:** SQLite only. `database.type` accepts `sqlite` (or empty); any other value makes the server refuse to start.
- **Driver:** the pure-Go `modernc.org/sqlite`, no CGO.
- **File:** `data/chatserver.db` by default (`database.path`).
- **Migrations run automatically on startup**, embedded via `go:embed` and applied by the runner in `Server/db/migrate.go`.

### Pragmas

| PRAGMA         | Value       | Purpose                                    |
| -------------- | ----------- | ------------------------------------------ |
| `journal_mode` | `WAL`       | Write-Ahead Logging for concurrent readers |
| `foreign_keys` | `ON`        | Enforces all `REFERENCES` constraints      |
| `busy_timeout` | `5000`      | Waits up to 5 seconds for the write lock   |
| `synchronous`  | `NORMAL`    | Safe with WAL mode, reduces fsync calls    |
| `temp_store`   | `MEMORY`    | Temporary tables stored in RAM             |
| `mmap_size`    | `268435456` | 256 MB memory-mapped I/O                   |
| `cache_size`   | `-64000`    | 64 MB page cache                           |

Every file-backed connection gets these through `_pragma=` DSN parameters (`filePragmas` in `Server/db/db.go`). Never add a per-connection PRAGMA with `Exec` after `Open`: it lands on one arbitrary pooled connection. The account-erasure transaction (below) temporarily sets `secure_delete = ON` and runs `wal_checkpoint(TRUNCATE)` after commit, restoring the normal pragma afterwards.

### Connection handling

SQLite allows one writer at a time, so `Server/db/db.go` runs a split pool for file-backed (production) databases:

- A single-connection writer pool (`SetMaxOpenConns(1)`). Its DSN adds `_txlock=immediate`, so every transaction takes the write lock at `BEGIN`.
- A multi-connection read-only pool, sized `max(4, NumCPU)` when `database.max_readers` is `0` (the default); an explicit `max_readers` is clamped to 1–64.
- A statement runs on the reader only when its first keyword after `--` comments is `SELECT` or `PRAGMA`. Everything else, including `INSERT … RETURNING` and `WITH …`, runs on the writer.

In-memory databases (tests) keep a single shared connection instead.

## Access layer

`Server/db` is the single data layer. Most methods live in `*_queries.go`; erasure, retention, recovery and delivery-receipt code lives in `erasure.go`, `retention*.go`, `recovery_*.go` and `message_delivery*.go`. Most methods delegate to a **sqlc-generated** layer:

- Hand-written SQL lives in `Server/db/queries/sqlite/*.sql`.
- `sqlc` (config `Server/sqlc.yaml`, engine `sqlite`, schema = `migrations`) generates everything in `Server/db/dbgen/` (`db.go`, `models.go`, `*.sql.go`). **Never hand-edit it**: CI fails on drift.

A deliberate remainder still runs as hand-written SQL where sqlc cannot express it: variable-length `IN` lists, FTS5 queries, multi-statement transactions, and `PRAGMA`/`VACUUM` statements.

Consumers depend on narrow interfaces that `*db.DB` satisfies (`service.Store`, `ws.EventStore` for cold-tier replay, `plugin.PluginStore`) rather than the concrete type. Only `Server/db` and `Server/service` may import `db` freely; any other production file that imports it needs a row in `DBImportAllow` (`Server/invariants/db_import_boundary.go`), a shrink-only inventory. New persistence goes behind a service, not directly into an API handler.

A second, separate SQLite file, `data/erasure/markers.sqlite`, holds deletion markers for account erasure and retention sweeps. The server applies its schema itself (`Server/db/markers.go`), not through the migration runner, and it deliberately lives outside the file a backup restore overwrites. See [Data lifecycle and retention](#data-lifecycle-and-retention).

## Schema overview

The generated table index in [docs/schema.md](docs/schema.md) lists every table (54 at this commit, including `sqlite_sequence` and the FTS5 shadow tables behind `messages_fts`). It is a generated block owned by `cmd/gendocs`, so it is not copied here; read `docs/schema.md` for exact columns and indexes. Grouped by domain:

| Domain               | Representative tables                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity & access    | `users`, `roles`, `sessions`, `api_tokens`, `channel_overrides`, `channel_user_overrides`, `user_blocks`, `invites`, `login_attempts`, `rate_lockouts`             | Permissions are a bitfield on `roles.permissions`. Per channel, the role layer (`channel_overrides`) and then the member layer (`channel_user_overrides`) are each applied as `(perms &^ deny) \| allow`, so a member-level deny beats a role-level allow; `ADMINISTRATOR` bypasses overrides at the call site. `login_attempts` exists but no code writes it (always empty). |
| Messaging            | `channels`, `messages`, `message_mentions`, `messages_fts` (+ FTS5 shadow tables), `attachments`, `reactions`, `read_states`, `emoji`, `message_delivery_receipts` | Messages are soft-deleted (`deleted = 1`). FTS triggers index inserts, hard deletes and content edits only, so a soft-deleted message stays in `messages_fts`; search filters `m.deleted = 0`.                                                                                                                                                                                |
| Direct messages      | `dm_participants`, `dm_open_state`                                                                                                                                 | DMs are `channels` rows with `type='dm'`; `channels.is_group` marks a group DM, decided once at creation.                                                                                                                                                                                                                                                                     |
| Voice                | `voice_states`                                                                                                                                                     | One row per user (ephemeral, cleared on server startup).                                                                                                                                                                                                                                                                                                                      |
| Real-time replay     | `events`                                                                                                                                                           | Cold tier of the reconnect-replay pipeline; pruned on a retention timer.                                                                                                                                                                                                                                                                                                      |
| Plugins              | `plugins`, `plugin_kv`                                                                                                                                             | WASM plugin runtime state; `plugin_kv` is a per-plugin namespaced KV store.                                                                                                                                                                                                                                                                                                   |
| Auth / second factor | `partial_auth_challenges`, `pending_totp_enrollments`, `totp_used_codes`, `totp_recovery_codes`, `recovery_kits`, `recovery_assists`                               | Login challenge, TOTP enrolment and replay window, and account-recovery credential state.                                                                                                                                                                                                                                                                                     |
| Moderation           | `reports`, `report_evidence`, `report_notes`, `report_events`, `moderation_actions`, `appeals`                                                                     | Local report intake and queue, the moderator-action ledger, and the appeal flow.                                                                                                                                                                                                                                                                                              |
| Data governance      | `erasure_jobs`, `channel_retention`, `retention_runs`, `retention_revision`, `nsfw_acknowledgements`, `message_requests`, `trusted_senders`                        | Erasure file-removal journal, retention policy and journal, NSFW consent, and DM-request/trust staging.                                                                                                                                                                                                                                                                       |
| Storage accounting   | `user_storage`                                                                                                                                                     | Durable per-user upload byte counter.                                                                                                                                                                                                                                                                                                                                         |
| Push notifications   | `push_subscriptions`                                                                                                                                               | One row per user/endpoint.                                                                                                                                                                                                                                                                                                                                                    |
| Ops / misc           | `settings`, `audit_log`, `schema_versions`                                                                                                                         | `settings` is a generic KV store; `audit_log` records actor/target actions; `schema_versions` tracks applied migrations.                                                                                                                                                                                                                                                      |

The deletion-marker file (`data/erasure/markers.sqlite`) holds its own small schema: `deletion_markers`, `sequence_floors`, `floor_probes`, `marker_meta`. See [docs/schema.md](docs/schema.md#the-deletion-marker-file-dataerasuremarkerssqlite) for the DDL and semantics.

## Migrations and rollback

- **Location:** `Server/migrations/NNN_name.sql` (`001`–`053` at this commit), embedded and applied in lexicographic order, tracked in the `schema_versions` table.
- **Forward-only in production.** The server applies each migration exactly once and never un-applies one. A migration that has shipped is **immutable**: `migrate.go` records applied migrations by filename with no content hash, so editing an already-applied file silently splits fresh installs from upgraded ones. Write a new migration instead.
- **Numbering is position.** A new migration is numbered one past the highest on `dev`; skipping ahead of an unwritten number gives two installs two different apply orders. `node scripts/check-migrations.mjs` enforces both rules.
- **Manual rollback:** `Server/rollback/*.down.sql` holds a hand-written reversal for every migration after `031` (the committed alpha snapshot's level), listed newest-first in `rollback.Order` (`Server/rollback/rollback.go`); `001`–`031` have none. These are **operator-run, not server-run**: stop the server, take a backup, wrap the file in a transaction, and run it with `sqlite3 -bail` against the exact configured `database.path`. Rollbacks are applied newest-first and contiguously (no skipping). Each reversal clears its own `schema_versions` row and states its cost (data lost) in its own header comment; `Server/rollback/README.md` tabulates the ones worth knowing before you start. `TestMigrationRollbackRehearsalOnAlphaSnapshot` rehearses the full set on every CI run.
- `markers.down.sql` is the exception: it reverses the deletion-marker file's own schema (not tracked in `schema_versions`) and, if run, forfeits the anti-resurrection guarantee for every erasure so far.

## Changing the schema

Run the commands from `Server/`. `npm run generate` from the repo root runs steps 2 and 4 together, but skips (does not fail) the sqlc step when `sqlc` is not on PATH, leaving `dbgen/` stale.

1. Add the migration `Server/migrations/NNN_name.sql` and, in the same change, its reversal `Server/rollback/NNN_name.down.sql`. Prepend the reversal to `rollback.Order` in `Server/rollback/rollback.go`, give it no `BEGIN`/`COMMIT`, and end it with `DELETE FROM schema_versions WHERE version = 'NNN_name.sql';`. `TestMigrationRollbackRehearsalOnAlphaSnapshot` and `TestReversalFilesAreOperatorSafe` fail otherwise. Edit `Server/db/queries/sqlite/*.sql` for query changes.
2. Regenerate the sqlc layer: `sqlc generate`. The version is pinned in `Server/sqlc.version`; install it with `go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(cat sqlc.version)`, and run `$(go env GOPATH)/bin/sqlc generate` if that directory is not on PATH.
3. Commit the regenerated `Server/db/dbgen/` with the migration and query changes. CI and the pre-commit hook verify it with `sqlc generate && git diff --exit-code db/dbgen` (what `make sqlc-verify` runs; `make` is not on a stock Windows PATH).
4. Regenerate the table index in `docs/schema.md` with `go run -tags otel,wazero ./cmd/gendocs` and commit it (CI and the pre-commit hook fail on drift). Also add the migration's row to the hand-written Migration History table in `docs/schema.md`.
5. A table holding user-attributable data must be added to both `erasureStatements` (`Server/db/erasure.go`) and `db.SubjectInventory` (`Server/db/inventory.go`). `TestEraseAccount_EveryInventoryClassIsZero` walks only the inventory, so a table in one list and not the other passes silently. A `REFERENCES users(id)` with no `ON DELETE` action blocks the erasure's `DELETE FROM users` unless its rows are deleted first.

**sqlc gotchas.** sqlc raises no error for any of these; `TestQueryFilesAreASCIIOnly` catches the first, and the second fails `db.Migrate` with a syntax error.

- **Query files must be ASCII-only.** sqlc v1.30.0 measures rune positions against byte offsets, so one multi-byte character (an em-dash in a comment is the usual culprit) truncates the _next_ query's generated SQL.
- **No semicolons inside migration `--` comments.** The migration splitter splits on `;` before stripping comments, so a semicolon in comment prose produces a bogus trailing statement.
- **Regenerate from a tree where the query files and `Server/migrations/` carry only your change.** sqlc regenerates every `dbgen/` file from every query file and reads `Server/migrations/` as its schema, so unrelated in-progress edits get silently baked into the generated output you commit. Check `git status` on `Server/db/` and `Server/migrations/` first.
- **A `:one` query needs no `LIMIT 1`.** It reads one row via `QueryRow`; use `ORDER BY` to pick which. sqlc keeps `LIMIT 1` intact in `IsBlocked` and `FindAppealForAction`, but the one recorded mis-emission is `GetOwnerUser` (`apitokens.sql`), so check the generated const if you add one.
- After regenerating, editor/gopls diagnostics against `dbgen` go stale: trust `go build`, not IDE squiggles.

## Data lifecycle and retention

Destructive and retention operations are documented in detail in [docs/architecture/data-lifecycle.md](docs/architecture/data-lifecycle.md). The main paths:

- **Account erasure** (`DELETE /api/v1/auth/account`, `DELETE /admin/api/users/{id}`) runs `db.EraseAccount` in one writer transaction. It hard-deletes the subject's rows across sessions, tokens, messages, mentions, reactions, DM state and more (children before parents), reassigns server-wide `emoji` ownership, and writes an `erasure_jobs` row journaling the uploaded files still to remove after commit. A **deletion marker** is recorded in the separate `data/erasure/markers.sqlite` file, so restoring an older backup re-erases the account on the next server open: the marker file survives a database restore precisely because it is a different file.
- **Message deletion** is a soft delete (`messages.deleted = 1`), and so is a moderation purge (`PurgeChannelMessages`); the row and content stay. Messages are hard-deleted only by the author's account erasure, the retention sweep, or deleting their channel (`messages.channel_id … ON DELETE CASCADE`).
- **Retention sweep** (on the maintenance tick; off by default). The `retention_days` row in `settings`, set from the admin panel, is `0` = keep forever, and `channel_retention` overrides it per channel in either direction. The sweep hard-deletes unpinned messages older than the effective window, never in DMs or group DMs, in batches of 500 and at most 5,000 per tick. It journals the run in `retention_runs` and records a `messages`-scoped marker for each channel swept clean to its cutoff, so a restored backup is swept again.
- **Orphaned-attachment sweep** runs every 15 minutes, deleting attachment rows that are unlinked or attached to a soft-deleted message (and not a live avatar), then removing the underlying files; a reconciliation pass catches anything a crash strands.

## File and upload storage, quotas

Configuration keys, from [docs/server-configuration.md](docs/server-configuration.md):

| Key                    | Default         | Purpose                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload.storage_dir`   | `data/uploads`  | Directory where uploaded files (attachments, avatars, emoji) are stored on disk.                                                                                                                                                                                                                                                             |
| `upload.max_size_mb`   | `100`           | Maximum size of a single uploaded file; a larger one is refused with `400 BAD_REQUEST`.                                                                                                                                                                                                                                                      |
| `upload.user_quota_mb` | `0` (unlimited) | Total bytes one user may hold across attachments and avatars, charged where the bytes are written and tracked durably in the `user_storage` table (migration `044`). Custom emoji are excluded: they are server-wide assets bounded by a separate emoji cap (200 files × 512 KiB). Exceeding the quota returns `507 STORAGE_QUOTA_EXCEEDED`. |

Attachments use UUID primary keys (`attachments.id`). The row and the file on disk (`stored_as`) are linked and unlinked independently, which is why the orphan sweep and the erasure and retention journals exist: to keep the byte counter and the files in sync with the rows that reference them.

## Backups and restore

From [docs/deployment.md](docs/deployment.md), [docs/server-configuration.md](docs/server-configuration.md) and [docs/architecture/data-lifecycle.md](docs/architecture/data-lifecycle.md):

- **Backup directory:** `backup.dir`, default `data/backups`. Point it at another disk or an off-host mount so backups are not a single point of failure with the live database.
- **Taking a backup** (`POST /admin/api/backup`, Owner-only, or the scheduled job) runs SQLite's `VACUUM INTO` on the single writer connection (writes queue for its duration; reads keep serving), then runs `integrity_check` on the result and removes it on failure.
- **Schedule and retention.** The Backup Schedule and Retention (days) settings are enforced by the 15-minute maintenance tick. A scheduled backup is taken when the newest `*.db` in `backup.dir` is older than the interval (a manual backup resets the clock). Both are Owner-only to change. Retention (`0` = keep forever, otherwise 7–3650 days) deletes every manual and scheduled `*.db` there older than the window by mtime, never the newest file and never a `pre_restore_*` safety copy.
- **A database backup is the database only.** Not in it: `data/uploads/`, `data/totp.key`, `data/erasure.key`, `data/erasure/markers.sqlite`, `data/push_vapid.key` and `config.yaml`. Back up `data/` wholesale on the same schedule as the database. Without `totp.key` the server generates a new key and every 2FA user is locked out; without `erasure.key` it refuses to start; without `markers.sqlite` every account erased since the backup comes back (the server boots and logs an error); without `push_vapid.key` every push subscription is invalidated.
- **Restoring** (`POST /admin/api/backups/{name}/restore`, Owner-only) runs, in order: `integrity_check` on the chosen backup (a broken one is refused); the `backup_restore` audit row, written synchronously; a `pre_restore_<timestamp>.db` safety copy in `backup.dir` (if that fails, it aborts with the database untouched); a restart broadcast; `wal_checkpoint(TRUNCATE)`; closing the database; streaming the backup over the live file (on a copy error the safety copy is put back); and a restart. A kill during the copy leaves a truncated file that `db.Open` refuses: restore the `pre_restore_*` copy by hand. The running version re-applies any newer migrations on the next start, so a restore is not a version rollback (that is restore-then-downgrade; see "Upgrade and Rollback" in `docs/deployment.md`).
- A restore reverts _everything_ committed after the backup was taken (new accounts, messages, erasures, bans, settings), the same way undoing any point-in-time snapshot would.
- **Deletion markers defend against restore-based resurrection.** Because `data/erasure/markers.sqlite` is a separate file the restore does not touch, every marker recorded after the backup was taken is replayed against the restored database on the next start, before anything is served, so an erased account (or a swept channel) does not come back just because an old backup was restored.

## Sources

- [docs/schema.md](docs/schema.md), [docs/architecture/data-model.md](docs/architecture/data-model.md), [docs/architecture/data-lifecycle.md](docs/architecture/data-lifecycle.md), [docs/server-configuration.md](docs/server-configuration.md), [docs/deployment.md](docs/deployment.md)
- [Server/db/db.go](Server/db/db.go), [Server/db/migrate.go](Server/db/migrate.go), [Server/db/erasure.go](Server/db/erasure.go), [Server/db/inventory.go](Server/db/inventory.go), [Server/db/markers.go](Server/db/markers.go), [Server/db/retention.go](Server/db/retention.go), [Server/db/message_queries.go](Server/db/message_queries.go)
- [Server/sqlc.yaml](Server/sqlc.yaml), [Server/rollback/rollback.go](Server/rollback/rollback.go), [Server/rollback/README.md](Server/rollback/README.md), [Server/permissions/permissions.go](Server/permissions/permissions.go), [scripts/check-migrations.mjs](scripts/check-migrations.mjs)
- [Server/admin/api.go](Server/admin/api.go), [Server/admin/backup_maintenance.go](Server/admin/backup_maintenance.go), [Server/admin/handlers_backup.go](Server/admin/handlers_backup.go), [Server/storage/storage.go](Server/storage/storage.go)
- [Server/CLAUDE.md](Server/CLAUDE.md), [.claude/skills/db-change/SKILL.md](.claude/skills/db-change/SKILL.md), [.claude/rules/db-change.md](.claude/rules/db-change.md)
