# Migration reversals

The hand-run reversal of every migration the B4 phase added, and every one
since (B5-2's `044` is the first), and the order to run them in. `rollback.go` is the same list for the rehearsal that tests them.

Migrations here are **forward-only**: the server applies them and never
un-applies them. Rolling one back is an operator action — these files are what
that operator runs, against a database no server is holding open, after taking
a backup. They were written with their migrations rather than improvised during
an incident, and `TestMigrationRollbackRehearsalOnAlphaSnapshot`
(`Server/db/rollback_rehearsal_test.go`) rehearses the whole set on a copy of
the committed alpha snapshot on every CI run.

## Running one

```sh
DB=data/chatserver.db   # your server's database.path -- check yours
test -f "$DB" || { echo "no database at $DB" >&2; exit 1; }

{ echo 'BEGIN;'; cat Server/rollback/043_setup_completed.down.sql; echo 'COMMIT;'; } |
  sqlite3 -bail "$DB"
```

Every part of that command is load-bearing:

- **The path is the configured one, and it is checked first.** `sqlite3`
  creates the database when the file does not exist, so a wrong path does not
  fail — it reverses a brand-new empty database, reports success, and leaves
  the live one untouched. `data/chatserver.db` is only the shipped default
  (`Server/config/config.go`, `Database.Path`); read your own `database.path`
  rather than trusting it.
- **`-bail` stops at the first error.** Without it the CLI prints the error
  and carries on to the rest of the file, including the `schema_versions`
  delete at the end — clearing the tracker for a reversal that did not finish,
  so the next start would re-apply the migration onto a half-reversed schema.
- **The wrapping transaction makes the file all-or-nothing.** Fed on stdin the
  CLI otherwise commits each statement as it reads it, so a failure halfway
  through leaves the earlier drops committed. No reversal here contains
  transaction control of its own, precisely so this wrapping is valid, and
  `TestReversalFilesAreOperatorSafe` keeps it that way — as it keeps the
  `schema_versions` delete last, so an aborted run cannot clear the tracker
  before the schema change lands.

Newest first, and contiguous: to get from 043 back to 040 run 043, 042, 041,
040 in that order. Skipping one in the middle is not a supported state.

Two rules the files themselves enforce, and one they cannot:

- **Each reversal clears its own `schema_versions` row.** That is how the next
  server start knows to apply the migration again. A reversal run without it
  leaves the database claiming a schema it does not have.
- **Order is not cosmetic.** A reversal that drops a column runs before the one
  that drops the table holding it, and `042` moves its audit tokens back into
  `subject_token` before `041` drops the column they are sitting in.
- **The server must be stopped.** Nothing here takes the writer lock the server
  holds, and a reversal that half-applies while the server is running against
  the new schema is the one failure mode these files cannot protect against.

## What each one costs

Reversing a schema change is cheap. Reversing what the migration made possible
is usually not, and every file says so in its own comment. The ones worth
knowing before you start:

| Reversal                     | What it costs                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `043_setup_completed`        | First-run setup goes back to being gated on "no users exist". On a server whose users table an erasure emptied, the unauthenticated wizard is open again — narrow the setup networks first (`docs/security.md`, "First-run setup"). |
| `042` + `041` (audit tokens) | An audit row naming two erased principals keeps one token, not both. Run 042 before 041 or lose the actor's token entirely.                                                                                                         |
| `039_retention`              | Nothing deleted by an earlier sweep comes back. A sweep whose replay purge had not finished loses its journal.                                                                                                                      |
| `037_erasure_jobs`           | An erasure that had not finished its file half loses the journal listing the files still to remove. Reconcile storage by hand afterwards.                                                                                           |
| `036` / `035` (recovery)     | Every issued credential and every enrolled kit stops working. Tell the people holding them first.                                                                                                                                   |
| `034_registration_modes`     | `approval` and `open` have no boolean spelling, so the mode becomes closed. Accounts awaiting approval become ordinary accounts that can sign in — settle them first.                                                               |
| `032_second_factor_state`    | Emergency recovery codes are invalidated, in-flight logins and enrolments dropped.                                                                                                                                                  |
| `markers.down.sql`           | Forfeits the anti-resurrection guarantee for every erasure so far: a restore of an older backup brings erased subjects back with nothing to stop them. Record it in the audit log first.                                            |

`markers.down.sql` is the odd one out: the deletion-marker file carries its own
schema, applied on every open by `Server/db/markers.go`, so it is not a
migration, has no `schema_versions` row to clear, and runs against
`data/erasure/markers.sqlite` rather than the database.

## Adding one

A new migration lands with its reversal in the same PR. The rehearsal fails
otherwise — it asserts that every migration past the snapshot's level has a
reversal, and that the full set round-trips the snapshot's schema,
`schema_versions`, settings and row counts exactly.

The four B4 data contracts drafted their reversals before their migrations
landed (`docs/plans/hp-4-drafts/`, HP-4 question 2). Those drafts are the
historical record of the design; the files here are what runs.
