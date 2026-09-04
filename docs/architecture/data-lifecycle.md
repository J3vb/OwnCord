# Data lifecycle — destructive operations, their failure models, and every user-attributable data class

**Kind:** reference and design record. **Written:** 2026-09-01 (B4-0),
verified against `dev` @ `aabac60`. **Amended 2026-09-03 (B4-9):** O1 is the
account erasure now (`Server/db/erasure.go`, `Server/service/erasure.go`);
the inventory's "Today" column and the drills follow it. **Amended
2026-09-03 (B4-10):** the erasure records a deletion marker in
`data/erasure/markers.sqlite` (`Server/db/markers.go`), replayed against the
database on every open (`Server/internal/app/erasure.go`), and unlinks the
audit history (`audit_log.subject_token`, migration 038). **Amended
2026-09-03 (B4-11):** O9, the retention sweep, exists (`Server/db/retention.go`,
`Server/service/retention.go`, migration 039); it writes `messages`-scoped
markers into the same file.
**Satisfies:** B4 entry-gate item 3, public half ("destructive operations have
private threat and failure models" — the failure models are here; the private
half is described in the last section). Input to HP-4. Seeds the BPR-052
deletion data-lineage checklist, the BPR-053 deletion-marker design and the
BPR-054 retention model.
**Source of truth:** `Server/db/erasure.go`, `Server/db/inventory.go`,
`Server/db/markers.go`, `Server/auth/erasure_key.go`,
`Server/internal/app/erasure.go`, `Server/service/erasure.go`,
`Server/db/retention.go`, `Server/service/retention.go`, `Server/db/account.go`, `Server/db/attachment_queries.go`
and `Server/db/queries/sqlite/attachments.sql`, `Server/db/message_queries.go`
and `Server/db/queries/sqlite/messages.sql`, `Server/db/event_queries.go`,
`Server/ws/event_pruner.go`, `Server/db/admin_queries.go` (`BackupToSafe`,
`CheckBackupIntegrity`), `Server/admin/handlers_backup.go`,
`Server/admin/backup_maintenance.go`, `Server/internal/app/maintenance.go`,
`Server/db/migrate.go`, `Server/auth/totp_encrypt.go`, `Server/migrations/`,
`Server/testdata/snapshots/README.md`, `Server/internal/alphasnap/`.

Every claim below names the function or file that makes it true. If a claim
and the code disagree, the code is right and this document has a bug — file
it like any other.

## What this document is, and is not

It answers three questions, for the operations that destroy or irreversibly
change user data:

1. **How does each operation fail, and what state does it leave?** — the
   failure models, one per operation, on the same five axes.
2. **Which data is attributable to a person, where does it live, and what
   happens to it today when that person deletes their account?** — the
   data-class inventory, which is what B4-9 (erasure), B4-10 (unlinkable
   history and deletion markers) and B4-11 (retention) change, class by
   class.
3. **How are destructive changes rehearsed?** — the drill protocol against
   the alpha-shaped dataset.

It is **not** a threat model that walks attack paths. Failure models are
public: they describe how an operation misbehaves under interruption, a full
disk or a crash, which an operator needs to run the server. Analysis that
would name an exploitable weakness in shipped code stays out of this
repository ([docs/security.md](../security.md), "What stays private") and is
counted, not described, in the last section.

## The five failure axes

Each operation's model answers the same five questions, in this order:

| #   | Axis                    | The question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Interrupted             | The process is killed, or the request context is cancelled, part-way through. What is left?                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A2  | Disk full / I/O error   | A write fails with `ENOSPC` or `EIO`. Which write, and what does the operation report?                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A3  | Transaction vs. file    | The database transaction commits but a filesystem effect (or the reverse) does not. Can the two be reconciled?                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A4  | Concurrent writer       | A second operation on the same subject, row or file runs at the same time. Frames already in the replay pipeline — the ring buffer, the persister's queue, the `member_ban` itself — are purged after the broadcast (`TestErasure_PurgesTheReplayPipeline`); a frame a producer hands the hub after the purge is dropped, and a client resuming from before the purge takes the full ready (`TestErasure_PurgeForcesFullResyncAndDropsLateFrames`); a failed purge is retried from the job (`TestErasureService_ReplayPurgeIsRetriedFromTheJournal`). |
| A5  | Restore over newer data | A backup taken **before** the operation is restored **after** it. Does the operation's effect survive, or revert?                                                                                                                                                                                                                                                                                                                                                                                                                                     |

A row that reads "n/a" means the axis cannot occur for that operation, and
says why.

## Operation catalogue at `aabac60`

### O1 — Account erasure (`DELETE /api/v1/auth/account`, `DELETE /admin/api/users/{id}`)

**What it does (B4-9, since 2026-09-03).** `AuthService.DeleteAccount`
(`Server/service/auth.go`) confirms the caller's password under a per-user
lockout; `ModerationService.EraseUser` (`Server/service/moderation.go`) is
the administrator's route, `ADMINISTRATOR`-gated with the
actor-outranks-target hierarchy and never for the actor's own account. Both
call `ErasureService.Erase` (`Server/service/erasure.go`), which runs
`db.EraseAccount` (`Server/db/erasure.go`) — one transaction on the writer
connection with `PRAGMA secure_delete = ON` for its duration (HP-4 decision
2), restored afterwards, and `PRAGMA wal_checkpoint(TRUNCATE)` after commit:

1. last-admin guard (`deleteAccountAdminGuard`) — the last admin-class account
   cannot be erased (`ErrLastAdmin`);
2. snapshot the subject's DM channels;
3. capture the `stored_as` names of every attachment the subject uploaded
   (the avatar is one) or attached to a message the subject wrote — the file
   list the job row carries;
4. reverse the `read_states.mention_count` bumps the subject's own messages
   made (OC-0294/OC-0293);
5. delete the subject's `rate_lockouts` keys — every key is `<prefix>:<value>`
   with the value the id or the case-folded username, matched on the exact
   suffix;
6. hard-delete, children before parents: `message_mentions` naming the
   subject, the attachment rows from step 3, the subject's `messages` (the
   `messages_ad` trigger drops each row from the FTS index; mentions and
   reactions on those rows cascade), `reactions`, `read_states`, `sessions`,
   `api_tokens` **rows**, the four second-factor tables, `recovery_kits`,
   `recovery_assists` (credentials the subject issued to others keep their
   row with `issued_by = 0`), `voice_states`, `user_blocks` both directions,
   `channel_user_overrides`, `dm_participants`, `dm_open_state`, the
   subject's `invites` (an unused code stops working; who invited whom is
   what the erasure removes), `redeemed_by = NULL` on invites the subject
   redeemed, and the subject's replay `events` rows
   (`db.EventNamesUserPredicate`: a persisted row is the wire envelope, so
   the lookups are `$.payload.user_id`, `$.payload.user.id`,
   `$.payload.from_user_id` and `$.payload.mentions` — HP-4 decision 1);
7. `emoji.uploaded_by` — a server-wide asset — moves to the oldest remaining
   admin-class account, else to the oldest remaining account, else the rows
   are deleted and their files join the job;
8. close the survivor's side of 1:1 DMs and hard-delete DM channels left with
   no participants, unlinking a departed member's attachments first so the
   orphan sweep can reclaim their files (see O3);
9. `DELETE FROM users` — every reference without an `ON DELETE` action
   (`messages.user_id`, `invites.created_by`, `emoji.uploaded_by`) is gone
   by now, so the delete passes with `foreign_keys=ON`;
10. write the `erasure_jobs` row (migration 037): `state = db_done`, `files`
    the JSON list from step 3 (and 7) — the only surviving handle on the blobs.

After commit the runner broadcasts `member_ban` (every client drops the
user; the subject's socket is closed) and then purges the replay pipeline
behind it (`Hub.PurgeUserFromReplay`, the job's first journaled step —
`erasure_jobs.replay_purged`, migration 040 — retried from the journal
until it succeeds): the dispatch loop is drained so the `member_ban` is
sequenced, the event persister is flushed as a barrier so a frame queued
before the erasure is on disk rather than in flight, then under the
sequencing lock the subject joins the hub's tombstone set (a frame naming
them that any producer hands the hub from now on is dropped instead of
sequenced — the request that read its rows before the erasure and reached
the hub after), the replay-purge watermark moves to the current seq (a
client resuming from at or before it takes the full ready instead of a
replay, `mustFullResync`), the ring buffer's frames naming the subject are
dropped (`EventRingBuffer.RemoveWhere`; a replay whose range crosses a
cleared slot returns nil, the full ready again), and the persisted rows
naming the subject are deleted. A reconnect from the cold tier meets the
interior gap and gets the full ready too. Without a hub — the start-up
replay — the persisted rows alone are purged, nothing being buffered yet.
Then the runner removes each listed file through the upload storage (a
missing file counts as removed) and marks the job `done`; a failure of
either half records the attempt and the job is resumed at startup and on
every maintenance tick. The route writes the audit row (`account_deleted`, actor
the subject; the admin route records the actor and `account erased by
administrator`). The log carries the id only, never the username.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1   | The database half is all-or-nothing: one transaction, `defer tx.Rollback()`. A kill before `Commit` leaves the account untouched, sessions included. The file half is journaled: a kill between the commit and the last unlink leaves the job at `db_done` with its file list, and `ErasureService.Resume` (maintenance start-up and every tick) finishes it idempotently (`TestErasureService_RestartResumesTheFileHalf`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A2   | `SQLITE_FULL` on any statement rolls the transaction back — every row, and the job row with it; the service answers 500 and the account is intact and retryable (`TestEraseAccount_FailingStatementRollsBackEverything`). Under WAL a rollback needs no free space beyond the WAL already allocated. A failed unlink (`EIO`, permissions) is recorded on the job with its error and retried each tick (`TestErasureService_FailedRemovalIsRetriedAndMissingFilesCount`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A3   | The subject's files are removed synchronously after the commit, from the job's own list, and the reconciliation pass (O3) catches whatever a crash strands. With no upload storage configured the job waits, listed, until storage exists (the maintenance loop installs its own storage as the fallback).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A4   | A second erasure of the same account finds no row (`ErrNotFound`). A message the subject sends over an already-authenticated socket cannot outlive the erasure: the writer connection serialises it either before the transaction, which then deletes it, or after, when `messages.user_id` has no `users` row to reference and the insert fails the foreign-key check; the `member_ban` broadcast then cuts the socket and later frames are dropped (`TestErasure_MessageOnAuthenticatedSocketDoesNotSurvive`). The audit path is asynchronous (`db.AuditWriter`), so an entry about the subject queued just before the transaction would land raw after its `UPDATE`: the erasure takes the writer's flush barrier before the transaction (`db.FlushAudits`), so the queued entry is on disk with its ids for the `UPDATE` to rewrite, and installs the writer's unlinking rule for the subject once the transaction has committed, while it still holds the writer connection; the store applies the rule at insert time under that connection, so an entry a producer enqueues after the erasure is written unlinked, and a refused erasure changes nothing (`TestErasureService_QueuedAuditEntriesAreUnlinked`, `TestPersistAudits_AppliesTheUnlinkRulesAtInsert`). |
| A5   | Full resurrection from a backup taken before the erasure: it holds the username, password hash, encrypted TOTP secret, every message with content and every row the operation deleted; restoring it (O4) brings the account back exactly as it was, and nothing in the restored file records that an erasure happened (drill D2). The live file's free pages and WAL hold no trace (`secure_delete`, `wal_checkpoint(TRUNCATE)`); the backup does — and since B4-10 that no longer matters: the erasure recorded a deletion marker in `data/erasure/markers.sqlite`, a file the restore does not touch, and the next open replays every marker before anything serves, erasing the resurrected account again (drill D2, `TestHP4_D2_RestoreResurrectsAndTheMarkersReapplyTheErasure`). What remains is the operator's own duty: the marker file and `erasure.key` must survive alongside `totp.key`, or a restore has nothing to replay.                                                                                                                                                                                                                                                                                                                                 |

**What the operation leaves** is the audit history — unlinked (B4-10): every
row the subject appeared in keeps its action, time and position, loses the
id and its free text, and carries HMAC-SHA256 of the id under
`data/erasure.key` — in `subject_token` where the subject was the target, in
`actor_token` where they acted, so a row about two erased subjects keeps
both; the erasure's own `account_deleted` row is written
that way from the start (actor 0 for self-service, the administrator for the
admin route; the target is the token, never the id; no IP) — plus server
logs (id only), backups (defused by the marker on the next open), the
`erasure_jobs` row, which names the subject by id and the files by their
random names, and the deletion marker itself, which names the subject by
token only.

### O2 — Message deletion and moderation purge

**What it does.** `db.DeleteMessage` runs `SoftDeleteMessage`
(`UPDATE messages SET deleted = 1 WHERE id = ? AND deleted = 0`) — the row,
its **content**, `reply_to`, timestamps and attachment rows all stay.
`PurgeChannelMessages` does the same for a batch in one writer transaction.
History and search exclude `deleted = 1` rows at query time
(`SearchMessages` joins `m.deleted = 0`), but because the `messages_au`
trigger fires only `AFTER UPDATE OF content`, the FTS index keeps the
deleted message's terms until the content itself changes. Only O1 blanks
content. Attachments of a deleted message become reclaimable by the sweep
(O3, the OC-0279 branch).

| Axis | Model                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Single statement (or one transaction for a purge): atomic.                                                                                                                                                                                                                 |
| A2   | Statement fails, nothing changes, the caller gets an error.                                                                                                                                                                                                                |
| A3   | n/a — no file effect; the sweep owns the files.                                                                                                                                                                                                                            |
| A4   | The `AND deleted = 0` guard makes a racing second delete a no-op reported as not-found (OC-0284), so the mention-count reversal upstream runs once. An edit racing a delete is guarded the same way since OC-0358.                                                         |
| A5   | The deleted message returns with its content, and the moderation audit row that recorded the deletion returns with it only if the backup postdates that row. A restored server may therefore show a message a moderator removed, with the audit trail of the removal gone. |

**Retention (B4-11) reuses these mechanics but cannot keep the tombstone**:
a retention policy that left the row in place would delete nothing, so the
retention sweep hard-deletes rows — which changes what `reply_to` targets and
the cold-tier replay (O5) can reference. Owner question 4 decides the
exemptions (pins, DMs); this document records the mechanical difference.

### O3 — Orphaned-attachment sweep (maintenance tick, every 15 minutes)

**What it does.** `maintenanceTick` (`Server/internal/app/maintenance.go`)
calls `db.DeleteOrphanedAttachments(cutoff = now − 1h)`, one
`DELETE … RETURNING stored_as` (BUG-132: select and delete are one
statement) over attachment rows that are unlinked (`message_id IS NULL`) or
linked to a soft-deleted message, older than the cutoff, and **not** a live
avatar (`users.avatar` still points at them — `idx_users_avatar`). It then
calls `storage.Delete` for each returned file, logging and continuing on
failure. With no file storage configured the whole step is skipped so the
rows keep the only handle on the blobs.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | The `DELETE … RETURNING` commits first; a kill between it and the `os.Remove` loop strands every not-yet-removed file **with no database row naming it**. Since B4-9 the reconciliation pass on the same tick (`ErasureService.Reconcile`, `Server/service/erasure.go`) lists the upload directory, asks the database which names a row still references (`attachments.stored_as`, `emoji.filename`) and removes the rest — files older than the one-hour upload grace, at most 500 per tick — so a stranding is reclaimed on a later tick instead of lasting forever. |
| A2   | Deleting frees space; the statement itself needs only WAL room. A failed `os.Remove` (`EIO`, permissions) is logged and skipped — same outcome as A1 for that file.                                                                                                                                                                                                                                                                                                                                                                                                    |
| A3   | The transaction-first order is deliberate (a linked-between-select-and-delete race was the alternative, BUG-132), and it is the order that produces the stranded-file class above. The erasure (B4-9) has the inverse guarantee for the subject's files — a journaled, resumable removal — and ships the **reconciliation pass** that turns strandings into a bounded, measurable leak; retention (B4-11) reuses both.                                                                                                                                                 |
| A4   | An upload linking a row while the sweep selects it: closed by `RETURNING`. Two sweeps cannot overlap (one maintenance goroutine, ticks are serial).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A5   | A restored database may hold rows for files the sweep already deleted (they serve 404 and are swept again as orphans) and lack rows for files uploaded after the backup (invisible to the sweep — the same stranded class, reclaimed by the reconciliation pass). Uploads are not in the backup, so restore always desynchronises the two; the reconciliation pass is the recovery.                                                                                                                                                                                    |

### O4 — Backup and restore (`/admin/api/backups`, scheduled backups)

**Backup** (`handleBackup`, `runScheduledBackup`): `BackupToSafe` refuses a
destination outside the configured backup directory or one that already
exists, runs `VACUUM INTO`, removes the partial file on any error (OC-0212),
then `CheckBackupIntegrity` runs `integrity_check` on the result and removes
it on failure; an audit row (`backup_create`) records the name. The scheduled
path judges freshness by the newest `*.db` mtime and prunes by mtime after
`backup_retention` days, never removing the newest file. **Uploads are not
in a backup** (`docs/trust-model.md`, "At rest"), and neither is `totp.key`
(O7).

**Restore** (`handleRestoreBackup`), in order: serialise against update
apply and a pending restart; `integrity_check` the source; write the
`backup_restore` audit row **synchronously, before** the safety copy, so the
row survives inside it; take the `pre_restore_<ts>.db` safety copy (abort,
database untouched, if that fails); broadcast the restart; WAL checkpoint;
close the database; stream the backup over the live file; on copy failure
put the safety copy back; restart the process on every path past the close.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Backup: an interrupted `VACUUM INTO` is removed; a kill between `VACUUM INTO` and `integrity_check` leaves a file the next list shows and the integrity check never ran on — restore re-checks it before use, so it cannot be restored if broken. Restore: a kill **before** the close leaves the live file intact (the restart serves the old data); a kill **during** `copyFile` — a signal, not an error, so the rollback branch does not run — leaves a truncated live database. The declared recovery is manual: the `pre_restore_*` safety copy is on disk and `db.Open` refuses the truncated file on restart, so the operator restores the safety copy by hand. There is no automatic repair for this window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A2   | Backup: `ENOSPC` inside `VACUUM INTO` is the OC-0212 path — partial removed, error returned, no audit row. Restore: `ENOSPC` while taking the safety copy aborts before the live file is touched (fail closed); `ENOSPC` during the main copy triggers the rollback from the safety copy, which itself needs no new space beyond the truncated destination.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A3   | The restore audit row is written to the **old** database only: it survives in the safety copy and is absent from the restored data by construction (`docs/security.md`, "Audit Logging"). Any marker that must survive a restore therefore cannot live in the database file alone — the design constraint B4-10 inherits. Since B4-10 that is where the deletion markers live: `data/erasure/markers.sqlite`, beside the key that names their subjects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A4   | `beginRestartSensitiveOp` serialises restore against update apply and a pending restart; a second restore answers a conflict. Concurrent ordinary writes end at the close: clients see the restart broadcast and reconnect to the restored data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A5   | This _is_ the operation. Everything after the backup's `VACUUM INTO` reverts: accounts created (their sessions now name users who do not exist), messages sent, deletions and erasures (O1 — the account returns), bans, setting changes, migrations applied later than the backup's schema (the next start re-applies them, `MigrateFS` being forward-only and idempotent per recorded filename). Uploads do not revert, so attachment rows and files desynchronise both ways (O3 A5). The B4-10 requirement is exact: a restore re-applies every deletion marker recorded after the backup's creation before the server serves data, and the markers live where the restore cannot overwrite them. Since B4-10 the `erasure-markers` start-up stage does exactly that: after the migrations and before the hub, the router or any listener, every marker whose subject is present in the database is erased again (`openMarkers`, `MarkerStore.ReplayAccounts`), the files included, with an `account_erasure_replayed` audit row carrying the token. Three rules follow from the restore being what the markers defend against. A marker still `pending` from a crash is applied like a recorded one: the main database cannot say whether its transaction committed, since the restore reverts a commit, and the request behind it was authorised before it was written (`TestErasureService_PendingMarkerSurvivesACrashAndARestore`). The last-admin guard does not apply at replay: it is a live-operation rule the erasure passed when it ran, and a backup from before the handover to another administrator would otherwise keep the subject for good — the replay erases them and says loudly that no admin-class account remains, and first-run setup stays closed behind the durable `setup_completed` flag rather than reopening on the emptied table (migration 043, `docs/security.md`) — and since that flag lives in the database a restore overwrites, an account marker closes it at start-up too, the marker file being the only evidence that survives a restore of a backup taken before the first owner existed (`db.ReplayEraseAccount`, `TestErasureService_ReplayErasesTheLastAdminOfAnOlderBackup`). And the id counters are raised first to the floors the markers recorded (`sequence_floors`, `db.RaiseSequences`; a marker file from before the floors existed has its floor recovered from the ids its own markers name, found by hashing candidates against the tokens, since neither the counter on a restored database nor a floor row a later erasure wrote need cover them; the recovery runs until it is recorded as complete, and a marker beyond the probe's reach fails start-up rather than leaving a floor that only looks safe): a restore rolls `sqlite_sequence` back, and the next account would otherwise inherit an erased id and, with it, the marker's token (`TestErasureService_ReplayMarkersRaisesTheSequenceFloors`). |

### O5 — Replay-event retention (`events` table)

**What it does.** The `EventPersister` writes every sequenced broadcast
(payload included — message content, user ids) to `events` for the
cold-tier reconnect replay ([websocket.md](websocket.md)); `StartEventPruner`
(`Server/ws/event_pruner.go`) deletes rows older than
`event_persistence.retention_hours` (default 24) every
`pruner_interval_minutes` (default 60) via `PruneEventsOlderThan`, a single
`DELETE`.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1   | Single statement: atomic. The persister's own batches are one transaction each (`persistEventsTx`).                                                                                                                                                                                                                                                                                  |
| A2   | The prune fails and is retried next interval; the persister retries a failed batch and then logs the events it lost (`event persister: flush lost events`) — replay degrades to the warm tier for that gap.                                                                                                                                                                          |
| A3   | n/a.                                                                                                                                                                                                                                                                                                                                                                                 |
| A4   | The pruner deletes the **oldest** rows by `created_at` with no coordination on `seq`, so a replay racing a prune can find a surviving suffix behind a hole; `handleReconnect` (`Server/ws/replay.go`) probes the store's oldest surviving `seq` unfiltered and forces a full `ready` when the client's `last_seq` predates it, rather than presenting the hole as a complete resume. |
| A5   | The restored table replays whatever the backup held; the hub seeds its sequence from `MAX(events.seq)` so sequences stay monotonic.                                                                                                                                                                                                                                                  |

**Why it is a data class.** Neither O1 nor O2 touches `events`: for up to
the retention window, a reconnecting client can receive the `chat_message`
frame of a message that has since been deleted or whose author has been
erased — followed by the delete frame, but the content crosses the wire. The
erasure target (B4-9) purges the subject's events in the erasure transaction
— decided at HP-4 (2026-09-02), after drill D4 showed the window is real.

### O6 — Session sweeps and revocation

`DeleteExpiredSessions` (maintenance tick), the 25-session cap eviction in
`CreateSession` (H-6), `DeleteOtherSessions` on password and 2FA changes (one
bounded retry, then a partial-success `warning` the client must surface —
OC-0314) and the per-session and future all-sessions revocations (B4-7). All
are single statements; every axis is trivial except A5: a restore revives
revoked sessions **only** if their rows were in the backup and have not
expired — session rows are hashed tokens with a 30-day expiry, so a revived
row is usable again by a client that still holds the token. Sign-out-
everywhere after a restore is the operator's recovery; B4-10's marker design
records whether session revocations are marker-worthy (they are not:
expiry bounds them).

### O7 — TOTP key lifecycle (`data/totp.key` or `OWNCORD_TOTP_KEY`)

**What it does.** `LoadOrGenerateTOTPKey` (`Server/auth/totp_encrypt.go`)
takes the environment variable if set, else reads the key file, else
generates a key and writes it with `os.WriteFile` (`O_TRUNC`). Every stored
`users.totp_secret` is AES-GCM ciphertext under this key.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | A kill during the first-run `WriteFile` leaves a partial hex file; the next start refuses it (`invalid hex` / wrong length — fail closed, no regeneration) and the operator deletes the partial file to let generation run again. Nothing was encrypted under a partial key, so nothing is lost.                                                          |
| A2   | Generation fails with the write error; the server does not start.                                                                                                                                                                                                                                                                                         |
| A3   | The key is a file the database depends on but the backup (O4) does not contain. **A database restored onto a machine without the matching `totp.key` cannot decrypt any second factor**: every 2FA login fails closed. Operators must back up `totp.key` (or set `OWNCORD_TOTP_KEY`) beside the database; the operations documentation carries this rule. |
| A4   | Two processes on one data directory is outside the supported model (single instance, [system-overview.md](system-overview.md)).                                                                                                                                                                                                                           |
| A5   | Restoring a database from before a user's enrolment removes their second factor (weaker, expected). Restoring a database that was encrypted under a **different** key (another install's backup) makes every secret undecryptable — same recovery as A3.                                                                                                  |

**The known defect.** OC-0321: the read branch handles only success, so a
read _error_ — `EACCES` after a permissions change, `EIO`, a dangling
symlink — is treated as "no key yet" and a fresh key is written over the
file, orphaning every stored secret with no recovery. The B4-3 target is
generation on confirmed non-existence only, every other error failing
closed with the file untouched, and an atomic write (temp file + rename) so
A1 cannot even produce a partial file.

### O8 — Recovery-secret rotation (B4-5 kit landed 2026-09-02; B4-6 credentials pending)

Written as the model the implementation must satisfy. B4-5's kit satisfies
it as follows: A1 and A2 by `DB.RedeemRecoveryKit` (consume, password,
sessions and the audit row in one transaction, rolled back as a whole); A3
by `GET /api/v1/users/me/recovery-kit` (the account's own "enrolled or
not"); A4 by the conditional consume (`used_at IS NULL`, affected-row count)
and by enrolment's upsert leaving exactly one verifier; `DeleteAccount`
purges the row (class 5).

| Axis | Requirement                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Consuming a recovery kit, resetting the password, revoking every session and writing the audit row commit in **one** transaction: a kill leaves either the old kit valid and the old sessions live, or the new state complete — never a reset password beside live old sessions.                                    |
| A2   | The transaction rolls back; the kit is not consumed; the user retries.                                                                                                                                                                                                                                              |
| A3   | Enrolment generates the kit client-side and stores only a verifier server-side; a lost response means the user holds a kit the server never stored. The account's own state must make that visible ("no recovery kit enrolled") so the user re-enrols rather than trusting a dead kit.                              |
| A4   | Two concurrent redemptions of one kit admit at most one (the consume is a conditional `UPDATE … WHERE used_at IS NULL` whose affected-row count decides); two concurrent enrolments leave exactly one verifier valid.                                                                                               |
| A5   | A restore reverts the verifier to the pre-rotation one — the same wholesale reversion the password hash undergoes. The declared position is consistency with O4 A5: restore reverts credentials as a set, and the disclosure says so; deletion markers cover **erasure**, not rotation. HP-4 confirms or overrides. |

### O9 — Retention sweep (maintenance tick; B4-11, since 2026-09-03)

**What it does.** Indefinite by default: `settings.retention_days` is `0`
on a fresh and on an upgraded server, and a channel policy exists only
where an administrator wrote one (`channel_retention`, migration 039). Each
maintenance tick `RetentionService.Tick` (`Server/service/retention.go`)
computes the effective window per non-DM channel — the channel override
where present, in either direction (`0` = keep forever), else the server
window — and for each channel with a window calls `DB.SweepRetention` in
batches of 500 under a 5,000-message budget per tick: the oldest messages
older than `now − window` (UTC, `messages.timestamp` compared bytewise;
pinned messages exempt; tombstones included), each batch one writer
transaction that reverses the mention counts those messages raised
(OC-0294), deletes their attachment rows and returns the `stored_as`
names, and deletes the rows (the FTS trigger drops the index entries;
`reply_to` on later messages becomes NULL). The run is journaled in
`retention_runs` — counts and the file list, before any unlink — then the
files are removed through the upload storage (a missing file counts as
removed) and the run is finished. Each batch's frames leave the replay
pipeline as well (`Hub.PurgeMessagesFromReplay`): the dispatch loop is
drained, the persister flushed, the ring buffer's copies dropped, the
`events` rows deleted (`DB.DeleteEventsForMessages`, the message-family
frames — `chat_message`, `chat_edited`, `chat_deleted`, `chat_bulk_deleted`,
`reaction_update` — naming those ids), and the ids become the hub's tombstone
set until the next sweep, so a frame about a swept message that a producer
hands the hub after the purge is dropped; the ids are journaled in
`retention_runs.purge_pending` before the purge and cleared after it, so a
purge that fails or is interrupted is retried on the next tick. A client
resuming across the holes falls to the full ready, which no longer holds
the messages. A channel swept clean to its cutoff gets a
`messages`-scoped deletion marker (`MarkerStore.RecordMessagesSweep`, the
cutoff only ever moving forward); a budgeted channel records nothing and
continues next tick. At start-up the `erasure-markers` stage replays those
markers too: a restored backup holding messages past a channel's recorded
cutoff loses them again before anything serves, their persisted replay rows
with them (nothing is buffered before the hub exists); the marker carries
the `channels` sequence as a floor, as the account markers carry `users`. Policy changes are audited
(`retention_policy_change` with the old and new server window,
`channel_retention_change` per channel); `GET /admin/api/retention/preview`
is the effect preview. No hold mechanism exists (owner decision 5):
retention is absolute. Retention deletions write no `account`-scoped marker
— they are policy, not subject erasure — which is why class 8's "Today" and
the marker file's `scope` column keep the two apart.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Rows go per batch, each its own transaction; a kill between batches leaves earlier batches gone and later ones for the next tick, which recomputes the same cutoff. A kill between the commit and the unlinks leaves the run's file list journaled: `resumeRuns` on the next tick removes them (`TestRetention_BudgetAndResume`).                                             |
| A2   | `SQLITE_FULL` in a batch rolls that batch back and ends the tick; deleting frees space, so the next tick's smaller batches proceed. A failed unlink is recorded on the run (`last_error`) and retried next tick.                                                                                                                                                              |
| A3   | The files follow the journal, never a directory listing; the erasure's reconciliation pass (O3 A3) catches anything a crash strands anyway.                                                                                                                                                                                                                                   |
| A4   | The tick holds one mutex: it cannot overlap itself or the start-up replay. A message arriving at the boundary is compared against the same UTC cutoff the batch used; the exactly-at-cutoff message stays (`timestamp < cutoff`), `TestSweepRetention_RemovesOnlyPastWindowUnpinned`.                                                                                         |
| A5   | A restored backup brings deleted messages back — and the `messages` marker per channel, kept outside the restored file, sweeps them again to the recorded cutoff on the next open (`TestRetention_ReplayMarkersResweepsARestoredBackup`). A backup that predates the policy itself restores the policy-less state; the marker still carries the cutoff the sweep had reached. |

## Data-class inventory at `aabac60` (Today column as of B4-9)

Every class of stored data that is attributable to a person, with today's
behaviour under O1 — the erasure, since B4-9 — and the B4 step that changes
it. `db.SubjectInventory` (`Server/db/inventory.go`) is this table as
queries; the lineage checklist (`TestHP4_D1_ErasureLeavesNoClass`,
`TestEraseAccount_EveryInventoryClassIsZero`,
`TestErasureService_LineageChecklistOnAlphaSnapshot`) asserts zero in every
class but 21 after an erasure. "Attributable via" is
the column or content that links the class to the subject. "Hard-delete
cascade" is what `ON DELETE` would do if the `users` row were deleted
(`Server/migrations/`), for B4-9's design.

| #   | Class                           | Where                                                                                                                                                                                                                                        | Attributable via                                                                                           | Today, after O1                                                                                                                                                                                                                                               | Hard-delete cascade               | B4 target                                                                                                                                                                                                                                        |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Identity row                    | `users`                                                                                                                                                                                                                                      | `id`, `username`, profile fields                                                                           | Row deleted (B4-9).                                                                                                                                                                                                                                           | —                                 | Done (B4-9): hard delete; the username is free again.                                                                                                                                                                                            |
| 2   | Sessions                        | `sessions`                                                                                                                                                                                                                                   | `user_id`, `device`, `ip_address`                                                                          | Deleted.                                                                                                                                                                                                                                                      | CASCADE                           | Done. B4-7 adds sign-out-everywhere for the living.                                                                                                                                                                                              |
| 3   | API tokens                      | `api_tokens`                                                                                                                                                                                                                                 | `user_id`, `label`                                                                                         | Rows deleted (B4-9).                                                                                                                                                                                                                                          | CASCADE                           | Done (B4-9).                                                                                                                                                                                                                                     |
| 4   | Second-factor state             | `users.totp_secret`; `partial_auth_challenges`, `pending_totp_enrollments`, `totp_used_codes`, `totp_recovery_codes` (migration 032, B4-3)                                                                                                   | `user_id`                                                                                                  | Secret cleared; the subject's rows in the four B4-3 tables are deleted in the same transaction (`db.DeleteAccount`); expired rows are swept by the maintenance tick.                                                                                          | CASCADE                           | Done (B4-3): the tables joined the erasure list with their migration; recovery codes are also cleared when 2FA is disabled.                                                                                                                      |
| 5   | Recovery secrets                | `recovery_kits` (argon2id verifier, created/used timestamps — B4-5); `recovery_assists` (argon2id verifier of an owner-issued credential, issuer, verification wording, created/expires — B4-6; deleted on redemption, replaced on re-issue) | `user_id`                                                                                                  | Deleted in the transaction; a credential the subject issued to another account keeps its row with `issued_by = 0`.                                                                                                                                            | CASCADE                           | Done (B4-5/B4-6/B4-9).                                                                                                                                                                                                                           |
| 6   | Rate-limit state                | `rate_lockouts` (keys such as `login_user_lock:<username>`, `delete_lock:<id>`), plus in-memory windows                                                                                                                                      | key text                                                                                                   | The subject's keys (by id and by case-folded username, exact suffix) are deleted in the transaction; in-memory windows expire within their window (≤ 15 min).                                                                                                 | —                                 | Done (B4-9).                                                                                                                                                                                                                                     |
| 7   | Login attempts                  | `login_attempts`                                                                                                                                                                                                                             | `ip_address`, `username`                                                                                   | **No code writes this table** at `aabac60` (only the generated model and the snapshot scrub name it) — it is empty on every server.                                                                                                                           | —                                 | Nothing to erase. Dropping the table is a housekeeping migration outside B4; recorded here so nobody plans erasure for an empty table.                                                                                                           |
| 8   | Messages                        | `messages` (`content`, `reply_to`, `timestamp`, `edited_at`, `pinned`, `mentions_everyone`), `messages_fts`                                                                                                                                  | `user_id`; content                                                                                         | Hard-deleted rows (owner decision 9); the `messages_ad` trigger drops the FTS entries, with FTS5 secure-delete for the transaction. Channel history shows nothing where they were; replies to them keep `reply_to = NULL`.                                    | RESTRICT (NOT NULL, no action)    | Done (B4-9). B4-11: past-window messages go the same way (O9), pinned exempt, DMs never.                                                                                                                                                         |
| 9   | Mentions                        | `message_mentions`                                                                                                                                                                                                                           | `mentioned_user_id`; author via the message                                                                | Deleted where `mentioned_user_id` is the subject; the author-side rows go with the messages.                                                                                                                                                                  | CASCADE                           | Done (B4-9).                                                                                                                                                                                                                                     |
| 10  | Reactions                       | `reactions`                                                                                                                                                                                                                                  | `user_id`                                                                                                  | Deleted.                                                                                                                                                                                                                                                      | CASCADE                           | Done.                                                                                                                                                                                                                                            |
| 11  | Read states                     | `read_states`                                                                                                                                                                                                                                | `user_id`                                                                                                  | Deleted (after the mention-count reversal).                                                                                                                                                                                                                   | CASCADE                           | Done.                                                                                                                                                                                                                                            |
| 12  | Attachments and files           | `attachments` (`uploader_id`, `filename`, `stored_as`, `size`, dimensions), files under `upload.storage_dir`                                                                                                                                 | `uploader_id`; the message                                                                                 | Rows deleted in the transaction (uploaded by the subject, or attached to the subject's messages); the `stored_as` names are journaled in `erasure_jobs` and the files removed after commit, resumed until gone; the reconciliation pass catches strandings.   | uploader_id: no action (nullable) | Done (B4-9). B4-11: the retention sweep journals and removes files the same way (`retention_runs`).                                                                                                                                              |
| 13  | Avatar                          | `users.avatar` → an unlinked `attachments` row + file                                                                                                                                                                                        | `users.avatar`, `uploader_id`                                                                              | Row and file go with class 12 (the row goes with the `users` row).                                                                                                                                                                                            | Done (B4-9).                      | Done (B4-9).                                                                                                                                                                                                                                     |
| 14  | DM membership and state         | `dm_participants`, `dm_open_state`, DM `channels`                                                                                                                                                                                            | `user_id`                                                                                                  | Deleted; empty DM channels removed; the survivor's open state closed.                                                                                                                                                                                         | CASCADE                           | Done. (Group-DM messages of the subject are class 8.)                                                                                                                                                                                            |
| 15  | Invites                         | `invites`                                                                                                                                                                                                                                    | `created_by`, `redeemed_by`                                                                                | The subject's invites are deleted (unused codes stop working, redeemed ones lose the "invited by" link); `redeemed_by` is cleared where the subject redeemed.                                                                                                 | RESTRICT                          | Done (B4-9): deletion rather than a system-actor `created_by`, because `created_by` is `NOT NULL REFERENCES users(id)` and no user 0 exists.                                                                                                     |
| 16  | Emoji                           | `emoji`                                                                                                                                                                                                                                      | `uploaded_by`                                                                                              | `uploaded_by` moves to the oldest remaining admin-class account (else the oldest remaining account); with nobody left the rows are deleted and the files join the job. The asset stays.                                                                       | RESTRICT                          | Done (B4-9): an heir rather than actor 0, because `uploaded_by` is `NOT NULL REFERENCES users(id)`.                                                                                                                                              |
| 17  | Blocks                          | `user_blocks`                                                                                                                                                                                                                                | `blocker_id`, `blocked_id`                                                                                 | Deleted, both directions.                                                                                                                                                                                                                                     | CASCADE                           | Done (B4-9).                                                                                                                                                                                                                                     |
| 18  | Per-user channel overrides      | `channel_user_overrides`                                                                                                                                                                                                                     | `user_id`                                                                                                  | Deleted.                                                                                                                                                                                                                                                      | CASCADE                           | Done (B4-9).                                                                                                                                                                                                                                     |
| 19  | Voice state                     | `voice_states`                                                                                                                                                                                                                               | `user_id`                                                                                                  | Deleted in the transaction; the hub also clears it on the `member_ban` disconnect.                                                                                                                                                                            | CASCADE                           | Done (B4-9).                                                                                                                                                                                                                                     |
| 20  | Replay events                   | `events` (payload blobs)                                                                                                                                                                                                                     | user ids and content inside payloads                                                                       | The subject's rows (`db.EventNamesUserPredicate` over the envelope's `payload`) are deleted in the transaction, and again after the `member_ban` broadcast with the persister flushed and the ring buffer purged (HP-4 decision 1).                           | —                                 | Done (B4-9); the pruner still bounds everyone else's.                                                                                                                                                                                            |
| 20a | Channel retention policy setter | `channel_retention.updated_by` (migration 039, B4-11)                                                                                                                                                                                        | `updated_by`                                                                                               | `updated_by` is cleared to the system actor id (`0`) in the transaction, mirroring `recovery_assists.issued_by`; the policy itself (`days`) stays in effect — only the link to who set it is cut.                                                             | — (no FK)                         | Done (OC-0392): `channel_retention` postdated the B4-9 inventory, so the original sweep never listed it; now covered by the same erasure statement loop and inventory class as every other no-FK id.                                             |
| 21  | Audit history                   | `audit_log` (`actor_id`, `target_id`, free-text `detail`)                                                                                                                                                                                    | ids; usernames and IPs inside `detail`                                                                     | Unlinked by the erasure (B4-10): rows the subject appears in keep action, time and order; `actor_id`/`target_id` become 0, `detail` is cleared, `subject_token` carries the marker's token; the `account_deleted` row is written unlinked and without the IP. | — (no FK since 003)               | Done (B4-10): the residue is the token, which names nobody without `erasure.key`.                                                                                                                                                                |
| 22  | Server logs                     | `slog` output (usernames, ids, IPs at Info; e.g. O1 logs `username=`)                                                                                                                                                                        | text                                                                                                       | The erasure path logs the id only; retention is the operator's (B4-8's diagnostics inventory).                                                                                                                                                                | —                                 | Done (B4-9).                                                                                                                                                                                                                                     |
| 23  | Plugin storage                  | `plugin_kv`                                                                                                                                                                                                                                  | whatever a plugin stored                                                                                   | Untouched; opaque to the server.                                                                                                                                                                                                                              | —                                 | Out of B4 (plugins are off by default and compiled out of releases — [plugins.md](plugins.md)); recorded so the gap is a decision, not an oversight.                                                                                             |
| 24  | Backups                         | `*.db` under `backup.dir`, each a full copy of classes 1–21 as of its time                                                                                                                                                                   | everything                                                                                                 | Untouched; restorable (O4 A5) — and defused: the next open after a restore replays the deletion markers and erases the subject again.                                                                                                                         | —                                 | Done (B4-10).                                                                                                                                                                                                                                    |
| 25  | Free pages and WAL              | the SQLite file's free list and `-wal`                                                                                                                                                                                                       | content of updated/deleted rows                                                                            | The erasure connection runs `PRAGMA secure_delete = ON` for its transaction (freed content zeroed) and `wal_checkpoint(TRUNCATE)` after commit; other writes keep the default.                                                                                | —                                 | Done (B4-9, HP-4 decision 2).                                                                                                                                                                                                                    |
| 26  | TOTP encryption key             | `data/totp.key` / `OWNCORD_TOTP_KEY`                                                                                                                                                                                                         | not per user — it is what makes class 4 readable                                                           | Untouched (correct).                                                                                                                                                                                                                                          | —                                 | B4-3: fail-closed load, atomic write; operators back it up beside the database (O7 A3).                                                                                                                                                          |
| 27  | Erasure marker key and markers  | `data/erasure.key` / `OWNCORD_ERASURE_KEY`; `data/erasure/markers.sqlite`                                                                                                                                                                    | the key is not per user — it is what makes a marker recognisable; a marker names its subject by token only | Untouched by the erasure (correct); the marker is what the erasure adds.                                                                                                                                                                                      | —                                 | B4-10: fail-closed load, atomic write, one HMAC key for every marker; operators back up both beside the database, or a restore has nothing to replay (O4 A5). B4-11 adds the `messages`-scoped markers (one per swept channel) to the same file. |

The generated lineage checklist B4-9 owes BPR-052 is this table turned into
SQL: for a subject id, one count per class 1–21, asserted zero after
erasure. The appendix carries the first version of those queries so HP-4's
baseline drill can run them by hand.

## Drill protocol

HP-4 and every B4-9, B4-10 and B4-11 test that destroys data runs against a
**copy** of the alpha-shaped dataset, never against ad-hoc fixtures and never
against the tracked file (roadmap workstream 13).

1. **Source.** `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite`, whose
   README records its shape (100 users, 12 channels + 40 DMs, 20,000
   messages, 300 attachment rows, 500 reactions, 30 invites) and the rule
   that it is regenerated only deliberately.
2. **Copy, never open in place.** `alphasnap.Copy(dir)`
   (`Server/internal/alphasnap`) resolves the tracked file from the module
   tree and writes a private copy into a directory the test owns
   (`t.TempDir()`), returning the path; open it with `db.Open` and run
   `db.Migrate` — the canary's own shape (`db/alpha_snapshot_test.go`). The
   copy is a plain byte copy: no connection is ever opened on the source, so
   it cannot gain a `-wal`/`-shm` sidecar or change a byte.
3. **Files.** The snapshot carries attachment **rows** only. A drill that
   needs file reclamation to be observable materialises a placeholder file
   per `stored_as` of the subject's rows in a temporary storage directory
   (size per the row), then points `storage.New` at it
   (`TestErasureService_LineageChecklistOnAlphaSnapshot` is the worked
   example). B6's upgrade
   rehearsal seeds a full uploads directory; B4 drills seed only what the
   subject touches.
4. **Inventory before and after.** Run the appendix queries for the subject
   before the operation and after it, and count the files in the temporary
   storage directory both times. The diff is the drill's evidence, pasted
   into the scorecard or the step's evidence block.
5. **Invariants after every drill.** `git status` shows the tracked snapshot
   unchanged; `TestAlphaSnapshotMigratesOnHead` and
   `TestAlphaProfileByteIdentical` stay green.

**HP-4 baseline drills** (written before B4-9 against the anonymising
deletion; D1 and D4 were rewritten for the erasure when it landed), on
copies, each recorded with its before/after inventory:

- **D1 — O1 on a member with everything.** Pick the member with the most
  messages, attachments, reactions and DM channels; run `db.EraseAccount`;
  expect zero in every inventory class except 21 (the B4-9 lineage
  checklist), and one journaled file per attachment row. Before B4-9 the
  expectation was the anonymising deletion's leftovers (classes 8, 9, 12,
  15, 16, 17, 18, 20, 21), recorded in the HP-4 scorecard.
- **D2 — Resurrection, then the B4-10 post-restore proof.** Back up the copy
  (`BackupToSafe`), erase the subject with a marker, restore the backup over
  the copy; expect the account back in full (the negative control HP-4
  recorded), then replay the markers and expect zero in every class again,
  with the subject's audit rows unlinked by token.
- **D3 — Restore over newer data.** Back up, insert messages and a new user,
  restore; expect them gone and the schema re-migrated forward on the next
  open.
- **D4 — The replay window.** Insert `events` rows for the subject and one
  for another user (the snapshot has none), run D1, expect the subject's rows
  gone and the other user's kept — HP-4 decision 1 made visible. Before B4-9
  the drill showed the rows surviving until the pruner's cutoff.
- **D5 — Stranded files.** Seed placeholder files for a soft-deleted
  message's attachments, run `DeleteOrphanedAttachments`, then delete one
  returned file before the removal loop would; expect the O3 A1 class — a
  file with no row — so the reconciliation pass has a fixture.

The five drills are implemented as `TestHP4_D1`…`TestHP4_D5` in
`Server/db/hp4_drills_test.go` (HP-4, 2026-09-02); the scorecard pastes their
inventories.

**The rollback rehearsal** (B4 exit, 2026-09-03) uses the same protocol for
the other direction. The snapshot sits at migration `031`, so migrating a
copy to HEAD is exactly the B4 delta and running `Server/rollback/` back down
has to land on the snapshot's own schema — asserted on the schema, the
applied-migration list, `settings` and the row counts of seven data classes,
then re-migrated forward to check a rolled-back database is one a server can
start on. `TestMigrationRollbackRehearsalOnAlphaSnapshot` and
`TestMarkerFileRollback` in `Server/db/rollback_rehearsal_test.go`; the B4
exit section of the HP-4 scorecard has the report.

## The private half

Analysis that would name an exploitable weakness in shipped code is not in
this repository; it goes to a private GitHub Security Advisory with one
opaque public owner in the
[issue register](../plans/repo-health-issue-register-2026-08-23.md),
per [docs/security.md](../security.md).

At `aabac60`, writing this document needed **no new advisory**. Every gap it
records is one of: already public (OC-0321 in the findings ledger; the
deletion limits `docs/trust-model.md` discloses), a completeness requirement
on an operation B4 has not built yet (stated above as the requirement), or
an operational failure mode (stranded files, a truncated database during a
killed restore) that an operator needs to know and no attacker can trigger
without already owning the host. One pre-existing private item touches these
operations: **SEC-01** (bounded admission of expensive authentication work),
which B4-4 closes through its advisory; its public closure line is in the
register.

The rule for the steps that follow: a weakness discovered in shipped code
while building B4-9, B4-10 or B4-11 goes to an advisory first, and the pull
request describes the control it adds, never the gap it closes.

## Appendix — subject inventory queries

For a subject `:uid` (bind the id; `:uname` is the username **before**
erasure, for the lockout keys). One row per class that can hold the subject;
every count must be zero after erasure — class 21 included since B4-10,
because it counts rows that still carry the id and the unlinked rows do
not. `db.SubjectInventory` is this list as code and `DB.TakeInventory` runs
it; keep the two in step.

```sql
-- 1 identity row (0 after the erasure's hard delete)
SELECT COUNT(*) FROM users WHERE id = :uid;
-- 2 sessions
SELECT COUNT(*) FROM sessions WHERE user_id = :uid;
-- 3 api tokens (rows, not just active ones)
SELECT COUNT(*) FROM api_tokens WHERE user_id = :uid;
-- 4 second factor: the secret, and the four B4-3 tables
SELECT COUNT(*) FROM users WHERE id = :uid AND totp_secret IS NOT NULL;
SELECT (SELECT COUNT(*) FROM partial_auth_challenges WHERE user_id = :uid)
     + (SELECT COUNT(*) FROM pending_totp_enrollments WHERE user_id = :uid)
     + (SELECT COUNT(*) FROM totp_used_codes WHERE user_id = :uid)
     + (SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = :uid);
-- 5 recovery secrets (the kit, and assisted credentials for or by the subject)
SELECT (SELECT COUNT(*) FROM recovery_kits WHERE user_id = :uid)
     + (SELECT COUNT(*) FROM recovery_assists WHERE user_id = :uid OR issued_by = :uid);
-- 6 rate-limit keys
SELECT COUNT(*) FROM rate_lockouts WHERE key LIKE '%:' || :uname OR key LIKE '%:' || :uid;
-- 7 login attempts (always 0 at aabac60 — no writer)
SELECT COUNT(*) FROM login_attempts WHERE username = :uname;
-- 8 messages: attributed rows, rows with content, FTS hits
SELECT COUNT(*) FROM messages WHERE user_id = :uid;
SELECT COUNT(*) FROM messages WHERE user_id = :uid AND content <> '';
-- 9 mentions naming the subject
SELECT COUNT(*) FROM message_mentions WHERE mentioned_user_id = :uid;
-- 10 reactions
SELECT COUNT(*) FROM reactions WHERE user_id = :uid;
-- 11 read states
SELECT COUNT(*) FROM read_states WHERE user_id = :uid;
-- 12/13 attachments the subject uploaded (rows; files are counted on disk)
SELECT COUNT(*) FROM attachments WHERE uploader_id = :uid;
-- 14 DM membership and open state
SELECT COUNT(*) FROM dm_participants WHERE user_id = :uid;
SELECT COUNT(*) FROM dm_open_state WHERE user_id = :uid;
-- 15 invites
SELECT COUNT(*) FROM invites WHERE created_by = :uid OR redeemed_by = :uid;
-- 16 emoji
SELECT COUNT(*) FROM emoji WHERE uploaded_by = :uid;
-- 17 blocks, both directions
SELECT COUNT(*) FROM user_blocks WHERE blocker_id = :uid OR blocked_id = :uid;
-- 18 per-user channel overrides
SELECT COUNT(*) FROM channel_user_overrides WHERE user_id = :uid;
-- 19 voice state
SELECT COUNT(*) FROM voice_states WHERE user_id = :uid;
-- 20 replay events naming the subject: a row is the wire envelope the hub
--    sent ({"seq":…,"type":…,"payload":{…}}), so every id sits under
--    payload — "user_id" on state frames, "user":{"id":…} on message
--    frames, "mentions" on chat frames, "from_user_id" on a relayed E2EE
--    offer (docs/protocol.md). db.EventNamesUserPredicate is this test as
--    code; json_extract is SQLite's built-in JSON1.
SELECT COUNT(*) FROM events
 WHERE json_extract(payload, '$.payload.user_id') = :uid
    OR json_extract(payload, '$.payload.user.id') = :uid
    OR json_extract(payload, '$.payload.from_user_id') = :uid
    OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.mentions') WHERE value = :uid);
-- 21 audit rows still naming the subject by id (0 after B4-10's unlinking;
--    the rows survive with subject_token = HMAC(erasure.key, :uid))
SELECT COUNT(*) FROM audit_log WHERE actor_id = :uid OR (target_type = 'user' AND target_id = :uid);
```

Classes 22–26 (logs, plugin storage, backups, free pages, the key file) are
not rows and are checked by the drill's file-level steps.
