# HP-4 schema drafts

The data contracts HP-4 question 2 asks for, as migration drafts with their
rollbacks. They are **not** applied migrations: `Server/migrations/` gains
them only when B4-9, B4-10 and B4-11 land, renumbered after whatever merged
first (B4-5 and B4-6 hold 035 and 036 at the time of writing). Each `up`
file is what the step's `db-change` migration will contain; each `down` file
is the rollback an operator runs by hand (SQLite migrations here are
forward-only), kept beside it so the reversal was written when the shape was,
not improvised later.

| Draft                            | Step  | Contract                                                                                                               |
| -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `erasure_jobs.{up,down}.sql`     | B4-9  | the durable, resumable erasure job: one row per subject, the database half in one transaction, the file half journaled |
| `deletion_markers.{up,down}.sql` | B4-10 | the anti-resurrection marker: an unlinkable token per erased subject, replayed against any restored database           |
| `audit_unlinking.{up,down}.sql`  | B4-10 | audit history that keeps its integrity without naming the subject                                                      |
| `retention.{up,down}.sql`        | B4-11 | server and per-channel retention windows and the run log                                                               |

The scorecard ([hp-4-scorecard-2026-09-02.md](../hp-4-scorecard-2026-09-02.md))
records the decisions the shapes encode.

Applied so far: `erasure_jobs` landed as `Server/migrations/037_erasure_jobs.sql`
(B4-9, 2026-09-03), byte-for-byte the `up` draft plus the `idx_messages_reply_to`
index the erasure's cascade needed (#1517); its `down` file stays here as the
rollback. `audit_unlinking` landed as `Server/migrations/038_audit_unlinking.sql`
(B4-10, 2026-09-03), verbatim. `deletion_markers` is applied by the server on
the marker file itself (`Server/db/markers.go`, `OpenMarkerStore`), not by the
migrations, with one addition to the draft: a `state` column
(`pending`/`recorded`) for the two-phase write around the erasure transaction
(`docs/schema.md`, "The deletion-marker file"); its `down` file is the
rollback for that file.
