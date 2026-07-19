# sqlc Adoption (D2) — Progress & Plan

**Decision:** D2 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md) — adopt
sqlc as the real query layer; **Closes:** audit finding A-2026-07-05 (dead `db/dbgen`).

## Approach

`db.DB` now holds a `*dbgen.Queries` (`db/db.go`, initialized in `Open` via
`dbgen.New(sqlDB)`). Query method bodies delegate to it; sqlc owns the SQL text
and parameter binding (verified in CI by `make sqlc-verify`), while the `db`
package keeps its **stable public API and domain model types** so no caller in
`api`/`admin`/`ws`/`service` changes. Migration is **incremental** — a method
either delegates to `d.q.*` or still runs raw SQL against `sqlDB`; both are
correct during the transition.

Two mechanical frictions drive the per-domain effort:

1. **Model mismatch.** Generated row structs use `int64`/`*int64` and store
   booleans as `int64`; the domain models use `int`/`*int`/`bool`. SELECT
   conversions need a small `fromGen` mapper per domain (see `roleFromGen` in
   `db/role_queries.go`).
2. **Missing queries.** A few hand-written methods had no generated
   counterpart (e.g. `ListBlockedUsers`); add the query to
   `db/queries/sqlite/<domain>.sql` and `make sqlc-generate` before delegating.

## Status

### Phase 1 + 2 — done (2026-07-19)
sqlc is now **load-bearing in production** (previously dead code). **97 `db.DB`
methods delegate** to `dbgen` across every domain; 43 raw `d.sqlDB` calls
remain (the `db.go` passthrough helpers, `migrate.go`, and the intentionally
raw queries listed below). Shared mappers live in `db/mappers.go`
(`userFromGen`, `sessionFromGen`, `roleFromGen`, `ptrI64toI`/`ptrItoI64`,
`b2i64`, `strToNullPtr`, `derefString`).

Delegated domains: blocks, lockouts, roles, users + sessions, invites, profile,
attachments, voice, dm (simple ops), channels + permission overrides, admin
(users/settings/audit/counts), messages (create/get/edit/delete/reactions/
pins/read-state).

### Deliberately kept raw (no clean sqlc mapping)
- **Variable-length `IN(...)`** (sqlc can't express): `GetAttachmentsByMessageIDs`,
  `LinkAttachmentsToMessage`, `GetChannelTypes`.
- **FTS / dynamic WHERE / cursor pagination**: `GetMessages`, `SearchMessages`,
  `SearchMessagesInChannels`, `GetMessagesForAPI`, `GetPinnedMessages`,
  `getReactionsBatch`, `GetChannelUnreadCounts`, `GetLatestMessageID`
  (sqlc types the `MAX()` result as `interface{}`).
- **Multi-statement transactions**: `GetOrCreateDMChannel` (serializable tx),
  `GetUserDMChannels` (aggregate), `GetDMRecipient`, `CreateOwnerIfEmpty`,
  `CreateUserWithInvite`, `GetUserWithRole`.
- **Non-query SQL**: `GetServerStats` PRAGMAs, `BackupToSafe` (`VACUUM INTO`),
  `AdminCreateChannel`, `CountChannelVoiceUsers`, `account.go`.

These are candidates for follow-up (add `sqlc.arg`/`sqlc.slice` queries or
accept they stay raw), but none block the D2 goal: `dbgen` is no longer dead
and owns the SQL for the overwhelming majority of the data layer.

### Out of scope for D2
- `store/` event + plugin SQL (`store/sqlite_events.go`, plugin store) — these
  live in the store layer being **removed in D3**; converting them is throwaway.
  D3 moves the surviving `db` methods (sqlc-backed) to direct service use.

## Verification (per phase)
`go build ./...`; `go test -race ./db/ ./service/ ./auth/ ./api/ ./ws/`;
`make sqlc-verify` (generated output committed & in sync).
