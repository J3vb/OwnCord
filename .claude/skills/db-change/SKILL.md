---
name: db-change
description: Change OwnCord's SQLite schema or queries — add a migration, edit Server/db/queries/*.sql, and regenerate the sqlc layer. Use before touching anything under Server/db/ or Server/migrations/.
---

# db-change

`Server/db/dbgen/` is generated. Edit the inputs, regenerate, commit both.

1. Add the migration to `Server/migrations/` and/or edit
   `Server/db/queries/sqlite/*.sql`.
2. Regenerate: `make sqlc-generate` from `Server/`.
3. Commit the regenerated `Server/db/dbgen/` alongside your inputs. CI runs
   `make sqlc-verify` and fails on drift.

`sqlc.version` pins the binary (currently v1.30.0). If `make` is not on PATH:

```bash
go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(cat sqlc.version)
$(go env GOPATH)/bin/sqlc generate
```

## Traps

These are silent — the code generates fine and fails at runtime.

**Query files must be ASCII-only.** sqlc v1.30.0 measures rune positions
against byte offsets, so one multi-byte character (an em-dash in a comment is
the usual culprit) truncates the _next_ query's emitted SQL by that many
trailing bytes. Symptom: the `.sql` file looks right but the generated const
in `dbgen/*.sql.go` is cut short — `ORDER BY id ASC` becomes `ORDER BY id A`,
and SQLite reports "incomplete input".

**No semicolons inside migration `--` comments.** `splitStatements` in
`Server/db/migrate.go` splits on `;` before stripping comments, so a semicolon
in comment prose orphans the rest of that comment as a bogus statement
("near <word>: syntax error").

**Regenerate from a tree where the query files carry only YOUR change.**
sqlc regenerates every `dbgen/` file from every query file on each run, so
unrelated working-tree edits to any `queries/*.sql` — a parallel agent's
half-finished work, leftover debris — are silently baked into generated
output you then commit. Check `git status` on `Server/db/` before
`sqlc generate`, and diff the regen for hunks that are not yours.

**Do not put `LIMIT 1` on a `:one` query.** It is emitted as a bare `LIMIT`.
A `:one` uses `QueryRow` and reads a single row regardless — use `ORDER BY` to
choose which one.

After regenerating, gopls diagnostics against `dbgen` go stale. Trust
`go build`, not the editor squiggles.
