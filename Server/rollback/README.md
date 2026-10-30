# Migration reversals

This folder is for server owners who need to undo a database migration by
hand. It holds one reversal script for every migration from `032` onwards, and
the order to run them in. `rollback.go` holds the same list for the automated
rehearsal that tests them.

**Read this first.** Migrations only go forward: the server applies them and
never undoes them. Undoing one is something you do yourself, with these files,
against a stopped server, after taking a backup. For a normal rollback after a
bad upgrade, use the archive procedure in
[Rolling back](../../docs/deployment.md#rolling-back) instead.

The scripts were written together with their migrations, not made up during
an incident. `TestMigrationRollbackRehearsalOnAlphaSnapshot`
(`Server/db/rollback_rehearsal_test.go`) runs the whole set on a copy of the
committed test database on every CI run.

## Running one

```sh
DB=data/chatserver.db   # your server's database.path -- check yours
test -f "$DB" || { echo "no database at $DB" >&2; exit 1; }

{ echo 'BEGIN;'; cat Server/rollback/043_setup_completed.down.sql; echo 'COMMIT;'; } |
  sqlite3 -bail "$DB"
```

Steps:

1. Stop the server.
2. Take a backup.
3. Set `DB` to your server's `database.path`, and run the command above once
   per reversal, newest first.
4. Start the server version that matches the schema you went back to.

Every part of the command matters:

- **Use your configured path, and check it first.** `sqlite3` creates a new
  database when the file does not exist. So a wrong path does not fail. It
  reverses a brand-new empty database, reports success, and leaves the live
  one untouched. `data/chatserver.db` is only the default
  (`Server/config/config.go`, `Database.Path`). Read your own `database.path`.
- **`-bail` stops at the first error.** Without it, `sqlite3` prints the error
  and carries on. It would then run the `schema_versions` delete at the end of
  the file, for a reversal that did not finish. The next start would re-apply
  the migration onto a half-reversed schema.
- **The `BEGIN;` / `COMMIT;` wrapper makes each file all-or-nothing.**
  Otherwise `sqlite3` saves each statement as it reads it, so a failure half-way
  leaves the earlier changes saved. No file here has its own transaction
  commands, so this wrapper is always valid. `TestReversalFilesAreOperatorSafe`
  keeps it that way. It also keeps the `schema_versions` delete last, so a
  failed run cannot clear the tracker before the schema change lands.

**Run them newest first, with no gaps.** To get from 043 back to 040, run 043,
042, 041, then 040. Skipping one in the middle is not supported.

Three rules. The files enforce the first two. You must follow the third:

- **Each reversal clears its own `schema_versions` row.** That tells the next
  server start to apply the migration again. Without it, the database would
  claim a schema it does not have.
- **Order matters.** A reversal that drops a column runs before the one that
  drops its table. `042` moves its audit tokens back into `subject_token`
  before `041` drops the column they are in.
- **The server must be stopped.** Nothing here takes the server's write lock.
  A reversal that half-applies while the server is running is the one failure
  these files cannot protect against.

## What each one costs

Undoing a schema change is cheap. Undoing what the migration made possible
usually is not. Each file explains its own cost in a comment. These are the
ones to know before you start. The list is not complete, so read the comment
at the top of each file before you run it.

| Reversal                             | What it costs                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `087_discord_import`                 | The import job records, each imported message's Discord author name and the pending-channel flag are dropped, and a channel still being built is deleted. Imported messages stay, owned by the hidden import account, which an older binary already keeps out of its member lists.                                                       |
| `086_channel_password`               | Every voice channel password and every remembered grant is dropped. A channel that had a password opens to anyone the role rules let in. Channels and permissions are untouched.                                                                                                                                                         |
| `085_session_identity_key`           | The per-device voice identity key stored on each session (`sessions.identity_public_key`) is dropped. Each device sends it again on its next connect. `users.identity_public_key` is untouched.                                                                                                                                          |
| `084_attachment_voice`               | The voice message length and waveform (`attachments.duration_ms`, `attachments.waveform`) are dropped, so an older client shows each voice message as a plain audio file. The files and the attachment rows stay.                                                                                                                        |
| `082_owner_type_permissions`         | Nothing to restore. Bits 2, 3, 4, 7, 8, 15 and 28 (the owner-type permissions) were cleared on every role except the owner and had no meaning before 082; an older binary ignores them. A role given one by hand after 082 loses that power until 082 is applied again.                                                                  |
| `081_manage_backups`                 | Nothing to restore. Bit 14 (Manage Backups) was cleared on every role except the owner and had no meaning before 081; an older binary ignores it.                                                                                                                                                                                        |
| `080_move_members`                   | Nothing to restore. Bit 13 (Move Members) was cleared on every role except the owner and had no meaning before 080; an older binary ignores it.                                                                                                                                                                                          |
| `079_thread_members`                 | Every thread follow is forgotten, so each thread's sidebar entries and follow-based hints vanish until people post, are mentioned or follow again. Threads, messages and access are untouched, because a follow never granted or limited anything.                                                                                       |
| `077_user_roles_reconcile`           | Nothing to undo (data-only). It only made the role rows agree with the role the member list shows.                                                                                                                                                                                                                                       |
| `078_manage_nicknames`               | An untouched Moderator role loses the Manage Nicknames bit again (back to `0x6FFFFF`). Changed nicknames and their audit rows stay.                                                                                                                                                                                                      |
| `076_category_permissions`           | Every category's permission template is dropped, and every channel forgets whether it was synced to its category. Access does not change: each channel keeps its own override rows, which are what permissions are computed from. A later re-apply starts with no channel synced and no template.                                        |
| `072_channel_categories`             | Each channel gets its category's current name back as free text, so the sidebar groups look the same. The category objects are lost: their order apart from the channels in them, and any category with no channel in it.                                                                                                                |
| `070_user_privacy`                   | Every saved direct message privacy choice is lost, so each member is back to both settings on. Nothing else reads the table in this release.                                                                                                                                                                                             |
| `067_user_roles`                     | A member holding several roles keeps the role in `users.role_id`, which is the top held role. The extra roles, the hoist and mentionable flags and the recorded role pings are dropped.                                                                                                                                                  |
| `068_channel_afk`                    | The server forgets which voice channel was its AFK channel. Nothing else is lost, and the `afk_timeout_seconds` setting stays. An older binary applies no listen-only rule, so members in that channel can speak again.                                                                                                                  |
| `066_group_dm_icon`                  | Every group DM forgets its icon, and the group icon rows (kind 6) are deleted with what they name. The icon files stay as unlinked attachments that the orphan sweep reclaims. Other group event rows and ordinary messages are untouched. Run it only after the server is stopped, because an older binary has no notion of these rows. |
| `065_group_dm_owner`                 | Every group event row in a DM (kinds 2 to 6) is deleted with what it names, and every group DM forgets its owner. Ordinary messages and call log rows are untouched. Run it only after the server is stopped, because an older binary has no notion of these rows.                                                                       |
| `064_call_log`                       | Every call log row in a DM is deleted along with its call times and participant list, and the `messages.kind` column is dropped. Ordinary messages are untouched. Run it only after the server is stopped, because an older binary has no notion of a call row.                                                                          |
| `063_mention_receipts`               | The record of which messages raised each mention badge is lost. Badges themselves are untouched. A later re-apply backfills only the rows that show a badge at that moment.                                                                                                                                                              |
| `062_custom_status_expiry`           | Every pending custom-status expiry is forgotten: a status that was set to clear itself stays until its owner changes it.                                                                                                                                                                                                                 |
| `061_member_generation_about`        | Nothing is lost: the member-generation trigger goes back to not watching About Me, which an older binary does not read in the member list.                                                                                                                                                                                               |
| `060_message_mentions_reply_ping`    | Reply pings are forgotten: the replied-to author's row stays as an ordinary mention, but a later edit drops it and a delete after that edit no longer takes back the ping's badge.                                                                                                                                                       |
| `059_gif_favorites`                  | Every user loses their saved GIF favorites; they are provider URLs only, but the list cannot be reconstructed.                                                                                                                                                                                                                           |
| `058_revoke_trust_for_blocked_pairs` | Nothing comes back: the standing trust it deleted for currently blocked pairs is not restored by reversing it. After an unblock the sender is not trusted again until the recipient trusts them by hand or accepts their next request.                                                                                                   |
| `055_invite_redemptions`             | The redemption history is lost: an owner can no longer see who redeemed an invite. `invites.use_count` and the legacy `redeemed_by` are untouched, so every existing invite keeps working and every use count is unchanged.                                                                                                              |
| `053_retention_revision`             | Removes retention revision tracking and its triggers. Existing retention settings and message history remain intact. Preview tokens must be obtained again after restarting or reapplying the migration.                                                                                                                                 |
| `052_report_source_nsfw`             | Reports forget whether their source channel was ever labelled NSFW. Run it only with a server build from before 052 — the evidence gate reads the column — and a later re-apply backfills from current labels, so a report whose labelled channel was deleted in between comes back as unknown and stays withheld.                       |
| `051_message_delivery_receipts`      | Loses retry memory. Recovered pending drafts require deliberate review against existing history before resending; retry deduplication cannot cover a database rollback. Existing messages remain intact.                                                                                                                                 |
| `050_appeals`                        | Every open appeal is lost outright, and with every decided one goes the `UNIQUE(action_id)` memory that forbids re-appealing — an action already decided once can be appealed again after this table is dropped and later re-created, because nothing recorded that it ever was.                                                         |
| `049_moderation_actions`             | Every warning, timeout, and the ledger rows ban/kick/removal recorded alongside their existing mechanisms are gone. Active timeouts stop being enforced immediately (nowhere left to read `expires_at` from); unacknowledged warnings are lost outright. Bans and kicked-out sessions are unaffected — their state lives elsewhere.      |
| `048_reports`                        | The report queue and every outcome row are gone — including the unlinkable ones kept after a subject erases. A report about an account that has since erased carries the last durable trace that the report ever happened; dropping the table drops that trace too. Also revokes `MODERATE_MEMBERS` from the Moderator role.             |
| `047_nsfw_acknowledgements`          | Every stored acknowledgement is gone. Nobody's consent history is reconstructable, so every member re-acknowledges every labelled channel on their next read — a one-time annoyance, not data loss of anything the product treats as durable content.                                                                                    |
| `046_message_requests`               | Every pending request and every ignored/deleted/blocked decision the recipient made is lost, and a later re-apply's grandfathering backfill collapses the `sent_first`/`accepted`/`grandfathered` distinction on standing trust to just "trust exists" — see the reversal's own comment.                                                 |
| `045_push_subscriptions`             | Every stored Web Push subscription is gone. Nothing in flight is lost — every device just has to re-subscribe.                                                                                                                                                                                                                           |
| `043_setup_completed`                | First-run setup goes back to being gated on "no users exist". On a server whose users table an erasure emptied, the unauthenticated wizard is open again — narrow the setup networks first (`docs/security.md`, "First-run setup").                                                                                                      |
| `042` + `041` (audit tokens)         | An audit row naming two erased principals keeps one token, not both. Run 042 before 041 or lose the actor's token entirely.                                                                                                                                                                                                              |
| `039_retention`                      | Nothing deleted by an earlier sweep comes back. A sweep whose replay purge had not finished loses its journal.                                                                                                                                                                                                                           |
| `037_erasure_jobs`                   | An erasure that had not finished its file half loses the journal listing the files still to remove. Reconcile storage by hand afterwards.                                                                                                                                                                                                |
| `036` / `035` (recovery)             | Every issued credential and every enrolled kit stops working. Tell the people holding them first.                                                                                                                                                                                                                                        |
| `034_registration_modes`             | `approval` and `open` have no boolean spelling, so the mode becomes closed. Accounts awaiting approval become ordinary accounts that can sign in — settle them first.                                                                                                                                                                    |
| `032_second_factor_state`            | Emergency recovery codes are invalidated, in-flight logins and enrolments dropped.                                                                                                                                                                                                                                                       |
| `markers.down.sql`                   | Forfeits the anti-resurrection guarantee for every erasure so far: a restore of an older backup brings erased subjects back with nothing to stop them. Record it in the audit log first.                                                                                                                                                 |

`markers.down.sql` is different from the others. The deletion-marker file has
its own schema, applied each time it is opened by `Server/db/markers.go`. So
it is not a migration and has no `schema_versions` row to clear. Run it
against `data/erasure/markers.sqlite`, not the main database.

## Adding one

For contributors: a new migration must land with its reversal in the same
pull request. The rehearsal test fails otherwise. It checks that every
migration newer than the test database has a reversal. It also checks that
running all of them returns the test database's schema, `schema_versions`,
settings and row counts exactly.

The first reversals were drafted before their migrations, in
`docs/archive/plans/hp-4-drafts/`. Those drafts are the design record. The files here
are what runs.
