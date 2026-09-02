# Data lifecycle — destructive operations, their failure models, and every user-attributable data class

**Kind:** reference and design record. **Written:** 2026-09-01 (B4-0),
verified against `dev` @ `aabac60`.
**Satisfies:** B4 entry-gate item 3, public half ("destructive operations have
private threat and failure models" — the failure models are here; the private
half is described in the last section). Input to HP-4. Seeds the BPR-052
deletion data-lineage checklist, the BPR-053 deletion-marker design and the
BPR-054 retention model.
**Source of truth:** `Server/db/account.go`, `Server/db/attachment_queries.go`
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

| #   | Axis                    | The question                                                                                                      |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A1  | Interrupted             | The process is killed, or the request context is cancelled, part-way through. What is left?                       |
| A2  | Disk full / I/O error   | A write fails with `ENOSPC` or `EIO`. Which write, and what does the operation report?                            |
| A3  | Transaction vs. file    | The database transaction commits but a filesystem effect (or the reverse) does not. Can the two be reconciled?    |
| A4  | Concurrent writer       | A second operation on the same subject, row or file runs at the same time.                                        |
| A5  | Restore over newer data | A backup taken **before** the operation is restored **after** it. Does the operation's effect survive, or revert? |

A row that reads "n/a" means the axis cannot occur for that operation, and
says why.

## Operation catalogue at `aabac60`

### O1 — Account deletion (`DELETE /api/v1/auth/account`)

**What it does.** `AuthService.DeleteAccount` (`Server/service/auth.go`)
confirms the caller's password under a per-user lockout, then calls
`db.DeleteAccount` (`Server/db/account.go`), one writer transaction:

1. last-admin guard (`deleteAccountAdminGuard`) — the last admin-class account
   cannot be deleted;
2. snapshot the user's DM channels;
3. `DELETE` the user's `sessions`, `dm_participants`, `dm_open_state`,
   `reactions`, `read_states`; set `revoked_at` on their `api_tokens`;
4. close the survivor's side of 1:1 DMs and hard-delete DM channels left with
   no participants (unlinking their attachments first so the orphan sweep
   can reclaim the files — see O3);
5. reverse the `read_states.mention_count` bumps the user's own messages made
   (OC-0294);
6. soft-delete every message the user authored: `deleted = 1, content = ''`
   — the content change fires the `messages_au` FTS trigger (migration 019),
   so the search index drops the text too;
7. anonymise the `users` row (`anonymiseUser`): `username → [deleted-<id>]`
   (random suffix on collision), `password = ''`, `avatar`, `totp_secret`,
   `display_name`, `about`, `custom_status`, `identity_public_key → NULL`,
   `status = offline`, `banned = 1`, `ban_expires = NULL`.

After commit the service writes an audit row (`account_deleted`, detail
`account self-deleted from <ip>`) and broadcasts `member_ban` so connected
clients drop the user.

**The row survives on purpose.** `messages.user_id`, `invites.created_by`,
`emoji.uploaded_by` and `attachments.uploader_id` reference `users(id)` with
no `ON DELETE` action (`Server/migrations/001_initial_schema.sql`, `010`,
`030`), so a hard `DELETE FROM users` would fail the foreign-key check; the
anonymised row is the anchor those references need. What a hard delete
_would_ cascade is listed per class in the inventory below — it is the map
B4-9 needs whichever shape owner question 9 picks.

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | All-or-nothing: one transaction, `defer tx.Rollback()`. A kill before `Commit` leaves the account untouched, sessions included. Nothing is written outside the database, so there is no half-state to find.                                                                                                                                                                                                                                                                                                                                                             |
| A2   | `SQLITE_FULL` on any statement rolls the transaction back; the service answers `ErrDeleteAccountFailed` (500) and the account is intact and retryable. Under WAL a rollback needs no free space beyond the WAL already allocated.                                                                                                                                                                                                                                                                                                                                       |
| A3   | n/a inside the operation — it touches no files. File reclamation for the user's attachments and old avatar is the orphan sweep's (O3), best-effort and asynchronous: those files are on disk until the next maintenance tick and stay there for good if the unlink fails.                                                                                                                                                                                                                                                                                               |
| A4   | A second deletion of the same account cannot pass the password check (the hash is now `''`). A message the same user sends over an already-authenticated WebSocket **can land after the transaction**: the socket was authenticated at handshake and the hub does not re-check the session per frame; the `member_ban` disconnect follows the commit. Such a message keeps its content and `user_id`. The erasure target (B4-9) closes the window by disconnecting the subject's sockets before the transaction, or by re-running the message step after the broadcast. |
| A5   | Full resurrection. A backup from before the deletion holds the username, password hash, encrypted TOTP secret, every message with content, and every row the operation deleted; restoring it (O4) brings the account back exactly as it was, and nothing records that a deletion ever happened. This is the limitation `docs/trust-model.md` discloses under "No secure deletion" and the one B4-10's durable deletion markers exist to close.                                                                                                                          |

**What the operation does not touch** is the point of the inventory: message
rows and their metadata (attributed by `user_id`), `message_mentions` rows
naming the user, `user_blocks`, `channel_user_overrides`, `invites`,
`emoji`, replay `events` payloads, audit rows and their free-text detail,
rate-lockout keys carrying the username, server logs, SQLite free pages, and
every backup. Each has a row below.

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

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | The `DELETE … RETURNING` commits first; a kill between it and the `os.Remove` loop strands every not-yet-removed file **with no database row naming it**. No later tick can find them. This is the sweep's one real failure mode, and it is permanent.                                                                                                                                                                                                                  |
| A2   | Deleting frees space; the statement itself needs only WAL room. A failed `os.Remove` (`EIO`, permissions) is logged and skipped — same outcome as A1 for that file.                                                                                                                                                                                                                                                                                                     |
| A3   | The transaction-first order is deliberate (a linked-between-select-and-delete race was the alternative, BUG-132), and it is the order that produces the stranded-file class above. The erasure and retention targets (B4-9, B4-11) need the inverse guarantee for the subject's files: a journaled, resumable removal, plus a **reconciliation pass** (storage directory listing versus `attachments.stored_as`) that turns strandings into a bounded, measurable leak. |
| A4   | An upload linking a row while the sweep selects it: closed by `RETURNING`. Two sweeps cannot overlap (one maintenance goroutine, ticks are serial).                                                                                                                                                                                                                                                                                                                     |
| A5   | A restored database may hold rows for files the sweep already deleted (they serve 404 and are swept again as orphans) and lack rows for files uploaded after the backup (invisible to the sweep forever — the same stranded class). Uploads are not in the backup, so restore always desynchronises the two; the reconciliation pass is the recovery.                                                                                                                   |

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

| Axis | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Backup: an interrupted `VACUUM INTO` is removed; a kill between `VACUUM INTO` and `integrity_check` leaves a file the next list shows and the integrity check never ran on — restore re-checks it before use, so it cannot be restored if broken. Restore: a kill **before** the close leaves the live file intact (the restart serves the old data); a kill **during** `copyFile` — a signal, not an error, so the rollback branch does not run — leaves a truncated live database. The declared recovery is manual: the `pre_restore_*` safety copy is on disk and `db.Open` refuses the truncated file on restart, so the operator restores the safety copy by hand. There is no automatic repair for this window. |
| A2   | Backup: `ENOSPC` inside `VACUUM INTO` is the OC-0212 path — partial removed, error returned, no audit row. Restore: `ENOSPC` while taking the safety copy aborts before the live file is touched (fail closed); `ENOSPC` during the main copy triggers the rollback from the safety copy, which itself needs no new space beyond the truncated destination.                                                                                                                                                                                                                                                                                                                                                           |
| A3   | The restore audit row is written to the **old** database only: it survives in the safety copy and is absent from the restored data by construction (`docs/security.md`, "Audit Logging"). Any marker that must survive a restore therefore cannot live in the database file alone — the design constraint B4-10 inherits.                                                                                                                                                                                                                                                                                                                                                                                             |
| A4   | `beginRestartSensitiveOp` serialises restore against update apply and a pending restart; a second restore answers a conflict. Concurrent ordinary writes end at the close: clients see the restart broadcast and reconnect to the restored data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A5   | This _is_ the operation. Everything after the backup's `VACUUM INTO` reverts: accounts created (their sessions now name users who do not exist), messages sent, deletions and erasures (O1 — the account returns), bans, setting changes, migrations applied later than the backup's schema (the next start re-applies them, `MigrateFS` being forward-only and idempotent per recorded filename). Uploads do not revert, so attachment rows and files desynchronise both ways (O3 A5). The B4-10 requirement is exact: a restore re-applies every deletion marker recorded after the backup's creation before the server serves data, and the markers live where the restore cannot overwrite them.                  |

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
erasure target (B4-9) either purges the subject's events or records the
bounded window as an accepted, disclosed limitation; HP-4 decides which.

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

### O8 — Recovery-secret rotation (B4-5, B4-6 targets; nothing exists at `aabac60`)

Written as the model the implementation must satisfy, since the operation
does not exist yet:

| Axis | Requirement                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Consuming a recovery kit, resetting the password, revoking every session and writing the audit row commit in **one** transaction: a kill leaves either the old kit valid and the old sessions live, or the new state complete — never a reset password beside live old sessions.                                    |
| A2   | The transaction rolls back; the kit is not consumed; the user retries.                                                                                                                                                                                                                                              |
| A3   | Enrolment generates the kit client-side and stores only a verifier server-side; a lost response means the user holds a kit the server never stored. The account's own state must make that visible ("no recovery kit enrolled") so the user re-enrols rather than trusting a dead kit.                              |
| A4   | Two concurrent redemptions of one kit admit at most one (the consume is a conditional `UPDATE … WHERE used_at IS NULL` whose affected-row count decides); two concurrent enrolments leave exactly one verifier valid.                                                                                               |
| A5   | A restore reverts the verifier to the pre-rotation one — the same wholesale reversion the password hash undergoes. The declared position is consistency with O4 A5: restore reverts credentials as a set, and the disclosure says so; deletion markers cover **erasure**, not rotation. HP-4 confirms or overrides. |

## Data-class inventory at `aabac60`

Every class of stored data that is attributable to a person, with today's
behaviour under O1 and the B4 step that changes it. "Attributable via" is
the column or content that links the class to the subject. "Hard-delete
cascade" is what `ON DELETE` would do if the `users` row were deleted
(`Server/migrations/`), for B4-9's design.

| #   | Class                      | Where                                                                                                        | Attributable via                                 | Today, after O1                                                                                                                                                                                                    | Hard-delete cascade               | B4 target                                                                                                                                                                |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Identity row               | `users`                                                                                                      | `id`, `username`, profile fields                 | Anonymised (`[deleted-<id>]`, secrets and profile cleared, banned). `created_at`, `last_seen`, `role_id` **remain**.                                                                                               | —                                 | B4-9: clear `last_seen`; keep or drop the row per owner question 9 (the anchor role is what makes "keep" cheap)                                                          |
| 2   | Sessions                   | `sessions`                                                                                                   | `user_id`, `device`, `ip_address`                | Deleted.                                                                                                                                                                                                           | CASCADE                           | Done. B4-7 adds sign-out-everywhere for the living.                                                                                                                      |
| 3   | API tokens                 | `api_tokens`                                                                                                 | `user_id`, `label`                               | Revoked (`revoked_at` set); rows, labels and hashes **remain**.                                                                                                                                                    | CASCADE                           | B4-9: delete the rows.                                                                                                                                                   |
| 4   | Second-factor state        | `users.totp_secret`; the partial-auth, pending-enrolment and used-code stores (in memory today; B4-3 tables) | `user_id`                                        | Secret cleared; in-memory stores expire (10 min / 90 s).                                                                                                                                                           | —                                 | B4-3's new tables join the erasure list the day they exist; emergency recovery codes (B4-3) too.                                                                         |
| 5   | Recovery secrets           | none yet (B4-5 kit verifier, B4-6 issued credentials)                                                        | `user_id`                                        | —                                                                                                                                                                                                                  | —                                 | Created by B4-5/B4-6 with erasure and rotation (O8) built in.                                                                                                            |
| 6   | Rate-limit state           | `rate_lockouts` (keys such as `login_user_lock:<username>`, `delete_lock:<id>`), plus in-memory windows      | key text                                         | Untouched; rows expire (≤ 15 min lockouts) and are swept by the limiter.                                                                                                                                           | —                                 | B4-9: delete the subject's keys in the transaction (cheap) — or record the bounded expiry; HP-4 decides.                                                                 |
| 7   | Login attempts             | `login_attempts`                                                                                             | `ip_address`, `username`                         | **No code writes this table** at `aabac60` (only the generated model and the snapshot scrub name it) — it is empty on every server.                                                                                | —                                 | Nothing to erase. Dropping the table is a housekeeping migration outside B4; recorded here so nobody plans erasure for an empty table.                                   |
| 8   | Messages                   | `messages` (`content`, `reply_to`, `timestamp`, `edited_at`, `pinned`, `mentions_everyone`), `messages_fts`  | `user_id`; content                               | Soft-deleted, `content = ''`, FTS entry emptied. **Rows remain attributed by `user_id`** with their timestamps and channel.                                                                                        | RESTRICT (NOT NULL, no action)    | B4-9: per owner question 9, hard-delete or unattributed tombstone; either way the `user_id` link must go (BPR-053).                                                      |
| 9   | Mentions                   | `message_mentions`                                                                                           | `mentioned_user_id`; author via the message      | Untouched — rows naming the subject as mentioned survive; rows of the subject's own messages survive with the soft-deleted rows.                                                                                   | CASCADE                           | B4-9: delete where `mentioned_user_id` is the subject; the author-side rows go with the messages.                                                                        |
| 10  | Reactions                  | `reactions`                                                                                                  | `user_id`                                        | Deleted.                                                                                                                                                                                                           | CASCADE                           | Done.                                                                                                                                                                    |
| 11  | Read states                | `read_states`                                                                                                | `user_id`                                        | Deleted (after the mention-count reversal).                                                                                                                                                                        | CASCADE                           | Done.                                                                                                                                                                    |
| 12  | Attachments and files      | `attachments` (`uploader_id`, `filename`, `stored_as`, `size`, dimensions), files under `upload.storage_dir` | `uploader_id`; the message                       | Not touched by O1. Rows linked to the now soft-deleted messages, and the old avatar row, become sweep-eligible and are reclaimed by O3 on a later tick, best-effort, only when storage is configured.              | uploader_id: no action (nullable) | B4-9: synchronous, journaled removal of rows and files inside the erasure, plus the O3 reconciliation pass.                                                              |
| 13  | Avatar                     | `users.avatar` → an unlinked `attachments` row + file                                                        | `users.avatar`, `uploader_id`                    | URL cleared; the row and file follow class 12 (sweep).                                                                                                                                                             | as 12                             | as 12                                                                                                                                                                    |
| 14  | DM membership and state    | `dm_participants`, `dm_open_state`, DM `channels`                                                            | `user_id`                                        | Deleted; empty DM channels removed; the survivor's open state closed.                                                                                                                                              | CASCADE                           | Done. (Group-DM messages of the subject are class 8.)                                                                                                                    |
| 15  | Invites                    | `invites`                                                                                                    | `created_by`, `redeemed_by`                      | Untouched: who invited whom survives, and the subject's unused invite codes stay redeemable.                                                                                                                       | RESTRICT                          | B4-9: revoke the subject's unused invites; null `redeemed_by`; reassign or null `created_by` — HP-4 chooses the attribution answer.                                      |
| 16  | Emoji                      | `emoji`                                                                                                      | `uploaded_by`                                    | Untouched (a server-wide asset).                                                                                                                                                                                   | RESTRICT                          | B4-9: reassign `uploaded_by` to the system actor (0); the asset stays.                                                                                                   |
| 17  | Blocks                     | `user_blocks`                                                                                                | `blocker_id`, `blocked_id`                       | Untouched, both directions.                                                                                                                                                                                        | CASCADE                           | B4-9: delete both directions.                                                                                                                                            |
| 18  | Per-user channel overrides | `channel_user_overrides`                                                                                     | `user_id`                                        | Untouched.                                                                                                                                                                                                         | CASCADE                           | B4-9: delete.                                                                                                                                                            |
| 19  | Voice state                | `voice_states`                                                                                               | `user_id`                                        | The hub clears it on the disconnect `member_ban` forces; the row is not part of the transaction.                                                                                                                   | CASCADE                           | B4-9: delete defensively in the transaction.                                                                                                                             |
| 20  | Replay events              | `events` (payload blobs)                                                                                     | user ids and content inside payloads             | Untouched; pruned after `retention_hours` (O5).                                                                                                                                                                    | —                                 | B4-9: purge the subject's rows or disclose the bounded window — HP-4.                                                                                                    |
| 21  | Audit history              | `audit_log` (`actor_id`, `target_id`, free-text `detail`)                                                    | ids; usernames and IPs inside `detail`           | Untouched. O1 itself adds `account_deleted` with the IP in `detail`.                                                                                                                                               | — (no FK since 003)               | B4-10: unlinkable retention — category, time, action class, integrity proof; subject mapping cryptographically erased; `detail` purged for the subject; no IP in detail. |
| 22  | Server logs                | `slog` output (usernames, ids, IPs at Info; e.g. O1 logs `username=`)                                        | text                                             | Untouched; retention is the operator's.                                                                                                                                                                            | —                                 | B4-9: the erasure path logs the id only; B4-8's diagnostics inventory states the log-retention rule for operators.                                                       |
| 23  | Plugin storage             | `plugin_kv`                                                                                                  | whatever a plugin stored                         | Untouched; opaque to the server.                                                                                                                                                                                   | —                                 | Out of B4 (plugins are off by default and compiled out of releases — [plugins.md](plugins.md)); recorded so the gap is a decision, not an oversight.                     |
| 24  | Backups                    | `*.db` under `backup.dir`, each a full copy of classes 1–21 as of its time                                   | everything                                       | Untouched; restorable (O4 A5).                                                                                                                                                                                     | —                                 | B4-10: durable deletion markers honoured on restore.                                                                                                                     |
| 25  | Free pages and WAL         | the SQLite file's free list and `-wal`                                                                       | content of updated/deleted rows                  | Untouched: `UPDATE`/`DELETE` leave the old bytes until the pages are reused or a `VACUUM` runs (`docs/trust-model.md`, "No secure deletion"). No `secure_delete` pragma is set (`Server/db/db.go`, `filePragmas`). | —                                 | HP-4 decides between `PRAGMA secure_delete` (per-connection, zeroes freed content), a post-erasure incremental vacuum, or an explicit disclosure.                        |
| 26  | TOTP encryption key        | `data/totp.key` / `OWNCORD_TOTP_KEY`                                                                         | not per user — it is what makes class 4 readable | Untouched (correct).                                                                                                                                                                                               | —                                 | B4-3: fail-closed load, atomic write; operators back it up beside the database (O7 A3).                                                                                  |

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
   (size per the row), then points `storage.New` at it. B6's upgrade
   rehearsal seeds a full uploads directory; B4 drills seed only what the
   subject touches.
4. **Inventory before and after.** Run the appendix queries for the subject
   before the operation and after it, and count the files in the temporary
   storage directory both times. The diff is the drill's evidence, pasted
   into the scorecard or the step's evidence block.
5. **Invariants after every drill.** `git status` shows the tracked snapshot
   unchanged; `TestAlphaSnapshotMigratesOnHead` and
   `TestAlphaProfileByteIdentical` stay green.

**HP-4 baseline drills** (before any new destructive operation merges), on
copies, each recorded with its before/after inventory:

- **D1 — O1 on a member with everything.** Pick the member with the most
  messages, attachments, reactions and DM channels; run `db.DeleteAccount`;
  expect exactly the leftovers the inventory predicts (classes 8, 9, 12, 15,
  16, 17, 18, 20, 21 — the snapshot holds no rows for 6 and 19) and nothing
  else.
- **D2 — Resurrection, the negative control for B4-10.** Back up the copy
  (`BackupToSafe`), run D1, restore the backup over the copy; expect the
  account back in full. B4-10's post-restore proof is this drill with the
  opposite expectation.
- **D3 — Restore over newer data.** Back up, insert messages and a new user,
  restore; expect them gone and the schema re-migrated forward on the next
  open.
- **D4 — The replay window.** Insert `events` rows for the subject (the
  snapshot has none), run D1, expect the rows to survive, then prune with a
  cutoff after them and expect them gone — the O5 limitation made visible.
- **D5 — Stranded files.** Seed placeholder files for a soft-deleted
  message's attachments, run `DeleteOrphanedAttachments`, then delete one
  returned file before the removal loop would; expect the O3 A1 class — a
  file with no row — so the reconciliation pass has a fixture.

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
anonymisation, for the lockout keys). One row per class that can hold the
subject; every count must be zero after erasure, except where B4-10 keeps an
unlinkable residue by design.

```sql
-- 1 identity row (expect 1 anonymised row, or 0 after a hard delete)
SELECT COUNT(*) FROM users WHERE id = :uid AND username NOT LIKE '[deleted-%';
-- 2 sessions
SELECT COUNT(*) FROM sessions WHERE user_id = :uid;
-- 3 api tokens (rows, not just active ones)
SELECT COUNT(*) FROM api_tokens WHERE user_id = :uid;
-- 4 second factor
SELECT COUNT(*) FROM users WHERE id = :uid AND totp_secret IS NOT NULL;
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
-- 20 replay events naming the subject: payloads are the wire JSON, which
--    carries the author as a nested "user":{"id":…} object on message frames
--    and as "user_id" on state frames (docs/protocol.md). json_extract is
--    SQLite's built-in JSON1, present in modernc.org/sqlite.
SELECT COUNT(*) FROM events
 WHERE json_extract(payload, '$.user_id') = :uid
    OR json_extract(payload, '$.user.id') = :uid;
-- 21 audit rows about or by the subject (B4-10 keeps an unlinkable residue)
SELECT COUNT(*) FROM audit_log WHERE actor_id = :uid OR (target_type = 'user' AND target_id = :uid);
```

Classes 22–26 (logs, plugin storage, backups, free pages, the key file) are
not rows and are checked by the drill's file-level steps.
