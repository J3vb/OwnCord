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

### Phase 1 — done (2026-07-19)
sqlc is now **load-bearing in production** (previously dead code):

| Domain | Methods delegated | Notes |
|--------|-------------------|-------|
| blocks (`block_queries.go`) | BlockUser, UnblockUser, IsBlocked, IsEitherBlocked, ListBlockedUsers | Added `ListBlockedUsers` query. Empty result now `[]int64{}` (matches MemStore; was `nil`). |
| lockouts (`lockout_queries.go`) | UpsertLockout, LoadActiveLockouts, CleanupExpiredLockouts, DeleteLockout | Time formatting/parsing kept in the wrapper. |
| roles (`role_queries.go`) | GetRoleByID, ListRoles, GetRoleForUser | Shared `roleFromGen` mapper. `GetUserWithRole` (joined User+Role) stays raw. |

### Phase 2 — remaining domains (raw SQL still, each survives D3)
Convert with the same pattern; add missing queries + a `fromGen` mapper where
needed. Rough order by mapping simplicity:

- **Simple/exec-heavy:** invites (`invite_queries.go`), profile
  (`profile_queries.go`), attachments (`attachment_queries.go`).
- **Model-mapped reads:** sessions (`auth_queries.go`), users
  (`auth_queries.go` — `GetUserByID`/`GetUserByUsername`/`ListAllUsers`),
  channels (`channel_queries.go`), voice (`voice_queries.go`),
  dm (`dm_queries.go`), admin/settings (`admin_queries.go`).
- **Complex/joined:** messages (`message_queries.go` — search, cursor
  pagination, reactions), `GetUserWithRole`, `GetServerStats`.

### Out of scope for D2
- `store/` event + plugin SQL (`store/sqlite_events.go`, plugin store) — these
  live in the store layer being **removed in D3**; converting them is throwaway.
  D3 moves the surviving `db` methods (sqlc-backed) to direct service use.

## Verification (per phase)
`go build ./...`; `go test -race ./db/ ./service/ ./auth/ ./api/ ./ws/`;
`make sqlc-verify` (generated output committed & in sync).
