---
name: db-change
description: Workflow for OwnCord database changes — schema migrations, sqlc queries, or anything touching Server/db, Server/migrations, or sqlc.yaml. Use before editing SQL or the db layer.
---

# db-change — database/sqlc workflow

The db layer is sqlc-generated: `Server/db/queries/*.sql` + `Server/migrations/` → `Server/db/dbgen/` (via `sqlc.yaml`, sqlc version pinned in `Server/sqlc.version`). **Never hand-edit `db/dbgen/`** — CI's `make sqlc-verify` fails on drift.

## Steps

1. Schema change? Add a new migration in `Server/migrations/` (never rewrite an existing migration that may have shipped; migrations are append-only). Update `docs/schema.md` to match.
2. Query change? Edit/add SQL in `Server/db/queries/*.sql` using sqlc annotations (`-- name: GetFoo :one` etc.).
3. Regenerate:
   ```bash
   cd Server && make sqlc-install sqlc-generate
   ```
4. Wire it up in the hand-written wrappers in `Server/db/*.go` (they delegate to dbgen), and add table-driven tests in the matching `*_test.go`.
5. Verify:
   ```bash
   go build ./... && go test -race ./db/... && make sqlc-verify
   ```
6. Commit migrations, queries, regenerated `db/dbgen/`, wrappers, tests, and doc updates together.

## Notes

- SQLite is the primary engine; a PostgreSQL variant exists behind `-tags postgres` (`db/pgdbgen/` when configured) — regenerate covers both when defined in `sqlc.yaml`.
- Consider backup/restore impact (`admin/` backup tooling reads the schema) for destructive schema changes.
