# Database Schema Reference

OwnCord uses a single SQLite database file (`data/chatserver.db`) with the pure-Go driver `modernc.org/sqlite` (no CGO). Migrations run automatically on startup.

> **Data-access layers:** most `Server/db` methods delegate to the
> sqlc-generated layer (`Server/db/dbgen`, from `Server/db/queries/`) per
> decision D2 in
> [archive/plans/audit-2026-07-19-decisions.md](archive/plans/audit-2026-07-19-decisions.md);
> a deliberate remainder (variable `IN` lists, FTS, multi-statement
> transactions) still runs as hand-written SQL — tracked in
> [archive/plans/sqlc-adoption.md](archive/plans/sqlc-adoption.md). See
> [architecture/data-model.md](architecture/data-model.md) for the full
> picture.

---

## Database Configuration

| PRAGMA         | Value       | Purpose                                    |
| -------------- | ----------- | ------------------------------------------ |
| `journal_mode` | `WAL`       | Write-Ahead Logging for concurrent readers |
| `foreign_keys` | `ON`        | Enforces all `REFERENCES` constraints      |
| `busy_timeout` | `5000`      | Waits up to 5 seconds for the write lock   |
| `synchronous`  | `NORMAL`    | Fewer fsyncs; see durability note below    |
| `temp_store`   | `MEMORY`    | Temporary tables stored in RAM             |
| `mmap_size`    | `268435456` | 256 MB memory-mapped I/O                   |
| `cache_size`   | `-64000`    | 64 MB page cache                           |

**Durability with `synchronous=NORMAL`.** In WAL mode this setting never
corrupts the database, and an application crash or kill loses nothing that was
committed. An OS crash or power loss can lose the last few committed
transactions (those since the last sync of the WAL file); the database
reopens consistent, just without them. A UPS or a host that survives power
cuts is what protects those last writes.

SQLite only allows one writer at a time. File-backed databases (the production
mode) therefore run a split pool: a single-connection writer pool
(`SetMaxOpenConns(1)`) plus a multi-connection read-only pool sized
`max(8, 2× NumCPU)` and clamped to 1–64, configurable via `database.max_readers`
(`Server/db/db.go`). Only in-memory databases (tests) keep the historical
single shared connection.

---

## Migration System

Migrations are embedded `.sql` files applied in lexicographic order. Each migration runs in a transaction and is tracked in `schema_versions`.

```sql
CREATE TABLE IF NOT EXISTS schema_versions (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Migration History

| File                                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_initial_schema.sql`                       | All core tables, default roles and settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `002_voice_states.sql`                         | Adds `voice_states` table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `003_audit_log.sql`                            | Recreates `audit_log` with canonical column names (via a transient `audit_log_v6` rename)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `004_voice_optimization.sql`                   | Adds `camera`, `screenshare` to voice_states; voice settings to channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `005_fix_member_permissions.sql`               | Fixes Member role permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `006_channel_overrides_index.sql`              | Adds composite index on channel_overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `007_member_video_permissions.sql`             | Adds USE_VIDEO and SHARE_SCREEN to Member role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `008_attachment_dimensions.sql`                | Adds `width` and `height` to attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `009_dm_tables.sql`                            | Adds `dm_participants` and `dm_open_state` tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `010_attachment_uploader.sql`                  | Adds `attachments.uploader_id` + index for upload-ownership checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `011_rate_lockouts.sql`                        | Adds `rate_lockouts` so rate-limit lockouts survive restarts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `012_user_blocks.sql`                          | Adds `user_blocks` (blocks DM creation/messaging between users)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `013_channel_type_constraint.sql`              | INSERT/UPDATE triggers restricting `channels.type` to `text`/`voice`/`dm`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `014_events_table.sql`                         | Adds `events` — persistent broadcast log for reconnect cold-tier replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `015_plugins.sql`                              | Adds `plugins` and `plugin_kv` for the WASM plugin runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `016_announcement_channel_type.sql`            | Recreates the channel-type triggers to allow `announcement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `017_user_identity_key.sql`                    | Adds `users.identity_public_key` (long-term E2EE identity key for voice TOFU)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `018_api_tokens.sql`                           | Adds `api_tokens` — long-lived, revocable bearer tokens for headless clients (bot/service auth)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `019_perf_indexes.sql`                         | Adds hot-path indexes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `020_drop_redundant_indexes.sql`               | Drops indexes duplicating UNIQUE auto-indexes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `021_voice_server_moderation.sql`              | Adds `server_muted`, `server_deafened` to voice_states (moderator-imposed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `022_message_mentions.sql`                     | Adds `message_mentions` + `messages.mentions_everyone`, and grants `MENTION_EVERYONE` (bit 21) to the seeded Owner/Admin/Moderator roles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `023_role_management.sql`                      | Adds `idx_roles_name_nocase` — role names become unique case-insensitively, matching how they are looked up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `024_channel_user_overrides.sql`               | Adds `channel_user_overrides` — per-member channel permission overrides, the last layer of the resolution order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `025_channel_nsfw.sql`                         | Adds `channels.nsfw` — the age-gate flag the server stores and broadcasts but imposes no behaviour of its own on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `026_emoji_mime.sql`                           | Adds `emoji.mime_type` — the sniffed image type, so the emoji image route can send a Content-Type without re-reading the file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `027_user_profile_fields.sql`                  | Adds `users.display_name`, `users.about`, `users.custom_status`, and a partial index on `users(avatar)` for the file route's avatar-authorization probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `028_group_dms.sql`                            | Adds `channels.is_group` + a partial index — marks a DM channel as a group so group-ness survives people leaving                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `029_drop_sounds_table.sql`                    | Drops `sounds` — dead since 001; the soundboard it was created for was never built (A-2026-07-13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `030_attachments_unlink_on_message_delete.sql` | Rebuilds `attachments` with `message_id ON DELETE SET NULL` (was CASCADE) — cascaded message deletes now unlink rows instead of removing them, so the periodic orphan sweep can still find and reclaim the stored files                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `031_sessions_expiry_index.sql`                | Normalizes legacy `sessions.expires_at` values to RFC3339 UTC and adds `idx_sessions_expires_at` so the 15-minute expiry sweep is sargable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `032_second_factor_state.sql`                  | Adds `partial_auth_challenges`, `pending_totp_enrollments`, `totp_used_codes` (the login challenge, staged enrolment and replay window, persisted as digests/ciphertext so they survive a restart — S-13) and `totp_recovery_codes` (bcrypt-hashed emergency codes, one row each — BPR-046)                                                                                                                                                                                                                                                                                                                                                       |
| `033_sessions_unseen.sql`                      | Adds `sessions.unseen` — a session created by a login starts unseen so the client can surface "you signed in on a new device", and clears it once shown (B4-7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `034_registration_modes.sql`                   | Replaces the `registration_open` boolean with a `registration_mode` setting (`closed`, `invite`, `approval`, `open`) and adds `users.registration_status` for the approval queue. A fresh install defaults to `invite`; an upgrade maps the old boolean without ever opening registration (B4-1)                                                                                                                                                                                                                                                                                                                                                  |
| `035_recovery_kits.sql`                        | Adds `recovery_kits` — one row per account holding only an argon2id verifier of the kit secret, never the secret. Enrolment replaces the row, a successful recovery stamps `used_at` so the kit is spent (B4-5)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `036_recovery_assists.sql`                     | Adds `recovery_assists` — one outstanding owner-issued credential per account, storing an argon2id verifier, who issued it, the fixed wording of how the person was verified, and its expiry. Redemption deletes the row (B4-6)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `037_erasure_jobs.sql`                         | Adds `erasure_jobs` plus a partial index on unfinished jobs — the durable journal that lets the filesystem half of an account erasure resume after a crash or restart instead of stranding files (B4-9)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `038_audit_unlinking.sql`                      | Adds `audit_log.subject_token` and its partial index — an erasure zeroes `actor_id`/`target_id` and rewrites free-text detail, and the token keeps the history's integrity without keeping who the subject was (B4-10)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `039_retention.sql`                            | Adds the `retention_days` setting (0 = keep forever, the default), `channel_retention` for a per-channel override in either direction, and `retention_runs` as the sweep log and file journal. No hold mechanism and no DM scope exist, by decision (B4-11)                                                                                                                                                                                                                                                                                                                                                                                       |
| `040_erasure_replay_purge.sql`                 | Adds `erasure_jobs.replay_purged` so purging the subject from the replay ring and `events` is a journaled step of the erasure job rather than a best-effort side call, and indexes `messages(reply_to)` for it. Allocated out of order — it shipped before 038 and 039 (B4-9 follow-up)                                                                                                                                                                                                                                                                                                                                                           |
| `041_audit_actor_token.sql`                    | Adds `audit_log.actor_token` and its partial index — an audit row names two principals, so an erased actor needs a token of its own rather than sharing the subject's (B4-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `042_audit_actor_token_backfill.sql`           | Moves the tokens 038 wrote into `subject_token` for an erased _actor_ across to `actor_token`, so erasing the row's still-present target cannot overwrite the actor linkage 041 exists to keep (B4-10)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `043_setup_completed.sql`                      | Adds the `setup_completed` setting and stamps it for an installation that is already set up. First-run setup was gated on "no users exist", which an erasure can now make true again; the gate becomes a durable flag the server never clears (B4-10)                                                                                                                                                                                                                                                                                                                                                                                             |
| `044_user_storage.sql`                         | Adds `user_storage`, the durable per-user upload byte counter charged before every store write and recounted from the rows on the maintenance tick; seeds the counters from existing attachments (B5-2, SEC-04)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `045_push_subscriptions.sql`                   | Adds `push_subscriptions` (one row per user/endpoint, `vapid_key_id` recording which VAPID key it was created under). Storage landed here; dispatch to them shipped later (PR #1548, B5-11) behind HP-5, gated on `push.enabled` and `push.dispatch_enabled`, both off by default (B5-4, BG-05)                                                                                                                                                                                                                                                                                                                                                   |
| `046_message_requests.sql`                     | Adds `message_requests` (one row per sender/recipient pair ever, `UNIQUE(sender_id, recipient_id)`) and `trusted_senders` (a recipient's allow-list, source `accepted`/`sent_first`/`grandfathered`), staging first contact for a one-to-one DM instead of opening it; grandfathers every existing one-to-one DM pair as trusted, both directions (B5-6, BPR-060)                                                                                                                                                                                                                                                                                 |
| `047_nsfw_acknowledgements.sql`                | Adds `nsfw_acknowledgements` (one row per user/channel, `PRIMARY KEY (user_id, channel_id)`), the per-user consent record a labelled channel's content is withheld from until it exists; never expired by a sweep, deleted by the user revoking, by channel deletion (cascade), or by the channel losing its `nsfw` flag (application logic, same transaction as the flag write) (B5-7, BPR-063, BG-18)                                                                                                                                                                                                                                           |
| `048_reports.sql`                              | Adds `reports`, `report_evidence` and `report_notes` — local report intake, the moderator queue and an evidence snapshot by reference; grants the new `MODERATE_MEMBERS` bit (22) to the default Moderator role (B5-8, BPR-070/071)                                                                                                                                                                                                                                                                                                                                                                                                               |
| `049_moderation_actions.sql`                   | Adds `moderation_actions` — the moderator-action ledger every warning, timeout, kick, ban and removal writes a row to, one transaction with its effect. `target_id` cascades on user deletion (S6: a warning/timeout is deleted, not kept); `actor_id`/`actor_token` and `lifted_by` are the bare-id-plus-token erasure shape, deliberately with no `CHECK (actor_id > 0)` (B5-9, BPR-072)                                                                                                                                                                                                                                                        |
| `050_appeals.sql`                              | Adds `appeals` — a rate-limited appeal against a moderation action (BPR-073, decision 8). `UNIQUE(action_id)` is the memory that forbids re-appealing a decided action, ever; `appellant_id` cascades on user deletion (an appeal is deleted for the appellant); `decided_by`/`decided_by_token` is the bare-id-plus-token erasure shape. Carries its own `public_id`, a deviation from the HP-5 draft matching reports' shape (B5-10)                                                                                                                                                                                                            |
| `051_message_delivery_receipts.sql`            | Adds sender-scoped retry receipts committed with message content, mentions and attachment links. Logical IDs expire after 24 hours; receipts survive message deletion to prevent retry resurrection and are erased with their sender.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `052_report_source_nsfw.sql`                   | Adds `reports.source_nsfw`, a sticky record that a report's source channel was labelled NSFW (set at filing and on any later labelling by two triggers, never cleared), so evidence from a deleted labelled channel stays withheld. Backfills from each surviving channel's current label; a pre-052 report whose channel was already deleted keeps NULL, which the evidence gate treats as labelled                                                                                                                                                                                                                                              |
| `053_retention_revision.sql`                   | Adds a durable retention-policy revision and triggers covering server settings, channel overrides and cascade removal. Proposed previews compare this revision atomically when applied (RI-08).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `054_audit_action_index.sql`                   | Adds `idx_audit_log_action`, so the Dashboard's `SELECT DISTINCT action FROM audit_log` filter reads the index instead of scanning the unbounded log (PERF-09).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `055_invite_redemptions.sql`                   | Adds `invite_redemptions`, one row per invite use naming the redeemer, so a leaked invite can be traced (O1). `user_id` is nullable with no foreign key (the reports bare-id-plus-token shape): an account erasure keeps the row and nulls the link, cascaded away with the invitation when the creator is erased.                                                                                                                                                                                                                                                                                                                                |
| `056_message_pinned_at.sql`                    | Adds `messages.pinned_at`, stamped when a message is pinned, so the pinned panel orders by pin recency instead of message id (a message pinned earlier now sorts below one pinned later). Rows pinned before this migration keep NULL and sort last.                                                                                                                                                                                                                                                                                                                                                                                              |
| `057_member_generation.sql`                    | Adds `member_generation`, a one-row counter that triggers on `users` and `roles` bump in the same commit as every write that can change the ready payload's member list (join, ban, unban, role, profile, identity key, custom status, registration, role rename). `users.status` is deliberately not watched. The ready path shares one member-list read until the counter moves or a pending temporary ban lapses.                                                                                                                                                                                                                              |
| `058_revoke_trust_for_blocked_pairs.sql`       | Deletes `trusted_senders` rows where the recipient currently blocks the sender, so an unblock no longer revives old trust. The blocked user's trust in the blocker is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `059_gif_favorites.sql`                        | Adds `gif_favorites`, one row per user and GIF URL (provider URLs and a title, never bytes), the per-user favorites list the GIF picker shows newest first; capped per user in `db.AddGIFFavorite`, deleted with the user                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `060_message_mentions_reply_ping.sql`          | Adds `message_mentions.reply_ping` (`INTEGER NOT NULL DEFAULT 0`). A `chat_send` with `reply_ping` stores the replied-to author as an ordinary mention row flagged 1, so an edit keeps it (the edit rewrites only the unflagged rows) and a delete reverses its badge. Rows that existed before are 0                                                                                                                                                                                                                                                                                                                                             |
| `061_member_generation_about.sql`              | Re-creates the `member_generation_users_update` trigger with `users.about` added to its `UPDATE OF` list and `WHEN` clause, because `ListMembers` now returns the About Me bio. No table or column changes                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `062_custom_status_expiry.sql`                 | Adds `users.custom_status_expires_at` (`TEXT`, written as `2006-01-02T15:04:05Z`, `NULL` = no expiry) and the partial index `idx_users_custom_status_expires_at` on it, so the custom-status expirer finds the next deadline cheaply. The member-generation trigger is unchanged: only a change to the text moves the generation                                                                                                                                                                                                                                                                                                                  |
| `063_mention_receipts.sql`                     | Adds `mention_receipts` (`user_id`, `channel_id`, `message_id`, `WITHOUT ROWID`), one row for each recipient whose `mention_count` was raised by a message, written in the same transaction as the increment and cascaded with the user and the message. Backfills only rows that show a badge today (live, unread, not own, not blocked, naming the reader or `@everyone`); it may overcount (`@here`, mentions added by an edit, lost channel access, `@everyone` before a never-moved pointer). Nothing reads it yet                                                                                                                           |
| `064_call_log.sql`                             | Adds `messages.kind` (`INTEGER NOT NULL DEFAULT 0`: 0 an ordinary message, 1 a call log row, so every existing row stays 0), `message_calls` (`message_id`, `channel_id`, `started_at`, `ended_at`, `last_seen_at`; `ended_at` is `NULL` while the call is live) and `message_call_participants` (`message_id`, `user_id`). The partial unique index `idx_message_calls_open` allows one live call per channel. All three cascade with the message, the channel or the user.                                                                                                                                                                      |
| `065_group_dm_owner.sql`                       | Adds `channels.dm_owner_id` (`INTEGER REFERENCES users(id) ON DELETE SET NULL`), the owner of a group DM, backfilled for existing groups with the author of the oldest message who is still a member, else the lowest member id (NULL for a 1:1 DM), and `message_group_events` (`message_id`, `target_user_id`, `name`, `icon_removed`), the detail of group event rows (`messages.kind` 2 to 6). Nothing writes group event rows yet.                                                                                                                                                                                                           |
| `066_group_dm_icon.sql`                        | Adds `channels.dm_icon` (`TEXT REFERENCES attachments(id) ON DELETE SET NULL`), the attachment id of a group DM's icon (NULL = none), and the partial index `idx_channels_dm_icon` on it. The icon is an unlinked attachment: its group's members can read it while it is the live icon, and the orphan sweep, the uploader discard and message linking leave it alone.                                                                                                                                                                                                                                                                           |
| `067_user_roles.sql`                           | Adds `user_roles(user_id, role_id)` (`WITHOUT ROWID`, cascading on both keys, index `idx_user_roles_role`) backfilled with one row per user whose `role_id` names a live role, the trigger `user_roles_on_user_insert`, `roles.hoist` (existing roles set to 1) and `roles.mentionable` (default 0), the empty `message_role_mentions`, and member-generation triggers on `user_roles` writes and on `roles` hoist or color edits.                                                                                                                                                                                                                |
| `068_channel_afk.sql`                          | Adds `channels.afk` (`INTEGER NOT NULL DEFAULT 0 CHECK (afk IN (0, 1))`), the flag on the server's one AFK voice channel, and the partial unique index `idx_channels_afk` on `channels(afk) WHERE afk = 1`, so the database itself allows at most one flagged row. Only a live voice channel may be flagged (checked at the write); deleting the channel deletes the flag and archiving it clears the flag (trigger `trg_channels_archive_clears_afk`). The AFK channel is listen-only. (WP 6.10a)                                                                                                                                                |
| `069_profile_notes_banners.sql`                | Adds `user_notes(owner_id, target_id, note, updated_at)` (`WITHOUT ROWID`, cascading on both user keys, index `idx_user_notes_target`), the private one-note-per-pair store behind `/api/v1/users/me/notes/{userId}`, plus `users.banner_id` (`TEXT REFERENCES attachments(id) ON DELETE SET NULL`, partial index `idx_users_banner_id`) and `users.banner_color`, which stay unused until the banner endpoints land, and re-creates the member-generation trigger on `users` to watch both banner columns.                                                                                                                                       |
| `070_user_privacy.sql`                         | Adds `user_privacy(user_id, allow_member_dms, message_requests, updated_at)` (`WITHOUT ROWID`, `user_id` is the primary key and cascades with the user, both settings `INTEGER NOT NULL DEFAULT 1` limited to 0 or 1), the per-user direct message privacy store behind `/api/v1/users/me/privacy`. It writes no rows: a user with no row has both settings on.                                                                                                                                                                                                                                                                                   |
| `071_message_forwards.sql`                     | Adds `message_forwards(message_id, source_message_id, source_channel_id, source_timestamp)`, the side row that marks an ordinary message (`kind` 0) as a forward. `message_id` cascades with the message, `source_message_id` goes `NULL` (`ON DELETE SET NULL`, index `idx_message_forwards_source`) when the original is purged, and `source_channel_id` has no key. No author is stored.                                                                                                                                                                                                                                                       |
| `072_channel_categories.sql`                   | Adds `channel_categories(id, name, position, created_at)` with the case-insensitive unique index `idx_channel_categories_name`, and `channels.category_id` (`INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL`, index `idx_channels_category_id`). Backfills one category per distinct trimmed, non-empty `channels.category` (ignoring case, spelled like the lowest-positioned channel, ordered by that channel) and points each channel at it; an empty or whitespace-only value gets no category. `channels.category` is no longer read or written but is **not dropped**, so the reversal restores the schema exactly. (WP 6.5a) |
| `073_polls.sql`                                | Adds `polls(message_id, question, allow_multiselect, expires_at, ended_at, version)`, `poll_answers(message_id, answer_id, text, emoji)` (ids 1 to 10) and `poll_votes(message_id, user_id, answer_id)`, the side rows that make an ordinary message (`kind` 0) a poll. All three cascade with the message, and `poll_votes` also with the voter's account. Counts are computed from the vote rows, never stored. `version` orders updates, and the partial index `idx_polls_open_expiry` finds the next poll to expire. (WP 6.9b)                                                                                                                |
| `074_threads.sql`                              | Adds the thread columns to `channels`: `parent_channel_id` (`ON DELETE CASCADE`, index `idx_channels_parent`), `thread_starter_message_id` (`ON DELETE SET NULL`, unique partial index `idx_channels_thread_starter`), `thread_owner_id` (`ON DELETE SET NULL`), `thread_archived`, `thread_locked`, `thread_auto_archive_minutes` (60, 1440, 4320 or 10080) and `thread_last_activity_at` (index `idx_channels_thread_open_activity`). Allows type `thread`, and adds shape triggers: a thread has a text parent, never its own nsfw, archive, category, AFK or slow mode, and its type, parent and starter never change. (WP 6.9c)              |
| `075_forums.sql`                               | Adds the forum channel type (WP 6.9d). `channels` gains `forum_require_tag`, `forum_default_auto_archive_minutes` (60, 1440, 4320 or 10080) and `thread_post_message_id` (`ON DELETE SET NULL`). Adds `forum_tags` (unique per forum ignoring case), `thread_tags` and index `idx_channels_thread_list_activity`. Widens the type and thread shape triggers: a thread's parent may be a text channel or a forum, a post has no starter, its opening-message pointer is set once, and a type change to or from `forum` is refused. `trg_messages_not_in_forum` refuses a message in a forum, and tag triggers keep tags on their forum.            |
| `076_category_permissions.sql`                 | Adds `category_overrides(category_id, role_id, allow, deny)` and `category_user_overrides(category_id, user_id, allow, deny)` (both `UNIQUE` per pair and cascading on both parents, index `idx_category_user_overrides_user` for account erasure), and `channels.permissions_synced INTEGER NOT NULL DEFAULT 0`. The category rows are a template that is **copied** onto the channels synced to the category; `permissions.EffectiveChannelPerms` never reads them. The backfill syncs nothing, so an upgraded server keeps exactly the overrides it had. (WP 6.5d)                                                                             |
| `077_user_roles_reconcile.sql`                 | Data only. Resets `user_roles` to exactly the role `users.role_id` names for every member whose rows had drifted (a demoted member still holding the old role, or a member left with no row), and moves a member whose role was missing onto the default role. (WP 6.3b)                                                                                                                                                                                                                                                                                                                                                                          |
| `078_manage_nicknames.sql`                     | Data only. Grants the new `MANAGE_NICKNAMES` bit (23) to the untouched seeded Moderator role (`0x6FFFFF` becomes `0xEFFFFF`) and clears the bit from every role except the Owner, the untouched Admin and that Moderator. No column: the nickname is `users.display_name`. (WP 6.4a)                                                                                                                                                                                                                                                                                                                                                              |
| `079_thread_members.sql`                       | Adds `thread_members(thread_id, user_id, joined_at)` (`WITHOUT ROWID`, primary key `(thread_id, user_id)`, both parents `ON DELETE CASCADE`, index `idx_thread_members_user` for account erasure) and the trigger `trg_thread_members_shape_insert`, which refuses a row whose `thread_id` is not a `type = 'thread'` channel. A row is a follow: written by creating a thread, by a send into it (the author and each direct mention, never `@everyone`), or by `thread_follow`, and removed by an unfollow. It is never permission, and every read of it is joined with the parent's visibility. (WP 6.9c)                                      |
| `080_move_members.sql`                         | Data only. Introduces the `MOVE_MEMBERS` bit (13) by clearing it on every role except the Owner: the seeded Admin (`0x3FFFFFFF` becomes `0x3FFFDFFF`) and Moderator (`0xEFFFFF` becomes `0xEFDFFF`) masks carried it as an unused bit, and a role that kept it would gain the power to move any member. Nobody gains a permission; `MUTE_MEMBERS` still moves lower-ranked members. No column. (WP 8.4a)                                                                                                                                                                                                                                          |
| `081_manage_backups.sql`                       | Data only. Introduces the `MANAGE_BACKUPS` bit (14) by clearing it on every role except the Owner: the seeded Admin (`0x3FFFDFFF` becomes `0x3FFF9FFF`) and Moderator (`0xEFDFFF` becomes `0xEF9FFF`) masks carried it as an unused bit, and a role that kept it would gain the power to take and download a backup. Nobody gains a permission; restore, delete and the full archive stay Owner-only. No column. (WP 8.4c)                                                                                                                                                                                                                        |
| `082_owner_type_permissions.sql`               | Data only. Introduces seven owner-type permission bits (`MANAGE_CONFIG` 2, `MANAGE_UPDATES` 3, `MANAGE_TOKENS` 4, `ISSUE_RECOVERY` 7, `VIEW_DIAGNOSTICS` 8, `RESTORE_BACKUPS` 15, `ERASE_ACCOUNTS` 28) by clearing them (mask `0x1000819C`) on every role except the Owner: the seeded Admin (`0x3FFF9FFF` becomes `0x2FFF1E63`) and Moderator (`0xEF9FFF` becomes `0xEF1E63`) masks carried them as unused bits, and a role that kept one would gain a power it never had. Nobody gains a permission; an Administrator keeps diagnostics and account erasure through `ADMINISTRATOR`. No column. (WP 8.4d)                                       |
| `083_stickers.sql`                             | Custom stickers (WP 8.8a). Adds `stickers`, the server-wide sticker set managed with MANAGE_SERVER like `emoji` (`name` unique ignoring case via `COLLATE NOCASE`, optional related `emoji`, `filename` the storage id, `uploaded_by` with no `ON DELETE` action so erasure moves the row to an heir), and `message_stickers`, the side row that makes a message a sticker message (`message_id` cascades with its message, `sticker_id` goes `NULL` when the sticker is deleted, `name` is the label kept from send time). `idx_message_stickers_sticker` serves that `SET NULL`.                                                                |
| `084_attachment_voice.sql`                     | Adds `attachments.duration_ms` (INTEGER) and `attachments.waveform` (TEXT), both nullable and NULL except on a voice message: the clip length in milliseconds and its base64url amplitude bytes (WP 8.9). 083 is reserved by another lane, so the history has a gap.                                                                                                                                                                                                                                                                                                                                                                              |
| `085_session_identity_key.sql`                 | Adds `sessions.identity_public_key` (TEXT, nullable): the device identity public key a connection sent in its `auth` frame, so each signed-in device carries its own voice E2EE key (key per device). NULL for a session that never connected with one. `users.identity_public_key` is unchanged.                                                                                                                                                                                                                                                                                                                                                 |
| `086_channel_password.sql`                     | Adds an optional password to voice channels: `channels.password_hash` (bcrypt, NULL = none, never returned by any API), `channels.password_version` (goes up on every set, change or removal), and `channel_password_grants(channel_id, user_id, password_version, granted_at)`, which records who entered the current password so the member is not asked again until it changes. Both parents cascade.                                                                                                                                                                                                                                          |
| `087_discord_import.sql`                       | Adds `channels.import_pending` (1 while an import is still building the channel; every client-facing channel read skips it), the `import_jobs` table (one row per Discord import, one running at a time) and `message_import_authors` (the Discord name and colour an imported message is shown under). A `users` row with `registration_status = 'system'` is the hidden account that owns imported messages. It is created by the first import, and a unique index keeps it to one.                                                                                                                                                             |

---

## Table index (generated)

<!-- gendocs:schema:start -->

Generated from the migrated schema by `cd Server && go run -tags otel,wazero ./cmd/gendocs` — do not edit by hand; `make docs-verify` fails when it drifts. 80 tables: `sqlite_sequence` and the FTS5 shadow tables behind `messages_fts` are included; the `sqlite_stat*` tables `ANALYZE` writes are not, since they hold planner statistics and which of them exists depends on the SQLite build.

| Table                       | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Indexes                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_tokens`                | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `token_hash TEXT NOT NULL`, `label TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_used_at TEXT`, `expires_at TEXT`, `revoked_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `idx_api_tokens_user`, `sqlite_autoindex_api_tokens_1`                                                                                                                                                                          |
| `appeals`                   | `id INTEGER PK`, `public_id TEXT NOT NULL`, `action_id INTEGER NOT NULL`, `appellant_id INTEGER NOT NULL`, `body TEXT NOT NULL`, `state TEXT NOT NULL`, `assignee_id INTEGER NOT NULL`, `decided_by INTEGER NOT NULL`, `decided_by_token TEXT`, `decision_note TEXT NOT NULL`, `created_at TEXT NOT NULL`, `decided_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_appeals_state`, `sqlite_autoindex_appeals_1`, `sqlite_autoindex_appeals_2`                                                                                                                                                 |
| `attachments`               | `id TEXT PK`, `message_id INTEGER`, `filename TEXT NOT NULL`, `stored_as TEXT NOT NULL`, `mime_type TEXT NOT NULL`, `size INTEGER NOT NULL`, `uploaded_at TEXT NOT NULL`, `width INTEGER`, `height INTEGER`, `uploader_id INTEGER`, `duration_ms INTEGER`, `waveform TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `idx_attachments_message`, `idx_attachments_uploader`, `sqlite_autoindex_attachments_1`                                                                                                                                         |
| `audit_log`                 | `id INTEGER PK`, `actor_id INTEGER NOT NULL`, `action TEXT NOT NULL`, `target_type TEXT NOT NULL`, `target_id INTEGER NOT NULL`, `detail TEXT NOT NULL`, `created_at TEXT NOT NULL`, `subject_token TEXT`, `actor_token TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_audit_log_action`, `idx_audit_log_actor`, `idx_audit_log_actor_token`, `idx_audit_log_subject_token`, `idx_audit_timestamp`                                                                                                |
| `category_overrides`        | `category_id INTEGER NOT NULL`, `role_id INTEGER NOT NULL`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `sqlite_autoindex_category_overrides_1`                                                                                                                                                                                         |
| `category_user_overrides`   | `category_id INTEGER NOT NULL`, `user_id INTEGER NOT NULL`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_category_user_overrides_user`, `sqlite_autoindex_category_user_overrides_1`                                                                                                                                                |
| `channel_categories`        | `id INTEGER PK`, `name TEXT NOT NULL`, `position INTEGER NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `idx_channel_categories_name`                                                                                                                                                                                                   |
| `channel_overrides`         | `id INTEGER PK`, `channel_id INTEGER NOT NULL`, `role_id INTEGER NOT NULL`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_channel_overrides_role`, `sqlite_autoindex_channel_overrides_1`                                                                                                                                                            |
| `channel_password_grants`   | `channel_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`, `password_version INTEGER NOT NULL`, `granted_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `idx_channel_password_grants_user`                                                                                                                                                                                              |
| `channel_retention`         | `channel_id INTEGER PK`, `days INTEGER NOT NULL`, `updated_by INTEGER NOT NULL`, `updated_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                               |
| `channel_user_overrides`    | `channel_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `idx_channel_user_overrides_user`, `sqlite_autoindex_channel_user_overrides_1`                                                                                                                                                  |
| `channels`                  | `id INTEGER PK`, `name TEXT NOT NULL`, `type TEXT NOT NULL`, `category TEXT`, `topic TEXT`, `position INTEGER NOT NULL`, `slow_mode INTEGER NOT NULL`, `archived INTEGER NOT NULL`, `created_at TEXT NOT NULL`, `voice_max_users INTEGER NOT NULL`, `voice_quality TEXT`, `mixing_threshold INTEGER`, `voice_max_video INTEGER NOT NULL`, `nsfw INTEGER NOT NULL`, `is_group INTEGER NOT NULL`, `dm_owner_id INTEGER`, `dm_icon TEXT`, `afk INTEGER NOT NULL`, `category_id INTEGER`, `parent_channel_id INTEGER`, `thread_starter_message_id INTEGER`, `thread_owner_id INTEGER`, `thread_archived INTEGER NOT NULL`, `thread_locked INTEGER NOT NULL`, `thread_auto_archive_minutes INTEGER NOT NULL`, `thread_last_activity_at TEXT`, `forum_require_tag INTEGER NOT NULL`, `forum_default_auto_archive_minutes INTEGER NOT NULL`, `thread_post_message_id INTEGER`, `permissions_synced INTEGER NOT NULL`, `password_hash TEXT`, `password_version INTEGER NOT NULL`, `import_pending INTEGER NOT NULL` | `idx_channels_afk`, `idx_channels_category_id`, `idx_channels_dm_group`, `idx_channels_dm_icon`, `idx_channels_parent`, `idx_channels_thread_list_activity`, `idx_channels_thread_open_activity`, `idx_channels_thread_starter` |
| `dm_open_state`             | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `opened_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `sqlite_autoindex_dm_open_state_1`                                                                                                                                                                                              |
| `dm_participants`           | `channel_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `idx_dm_participants_user`, `sqlite_autoindex_dm_participants_1`                                                                                                                                                                |
| `emoji`                     | `id INTEGER PK`, `shortcode TEXT NOT NULL`, `filename TEXT NOT NULL`, `uploaded_by INTEGER NOT NULL`, `created_at TEXT NOT NULL`, `mime_type TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `sqlite_autoindex_emoji_1`                                                                                                                                                                                                      |
| `erasure_jobs`              | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `state TEXT NOT NULL`, `files TEXT NOT NULL`, `files_removed INTEGER NOT NULL`, `attempts INTEGER NOT NULL`, `last_error TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `finished_at TEXT`, `replay_purged INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `idx_erasure_jobs_state`                                                                                                                                                                                                        |
| `events`                    | `seq INTEGER PK`, `event_type TEXT NOT NULL`, `payload BLOB NOT NULL`, `channel_id INTEGER NOT NULL`, `created_at TIMESTAMP NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `idx_events_channel_seq`, `idx_events_created_at`                                                                                                                                                                               |
| `forum_tags`                | `id INTEGER PK`, `forum_id INTEGER NOT NULL`, `name TEXT NOT NULL`, `emoji TEXT`, `position INTEGER NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `idx_forum_tags_name`                                                                                                                                                                                                           |
| `gif_favorites`             | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `url TEXT NOT NULL`, `preview_url TEXT NOT NULL`, `title TEXT NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `sqlite_autoindex_gif_favorites_1`                                                                                                                                                                                              |
| `import_jobs`               | `id INTEGER PK`, `channel_id INTEGER`, `created_by INTEGER`, `source_name TEXT NOT NULL`, `discord_channel_id TEXT NOT NULL`, `status TEXT NOT NULL`, `total INTEGER NOT NULL`, `imported INTEGER NOT NULL`, `skipped INTEGER NOT NULL`, `skipped_attachments INTEGER NOT NULL`, `error TEXT`, `created_at TEXT NOT NULL`, `finished_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_import_jobs_one_running`                                                                                                                                                                                                   |
| `invite_redemptions`        | `id INTEGER PK`, `invite_id INTEGER NOT NULL`, `user_id INTEGER`, `redeemed_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_invite_redemptions_invite`, `idx_invite_redemptions_user`                                                                                                                                                                  |
| `invites`                   | `id INTEGER PK`, `code TEXT NOT NULL`, `created_by INTEGER NOT NULL`, `redeemed_by INTEGER`, `max_uses INTEGER`, `use_count INTEGER NOT NULL`, `expires_at TEXT`, `created_at TEXT NOT NULL`, `revoked INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `sqlite_autoindex_invites_1`                                                                                                                                                                                                    |
| `login_attempts`            | `id INTEGER PK`, `ip_address TEXT NOT NULL`, `username TEXT`, `success INTEGER NOT NULL`, `timestamp TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `idx_login_ip`                                                                                                                                                                                                                  |
| `member_generation`         | `id INTEGER PK`, `generation INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                               |
| `mention_receipts`          | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `message_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `idx_mention_receipts_message`                                                                                                                                                                                                  |
| `message_call_participants` | `message_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `idx_message_call_participants_user`, `sqlite_autoindex_message_call_participants_1`                                                                                                                                            |
| `message_calls`             | `message_id INTEGER PK`, `channel_id INTEGER NOT NULL`, `started_at TEXT NOT NULL`, `ended_at TEXT`, `last_seen_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `idx_message_calls_open`                                                                                                                                                                                                        |
| `message_delivery_receipts` | `user_id INTEGER NOT NULL PK`, `client_message_id TEXT NOT NULL PK`, `channel_id INTEGER NOT NULL`, `payload_hash BLOB NOT NULL`, `message_id INTEGER NOT NULL`, `timestamp TEXT NOT NULL`, `expires_at_ms INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_message_delivery_receipts_expiry`, `sqlite_autoindex_message_delivery_receipts_1`                                                                                                                                          |
| `message_forwards`          | `message_id INTEGER PK`, `source_message_id INTEGER`, `source_channel_id INTEGER NOT NULL`, `source_timestamp TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_message_forwards_source`                                                                                                                                                                                                   |
| `message_group_events`      | `message_id INTEGER PK`, `target_user_id INTEGER`, `name TEXT`, `icon_removed INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `idx_message_group_events_target`                                                                                                                                                                                               |
| `message_import_authors`    | `message_id INTEGER PK`, `discord_user_id TEXT NOT NULL`, `name TEXT NOT NULL`, `color TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                               |
| `message_mentions`          | `message_id INTEGER NOT NULL PK`, `mentioned_user_id INTEGER NOT NULL PK`, `reply_ping INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `idx_message_mentions_user`, `sqlite_autoindex_message_mentions_1`                                                                                                                                                              |
| `message_requests`          | `id INTEGER PK`, `sender_id INTEGER NOT NULL`, `recipient_id INTEGER NOT NULL`, `channel_id INTEGER NOT NULL`, `first_message_id INTEGER`, `state TEXT NOT NULL`, `created_at TEXT NOT NULL`, `decided_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `idx_message_requests_recipient_state`, `sqlite_autoindex_message_requests_1`                                                                                                                                                   |
| `message_role_mentions`     | `message_id INTEGER NOT NULL PK`, `role_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                               |
| `message_stickers`          | `message_id INTEGER PK`, `sticker_id INTEGER`, `name TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `idx_message_stickers_sticker`                                                                                                                                                                                                  |
| `messages`                  | `id INTEGER PK`, `channel_id INTEGER NOT NULL`, `user_id INTEGER NOT NULL`, `content TEXT NOT NULL`, `reply_to INTEGER`, `edited_at TEXT`, `deleted INTEGER NOT NULL`, `pinned INTEGER NOT NULL`, `timestamp TEXT NOT NULL`, `mentions_everyone INTEGER NOT NULL`, `pinned_at TEXT`, `kind INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_messages_channel`, `idx_messages_pinned`, `idx_messages_reply_to`, `idx_messages_user`                                                                                                                                     |
| `messages_fts`              | `content`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                               |
| `messages_fts_config`       | `k NOT NULL PK`, `v`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                               |
| `messages_fts_data`         | `id INTEGER PK`, `block BLOB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                               |
| `messages_fts_docsize`      | `id INTEGER PK`, `sz BLOB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                               |
| `messages_fts_idx`          | `segid NOT NULL PK`, `term NOT NULL PK`, `pgno`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                               |
| `moderation_actions`        | `id INTEGER PK`, `kind TEXT NOT NULL`, `target_id INTEGER NOT NULL`, `actor_id INTEGER NOT NULL`, `actor_token TEXT`, `report_id INTEGER`, `reason TEXT NOT NULL`, `expires_at TEXT`, `acknowledged_at TEXT`, `lifted_at TEXT`, `lifted_by INTEGER NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `idx_moderation_actions_report`, `idx_moderation_actions_target`, `idx_moderation_actions_timeouts`                                                                                                                             |
| `nsfw_acknowledgements`     | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `acknowledged_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `sqlite_autoindex_nsfw_acknowledgements_1`                                                                                                                                                                                      |
| `partial_auth_challenges`   | `token_hash TEXT PK`, `user_id INTEGER NOT NULL`, `device TEXT NOT NULL`, `ip_address TEXT NOT NULL`, `failures INTEGER NOT NULL`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_partial_auth_challenges_expires`, `idx_partial_auth_challenges_user`, `sqlite_autoindex_partial_auth_challenges_1`                                                                                                         |
| `pending_totp_enrollments`  | `user_id INTEGER PK`, `secret_enc TEXT NOT NULL`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_pending_totp_enrollments_expires`                                                                                                                                                                                          |
| `plugin_kv`                 | `plugin_id INTEGER NOT NULL PK`, `key TEXT NOT NULL PK`, `value BLOB NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `sqlite_autoindex_plugin_kv_1`                                                                                                                                                                                                  |
| `plugins`                   | `id INTEGER PK`, `name TEXT NOT NULL`, `version TEXT NOT NULL`, `enabled INTEGER NOT NULL`, `manifest_json TEXT NOT NULL`, `installed_at TIMESTAMP NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `sqlite_autoindex_plugins_1`                                                                                                                                                                                                    |
| `poll_answers`              | `message_id INTEGER NOT NULL PK`, `answer_id INTEGER NOT NULL PK`, `text TEXT NOT NULL`, `emoji TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                               |
| `poll_votes`                | `message_id INTEGER NOT NULL PK`, `answer_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `idx_poll_votes_user`                                                                                                                                                                                                           |
| `polls`                     | `message_id INTEGER PK`, `question TEXT NOT NULL`, `allow_multiselect INTEGER NOT NULL`, `expires_at TEXT NOT NULL`, `ended_at TEXT`, `version INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `idx_polls_open_expiry`                                                                                                                                                                                                         |
| `push_subscriptions`        | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `endpoint TEXT NOT NULL`, `p256dh TEXT NOT NULL`, `auth TEXT NOT NULL`, `device_name TEXT NOT NULL`, `vapid_key_id TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `idx_push_subscriptions_last_seen`, `idx_push_subscriptions_user`, `sqlite_autoindex_push_subscriptions_1`                                                                                                                      |
| `rate_lockouts`             | `key TEXT PK`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `sqlite_autoindex_rate_lockouts_1`                                                                                                                                                                                              |
| `reactions`                 | `id INTEGER PK`, `message_id INTEGER NOT NULL`, `user_id INTEGER NOT NULL`, `emoji TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `sqlite_autoindex_reactions_1`                                                                                                                                                                                                  |
| `read_states`               | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `last_message_id INTEGER NOT NULL`, `mention_count INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `sqlite_autoindex_read_states_1`                                                                                                                                                                                                |
| `recovery_assists`          | `user_id INTEGER PK`, `verifier TEXT NOT NULL`, `issued_by INTEGER NOT NULL`, `verification TEXT NOT NULL`, `created_at TEXT NOT NULL`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                               |
| `recovery_kits`             | `user_id INTEGER PK`, `verifier TEXT NOT NULL`, `created_at TEXT NOT NULL`, `used_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                               |
| `report_events`             | `id INTEGER PK`, `report_id INTEGER NOT NULL`, `actor_id INTEGER NOT NULL`, `actor_token TEXT`, `action TEXT NOT NULL`, `detail TEXT NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `idx_report_events_report`                                                                                                                                                                                                      |
| `report_evidence`           | `report_id INTEGER NOT NULL PK`, `seq INTEGER NOT NULL PK`, `message_id INTEGER`, `author_id INTEGER NOT NULL`, `author_token TEXT`, `content TEXT NOT NULL`, `attachments TEXT NOT NULL`, `captured_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `sqlite_autoindex_report_evidence_1`                                                                                                                                                                                            |
| `report_notes`              | `id INTEGER PK`, `report_id INTEGER NOT NULL`, `author_id INTEGER NOT NULL`, `author_token TEXT`, `body TEXT NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                               |
| `reports`                   | `id INTEGER PK`, `public_id TEXT NOT NULL`, `reporter_id INTEGER NOT NULL`, `reporter_token TEXT`, `subject_id INTEGER NOT NULL`, `subject_token TEXT`, `target_type TEXT NOT NULL`, `target_ref TEXT NOT NULL`, `channel_id INTEGER`, `reason TEXT NOT NULL`, `detail TEXT NOT NULL`, `state TEXT NOT NULL`, `assignee_id INTEGER NOT NULL`, `outcome TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `closed_at TEXT`, `source_nsfw INTEGER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `idx_reports_active_unique`, `idx_reports_dedupe`, `idx_reports_queue`, `idx_reports_reporter`, `idx_reports_subject`, `sqlite_autoindex_reports_1`                                                                             |
| `retention_revision`        | `id INTEGER PK`, `revision INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                               |
| `retention_runs`            | `id INTEGER PK`, `started_at TEXT NOT NULL`, `finished_at TEXT`, `channels INTEGER NOT NULL`, `messages_deleted INTEGER NOT NULL`, `files TEXT NOT NULL`, `files_removed INTEGER NOT NULL`, `purge_pending TEXT NOT NULL`, `last_error TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                               |
| `roles`                     | `id INTEGER PK`, `name TEXT NOT NULL`, `color TEXT`, `permissions INTEGER NOT NULL`, `position INTEGER NOT NULL`, `is_default INTEGER NOT NULL`, `hoist INTEGER NOT NULL`, `mentionable INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `idx_roles_name_nocase`, `sqlite_autoindex_roles_1`                                                                                                                                                                             |
| `schema_versions`           | `version TEXT PK`, `applied_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `sqlite_autoindex_schema_versions_1`                                                                                                                                                                                            |
| `sessions`                  | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `token TEXT NOT NULL`, `device TEXT`, `ip_address TEXT`, `created_at TEXT NOT NULL`, `last_used TEXT NOT NULL`, `expires_at TEXT NOT NULL`, `unseen INTEGER NOT NULL`, `identity_public_key TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `idx_sessions_expires_at`, `idx_sessions_user`, `sqlite_autoindex_sessions_1`                                                                                                                                                   |
| `settings`                  | `key TEXT PK`, `value TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `sqlite_autoindex_settings_1`                                                                                                                                                                                                   |
| `sqlite_sequence`           | `name`, `seq`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                               |
| `stickers`                  | `id INTEGER PK`, `name TEXT NOT NULL`, `emoji TEXT`, `filename TEXT NOT NULL`, `mime_type TEXT NOT NULL`, `uploaded_by INTEGER NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `sqlite_autoindex_stickers_1`                                                                                                                                                                                                   |
| `thread_members`            | `thread_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`, `joined_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `idx_thread_members_user`                                                                                                                                                                                                       |
| `thread_tags`               | `thread_id INTEGER NOT NULL PK`, `tag_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_thread_tags_tag`                                                                                                                                                                                                           |
| `totp_recovery_codes`       | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `code_hash TEXT NOT NULL`, `created_at TEXT NOT NULL`, `used_at TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `idx_totp_recovery_codes_user`                                                                                                                                                                                                  |
| `totp_used_codes`           | `user_id INTEGER NOT NULL PK`, `code_hash TEXT NOT NULL PK`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `idx_totp_used_codes_expires`, `sqlite_autoindex_totp_used_codes_1`                                                                                                                                                             |
| `trusted_senders`           | `recipient_id INTEGER NOT NULL PK`, `sender_id INTEGER NOT NULL PK`, `source TEXT NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `sqlite_autoindex_trusted_senders_1`                                                                                                                                                                                            |
| `user_blocks`               | `blocker_id INTEGER NOT NULL PK`, `blocked_id INTEGER NOT NULL PK`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `idx_user_blocks_blocked`, `sqlite_autoindex_user_blocks_1`                                                                                                                                                                     |
| `user_notes`                | `owner_id INTEGER NOT NULL PK`, `target_id INTEGER NOT NULL PK`, `note TEXT NOT NULL`, `updated_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `idx_user_notes_target`                                                                                                                                                                                                         |
| `user_privacy`              | `user_id INTEGER NOT NULL PK`, `allow_member_dms INTEGER NOT NULL`, `message_requests INTEGER NOT NULL`, `updated_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                               |
| `user_roles`                | `user_id INTEGER NOT NULL PK`, `role_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_user_roles_role`                                                                                                                                                                                                           |
| `user_storage`              | `user_id INTEGER PK`, `bytes_used INTEGER NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                               |
| `users`                     | `id INTEGER PK`, `username TEXT NOT NULL`, `password TEXT NOT NULL`, `avatar TEXT`, `role_id INTEGER NOT NULL`, `totp_secret TEXT`, `status TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_seen TEXT`, `banned INTEGER NOT NULL`, `ban_reason TEXT`, `ban_expires TEXT`, `identity_public_key TEXT`, `display_name TEXT`, `about TEXT`, `custom_status TEXT`, `registration_status TEXT NOT NULL`, `custom_status_expires_at TEXT`, `banner_id TEXT`, `banner_color TEXT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `idx_users_avatar`, `idx_users_banner_id`, `idx_users_custom_status_expires_at`, `idx_users_system_account`, `sqlite_autoindex_users_1`                                                                                         |
| `voice_states`              | `user_id INTEGER PK`, `channel_id INTEGER NOT NULL`, `muted INTEGER NOT NULL`, `deafened INTEGER NOT NULL`, `speaking INTEGER NOT NULL`, `joined_at TEXT NOT NULL`, `camera INTEGER NOT NULL`, `screenshare INTEGER NOT NULL`, `server_muted INTEGER NOT NULL`, `server_deafened INTEGER NOT NULL`, `server_muted_by INTEGER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `idx_voice_states_channel`                                                                                                                                                                                                      |

<!-- gendocs:schema:end -->

## The deletion-marker file (`data/erasure/markers.sqlite`)

A second SQLite database, applied by the server itself on open
(`Server/db/markers.go`, not by the migrations), kept outside the file a
backup restore overwrites so its markers survive the restore they defend
against (B4-10, BPR-053). `subject_token` is HMAC-SHA256 of the user id under
`data/erasure.key`; the file names nobody without the key.

```sql
CREATE TABLE IF NOT EXISTS deletion_markers (
    subject_token TEXT    PRIMARY KEY,
    scope         TEXT    NOT NULL CHECK (scope IN ('account', 'messages')),
    channel_id    INTEGER,
    cutoff        TEXT,
    state         TEXT    NOT NULL DEFAULT 'recorded' CHECK (state IN ('pending', 'recorded')),
    erased_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    replays       INTEGER NOT NULL DEFAULT 0,
    last_replay   TEXT
);

CREATE TABLE IF NOT EXISTS sequence_floors (
    name TEXT    PRIMARY KEY,
    seq  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS floor_probes (
    name      TEXT PRIMARY KEY,
    probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS marker_meta (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

`state` is the erasure's two-phase protocol: `pending` is written before the
erasure transaction (after its refusals have been checked) and becomes
`recorded` after the commit; a refused erasure discards its pending marker. A
pending marker left by a crash is applied on the next open like a recorded
one when its account is present — a restore can revert the commit it was
waiting on, so the main database cannot say whether it happened, and the
request behind the marker was authorised — and confirmed when the account
is gone. `scope = messages` with `channel_id` and `cutoff` is B4-11's
retention marker. `replays` counts the restores the marker undid.
`marker_meta` holds one row, `erasure-key-fingerprint`: HMAC-SHA256 of the
literal `owncord-marker-fingerprint` under the erasure key, so the file
records which key its tokens were computed under without holding the key.
The server refuses to open a file whose fingerprint is not the running key's,
and refuses to adopt a key for a file that holds markers and no fingerprint
(docs/security.md, "Erasure marker key") — under the wrong key every token
misses, the replay erases nothing, and a restored backup's erased accounts
serve on.

`sequence_floors` keeps the `AUTOINCREMENT` counters (`sqlite_sequence`) of
the tables whose ids the markers name, as they stood when a marker was
written. A restore rolls `sqlite_sequence` back with the rest of the file, and
the next row would take an id a marker still names; every open raises the
counters to these floors before the markers are replayed, so an id is never
handed out twice across restored timelines. A file written before the floors
existed has none, or only ones a later erasure wrote: `floor_probes` records
that the ids its markers name have been recovered from the tokens themselves
(`MarkerStore.LocateSequenceFloor`) and the floor merged, which is what lets
later opens skip that work — a floor row alone does not prove it. It is also
the operator's acknowledgement of a floor they set by hand, the way out when
a marker names an id past the probe's reach (`docs/security.md`, "Erasure
marker sequence floors").

---

## Tables

### roles

Defines permission tiers.

```sql
CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0,
    hoist       INTEGER NOT NULL DEFAULT 0,  -- 067: own member-list group
    mentionable INTEGER NOT NULL DEFAULT 0   -- 067: members may ping the role
);
```

Migration 067 set `hoist = 1` on every role that existed then (each was a
member-list group); roles created afterwards start at 0. Neither flag is read
by any behaviour yet.

`user_roles` (migration 067) holds every role a member has:

```sql
CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
) WITHOUT ROWID;
CREATE INDEX idx_user_roles_role ON user_roles(role_id, user_id);
```

The trigger `user_roles_on_user_insert` gives every newly inserted user a row
for their `role_id`, whichever writer inserted it. The `member_generation_*`
triggers bump the member generation on a `user_roles` insert or delete and on a
`roles` hoist or color edit. `message_role_mentions(message_id, role_id)` holds
the roles whose `<@&id>` ping cleared the role-mention gate, written with the
message's `message_mentions` rows and rewritten on edit; it cascades with the
message.

**Default roles** — current values after the full migration set (001 seeds
different masks: 005/007 raise Member's, 022 grants `MENTION_EVERYONE` to
Owner/Admin/Moderator, 048 and 078 grant the Moderator `MODERATE_MEMBERS` and `MANAGE_NICKNAMES`, 080 and 081 clear the unused bits 13 and 14, and 082 clears bits 2, 3, 4, 7, 8, 15 and 28, on every role but the Owner). Not fixed at runtime — see _Role semantics_ below:

| id  | name      | color     | permissions  | position | Notes                                                                                                                                                                                                                                                       |
| --- | --------- | --------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Owner     | `#E74C3C` | `0x7FFFFFFF` | 100      | All 31 permission bits set                                                                                                                                                                                                                                  |
| 2   | Admin     | `#F39C12` | `0x2FFF1E63` | 80       | Everything except ADMINISTRATOR, MOVE_MEMBERS, MANAGE_BACKUPS and the seven owner-type bits (MANAGE_CONFIG, MANAGE_UPDATES, MANAGE_TOKENS, ISSUE_RECOVERY, VIEW_DIAGNOSTICS, RESTORE_BACKUPS, ERASE_ACCOUNTS)                                               |
| 3   | Moderator | `#3498DB` | `0x00EF1E63` | 60       | Messages, voice (connect, speak, video, share), manage messages and channels, kick and ban, mention-everyone, moderate-members, manage-nicknames; no `MUTE_MEMBERS` (voice moderation), no `MOVE_MEMBERS`, no `MANAGE_BACKUPS`, none of the owner-type bits |
| 4   | Member    | NULL      | `0x1E63`     | 40       | Send, read, attach, react, voice, video, screen share                                                                                                                                                                                                       |

**Role semantics:**

- **`name`** is unique case-insensitively. The column's own `UNIQUE` constraint
  uses SQLite's default BINARY collation, so migration `023` adds
  `idx_roles_name_nocase` (`UNIQUE … ON roles(name COLLATE NOCASE)`) —
  otherwise "Moderator" and "moderator" would be two roles the client, which
  resolves names case-insensitively, could not tell apart. Max 32 characters.
- **`color`** is `#rgb` or `#rrggbb` (stored uppercase) or `NULL`. It is
  rendered directly into a style attribute by the desktop client and the admin
  panel, so no other form is accepted.
- **`position`** is the hierarchy rank — higher outranks lower. Every
  moderation and role-management check is "actor's position strictly greater
  than the target's". Positions are not required to be contiguous, but
  `PATCH /admin/api/roles/reorder` normalizes the roles below the actor to
  `N…1`, which keeps them unique. Position `100`
  (`permissions.OwnerRolePosition`) is the top: nothing outranks it, which is
  what makes the seeded Owner role uneditable and undeletable.
- **`is_default`** marks the single fallback role. New users are created on it
  and members of a deleted role are moved onto it, so it cannot itself be
  deleted. It is set by migration and is not writable through the API — which
  role is the fallback is a schema decision, not an operator one.
- Roles are created, edited, deleted and reordered through
  `/admin/api/roles` (`MANAGE_ROLES` + hierarchy; see `docs/api.md`). Deleting
  a role reassigns its members and drops its `channel_overrides` rows in one
  transaction. `users.role_id` stays the member's top role (highest
  `position`, ties by lowest `id`) as a display and rank mirror. Permission
  checks read `user_roles` (067), the membership table behind it: a member's
  server-level permissions are the OR of every held role's mask, and
  `ADMINISTRATOR` in any held role bypasses. Rows are written through
  `db.AddUserRole`, `db.RemoveUserRole`, `db.UpdateUserRole` (replaces every
  role with one) and `db.DeleteRoleReassigning` (members left with no role get
  the default role), each re-mirroring `role_id` in the same transaction, and
  by the user-insert trigger. Migration 073 reconciled any database where the
  two had drifted apart.

---

### users

```sql
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT,
    identity_public_key TEXT,
    display_name  TEXT,
    about         TEXT,
    custom_status TEXT
);

CREATE INDEX idx_users_avatar ON users(avatar) WHERE avatar IS NOT NULL;
```

Valid status values: `online`, `idle`, `dnd`, `invisible`, `offline`.

`registration_status` (migration 034) is `active`, `pending`, `denied`, or
`system` (migration 087). The one `system` row is the hidden account that owns
every message a Discord import writes (see
[Discord import](#import_jobs-and-message_import_authors)). The first import
creates it, named `[imported]` (the `[imported` prefix is reserved at
registration), and a unique index allows at most one. Its `password` is `!`,
which is not a bcrypt hash, so no password check can match it, and the sign-in
path refuses the account kind as well. It has no `user_roles` row, no session
and no token. It is not in the member list, the admin member list, role or
`@everyone` mentions, name lookups for mentions and search, a direct message
or a group DM (recipients must be `active`), the member count or the count that
tells a fresh server from a set-up one.

`status` holds the status the user **chose**, `invisible` included — it is
deliberately not collapsed to `offline` at the write, because the server has to
be able to tell "chose to appear offline" from "is not connected" on the next
connect. The collapse happens at read time instead (`db.BroadcastStatus` /
`StatusForViewer`): every payload another user can see maps `invisible` to
`offline`, while the owner's own payloads keep the true value.

A chosen `idle`/`dnd`/`invisible` therefore survives a disconnect (only
`online` is cleared, by `StampUsersDisconnected`) and survives a server restart
(`ResetAllUserStatuses` clears only `online`). The server batches the connect
and disconnect stamps and writes them at most 2 seconds late
(`service.ConnWrites`); a crash loses that window, and the boot-time reset
clears the `online` it leaves behind. It cannot render as "present" in
the meantime because the ready payload treats a member with no live connection
as `offline` regardless of the column.

`identity_public_key` (added in migration 017) is the user's long-term E2EE
identity public key (base64 ECDSA P-256) used for TOFU pinning of voice E2EE
announces; `NULL` = not published (legacy client).

`display_name`, `about` and `custom_status` (migration 027) are the profile
fields, all `NULL` when unset. Bounds — 32, 300 and 128 characters
respectively — are enforced in the service layer, where the HTML sanitizer runs
and a violation can answer `400` instead of a constraint error. `display_name`
is display only: `@mentions` resolve against `username`, which is the unique,
case-insensitive key.

`idx_users_avatar` covers the file route's authorization probe. An avatar
uploaded through `POST /api/v1/users/me/avatar` is an attachment with no
channel — private to its uploader by default — and `GET /api/v1/files/{id}`
additionally admits one that some user's `avatar` currently equals, so an
avatar is readable by every authenticated user for exactly as long as it is in
use.

`idx_users_banner_id` covers the same probe for `users.banner_id` (migration
069), the profile banner image. It names an attachment the way
`channels.dm_icon` does, and `GET /api/v1/files/{id}` admits the file to every
authenticated user for exactly as long as a `banner_id` names it. `banner_color`
is the optional colour, stored lower-case as `#rgb` or `#rrggbb`.

---

### sessions

```sql
CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    unseen     INTEGER NOT NULL DEFAULT 0,
    identity_public_key TEXT
);
```

`identity_public_key` (migration 085) is the voice E2EE identity public key the device sent in its WebSocket `auth` frame, rewritten on every connect and NULL until a device that sends one connects. Each device has its own key, so it lives on the session, not the user; `users.identity_public_key` is unchanged.

Session TTL: 30 days after last use (`TouchSessions` slides `expires_at`), capped at 365 days after `created_at`. Touches are batched and flushed once a minute (and at shutdown), so `last_used` and the slide lag the use by at most 60 seconds; a flush never revives a lapsed row, so a session used in the last 60 seconds before its idle expiry can lapse before the flush slides it, signing the user out. Revocation deletes the row without waiting on it. Token is stored as SHA-256 hash.

---

### api_tokens

```sql
CREATE TABLE api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
);
```

Long-lived, revocable bearer tokens for headless clients (bots, CI, the introspection
MCP tool). A token authenticates as `user_id`, inheriting that user's role/permissions,
and is resolved by the same middleware as sessions (see `auth.ResolveTokenHash`). Only the
SHA-256 hash is stored; the raw token is shown once at creation. `expires_at` NULL = never
expires; `revoked_at` NULL = active. Mint/list/revoke via `server token …`. Kept in a
separate table from `sessions` so the per-user session cap never affects these; the
revocation paths are in [`docs/api.md`](api.md#api-tokens).

---

### channels

```sql
CREATE TABLE channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,           -- legacy, unused since 072 (see category_id)
    category_id      INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 25,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0,
    parent_channel_id           INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    thread_starter_message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_owner_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    thread_archived             INTEGER NOT NULL DEFAULT 0,
    thread_locked               INTEGER NOT NULL DEFAULT 0,
    thread_auto_archive_minutes INTEGER NOT NULL DEFAULT 1440,
    thread_last_activity_at     TEXT,
    forum_require_tag           INTEGER NOT NULL DEFAULT 0,
    forum_default_auto_archive_minutes INTEGER NOT NULL DEFAULT 4320,
    thread_post_message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    import_pending              INTEGER NOT NULL DEFAULT 0
);
```

Channel types: `text`, `voice`, `announcement`, `dm`, `thread`, `forum`. Migration 013
installs INSERT/UPDATE triggers restricting the value to this set (migration 016
added `announcement`, migration 074 `thread`, migration 075 `forum`).

A `thread` row (migration 074) sits under a text channel (`parent_channel_id`)
and takes its permission overrides, NSFW label, archive flag, slow mode and
retention from that parent: the channel queries return the parent's values for
it, and the single-channel override and NSFW acknowledgement queries resolve
its id to the parent's. Triggers keep a thread from carrying any of that state
itself and keep its type, parent and starter fixed. `thread_archived` is the
thread's own idle state, not `archived`: an idle thread stays readable.
A `forum` row (migration 075) is a channel that holds no messages
(`trg_messages_not_in_forum` refuses one). It sits in categories and takes
overrides, NSFW, slow mode, archive and retention exactly like a text channel,
and its posts are `thread` rows whose parent is the forum, with no starter
message: the thread shape triggers accept a text channel or a forum as a
thread's parent, and "is this a forum post" is answered by the parent's type,
never by the starter being NULL. Creating a post (`forum_post_create`) inserts the thread, its tag links, its first message and the `thread_post_message_id` pointer in the one delivery transaction, and the `client_message_id` receipt is keyed on the forum. `forum_require_tag` and
`forum_default_auto_archive_minutes` mean something only on a forum row, and
the triggers refuse them elsewhere. A post's `thread_post_message_id` is its
opening message, set once to a message in that post. The guidelines are the
forum's `topic`.

```sql
CREATE TABLE forum_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    forum_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    emoji      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX idx_forum_tags_name ON forum_tags(forum_id, name COLLATE NOCASE);

CREATE TABLE thread_tags (
    thread_id INTEGER NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, tag_id)
) WITHOUT ROWID;
```

Deleting a forum cascades its posts, their messages, its tags and the links;
deleting a tag removes only its links. The 20-tags-per-forum cap and the name
length are service rules checked inside the writer transaction.

`ListChannels` returns parent channels only. Announcement channels are readable like text channels but
posting is restricted to users with `MANAGE_MESSAGES` (enforced in the service
layer, `Server/service/message.go`).

`category_id` (migration 072) points at a `channel_categories` row, NULL for an
uncategorized channel. A category is a real object (`id`, `name`, `position`),
so renaming it is one write and an empty one can exist; deleting it leaves its
channels in place with `category_id` NULL. Names are unique ignoring ASCII
case. Channel name uniqueness (a service check, not a constraint) is per
`(type, category_id)`. `channels.category` is the pre-072 free-text column: no
reader or writer touches it any more, and it stays only so the reversal in
`Server/rollback` returns the schema exactly.

```sql
CREATE TABLE channel_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_channel_categories_name ON channel_categories(name COLLATE NOCASE);
```

`nsfw` (migration 025) is the age-restriction flag, stored 0/1 like `archived`
because SQLite has no boolean type. **It drives nothing server-side.** The
server stores it, ships it in `ready` and in the `channel_create` /
`channel_update` broadcasts, and audits an operator flipping it — it does not
filter content, check anyone's age, or restrict who may read or post in a
flagged channel. Clients decide what the flag means to them; the desktop client
shows a one-time-per-session warning before rendering the channel and marks it
in the sidebar.

`voice_max_users` and `voice_max_video` (0 = unlimited) are the only channel
columns that _are_ enforced by the server, on voice join and on video publish
respectively (`CHANNEL_FULL` / `VIDEO_LIMIT`). They exist on every row but are
meaningless on a non-voice channel.

`is_group` (migration 028) marks a `dm` channel as a group DM. It is decided
once at creation and **never recomputed from the live participant count**,
because that count changes underneath you:

- A group of three that two people leave has two participants, and the 1:1
  lookup — "the dm channel both of these users are in" — would then match it.
  "Message Bob" would silently deliver into the remnants of a group, in front of
  whoever else is still there.
- Leaving is destructive for a group (removal from `dm_participants`) and
  non-destructive for a 1:1 (hide only). Deriving which one to run from the live
  count means the third-from-last leaver runs a different operation than the
  second-from-last, for no reason the user can see.

`name` carries the optional group name; it is `''` for every 1:1 DM (a
two-person DM is named by who is in it) and for an unnamed group.

`PATCH /admin/api/channels/{id}` or `PATCH /api/v1/moderation/channels/{id}` (`MANAGE_CHANNELS`) is the write path for
`slow_mode` (0…21600), `nsfw` and both voice limits (0…99 each); values outside
those ranges are refused rather than clamped.

---

### channel_overrides

Per-channel permission overrides for specific roles.

```sql
CREATE TABLE channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);
```

Effective permission calculation for this layer:
`effective = (base_permissions & ~deny) | allow`

This is the ROLE layer. The per-member layer (`channel_user_overrides`) is
applied on top of the result — see "Permission Checking Logic" below.

---

### channel_user_overrides

Per-channel permission overrides for a single **member**, independent of their
role. This is Discord's narrowest override layer: it grants or refuses one
person a bit in one channel without minting a role for them.

```sql
CREATE TABLE channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
```

The shape mirrors `channel_overrides` (allow/deny masks, cascade on both
parents) so both layers are fetched and merged by the same code
(`db.GetMemberGrants`). The composite PRIMARY KEY replaces the surrogate
`id` + `UNIQUE` pair `channel_overrides` carries — nothing references an
override row by id.

Only members who actually carry an override have a row: an all-inherit override
is deleted rather than stored as `(0, 0)`.

---

### messages

```sql
CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
    mentions_everyone INTEGER NOT NULL DEFAULT 0
);
```

Messages are soft-deleted (`deleted = 1`), never physically removed by user action.

`mentions_everyone` (migration 022) is set when the message carried `@everyone`
or `@here` **and** the author held `MENTION_EVERYONE` on that channel. It is a
column rather than a sentinel row in `message_mentions` so that table never
holds a `mentioned_user_id` that is not a real user. The message row and its
mention rows are written in one writer transaction, and an edit rewrites both.

`kind` (migration 064, `INTEGER NOT NULL DEFAULT 0`) is 0 for a message a user
sent and 1 for a call log row. Only the server's call log worker writes kind 1
(`db.CreateCallLog`), one row per DM call, with its `message_calls` and
`message_call_participants` rows. While someone is in the call the worker keeps
`message_calls.last_seen_at` current; when the room has been empty for 10
seconds it sets `ended_at` to the last leave and rewrites the fallback
`content`. At start-up it ends any call still open at its `last_seen_at`, since
a restart clears voice and no call survives it. Call rows are never edited,
soft-deleted or pinned by a user.

Kinds 2 to 6 (migration 065) are the group DM event rows `group_add`,
`group_remove`, `group_leave`, `group_rename` and `group_icon`, with their detail
in `message_group_events`: `target_user_id` for add and remove (`ON DELETE
CASCADE`, and erasure deletes the row), `name` for rename (`''` means removed)
and `icon_removed` for icon. They are read-only like call rows and only the
server may write them: adding a member writes `group_add` (author = the adder),
the owner removing one writes `group_remove`, a leave writes `group_leave`
(author = the leaver, none for the last leaver) and a changed name writes
`group_rename`, and an icon set or removed writes `group_icon`, each in the same
transaction as the change.

Kind 7 is the pin row `pin_add` (WP 6.12, no migration). Its `reply_to` holds the
pinned message id (`ON DELETE SET NULL`, so a purged target leaves the row with a
null link), its author is the pinner and `content` is the English fallback. It is
written by `SetMessagePinned` in the pin's own transaction, once per message per
10 minutes and never for a re-pin. Unlike kinds 1 to 6 it is soft-deletable and
purgeable like a message (`kind IN (0, 7)`).

Kind 8 is the welcome row `member_join` (WP 8.6, no migration). Its author is the new
member, `reply_to` is null and `content` is the English fallback
`<username> joined the server.`. It is written by `InsertWelcomeRow` after the account
commits (never in its transaction), into the channel named by the `welcome_channel_id`
setting when that is an existing, non-archived text channel, and the new member's
`read_states` row is advanced past it in the same transaction. It is soft-deletable and
purgeable like a pin row (`kind IN (0, 7, 8)`) and, unlike the other system rows, a
valid `reply_to` target.

`channels.dm_owner_id` (migration 065) names a group DM's owner. A group with at
least one member always has an owner who is a member: create sets it to the
creator, a leave runs one statement that gives a missing or departed owner to
the lowest remaining member id that is not banned from the server (the lowest
member id when every member is banned), an owner transfer names another member,
and an erasure hands each group the erased user owned to the same member.

`channels.dm_icon` (migration 066) is the attachment id of a group DM's icon, NULL
for none and always NULL for a 1:1 DM. The file is an `attachments` row with no
message. It is served to the group's members only, and only while this column
names it. A replaced or cleared icon is an ordinary unlinked row and the orphan
sweep reclaims it. The sweep, the uploader's discard and message linking skip an
attachment a channel's `dm_icon` names. Erasing the user who uploaded it deletes
the attachment, and the foreign key then clears the group's icon.

---

### message_mentions

```sql
CREATE TABLE message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    reply_ping        INTEGER NOT NULL DEFAULT 0, -- migration 060
    PRIMARY KEY (message_id, mentioned_user_id)
);

CREATE INDEX idx_message_mentions_user ON message_mentions(mentioned_user_id);
```

The user IDs a message resolved from its `@username` tokens, capped at 20 rows
per message. A row with `reply_ping = 1` (migration 060) is the replied-to
author a `chat_send` with `reply_ping` added; it is extra to the 20, an edit
keeps it while rewriting the other rows, and a content mention of the same user
sets the flag on the one row. Resolution is case-insensitive whole-word matching against
`users.username` (which is `UNIQUE COLLATE NOCASE`); a token that matches no
username is not stored and stays plain text. The primary key serves the
per-message lookup that message history and search batch on; the index serves
the per-user direction.

---

### messages_fts (FTS5 Virtual Table)

Full-text search index synchronized via triggers.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);
```

Supports FTS5 query syntax: simple terms, phrase queries, prefix queries, boolean operators (`AND`, `OR`, `NOT`).

---

### attachments

```sql
CREATE TABLE attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER,
    uploader_id INTEGER REFERENCES users(id),
    duration_ms INTEGER,
    waveform    TEXT
);
```

Uses UUID primary keys. `message_id` is NULL during upload, linked when the
message is sent. `uploader_id` (added by migration 010) records who uploaded
the file and backs the ownership check when attaching an upload to a message.
`duration_ms` and `waveform` (migration 084, WP 8.9) are set only on a voice
message: the clip length in milliseconds (1 to 300000) and the amplitude bytes
(1 to 256) as base64url without padding, so a client can draw the player before
it downloads the file. Both are NULL for every other attachment, and a forward
copies them with the file.
`ON DELETE SET NULL` (migration 030, was CASCADE) means a cascaded message
delete unlinks the row instead of removing it, leaving the periodic orphan
sweep (`DeleteOrphanedAttachments`) a handle on the stored file so the bytes
are reclaimed rather than stranded.

---

### reactions

```sql
CREATE TABLE reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);
```

---

### invites

```sql
CREATE TABLE invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    redeemed_by INTEGER REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);
```

Invite codes are 8 random bytes encoded as hex. Uses are validated and incremented atomically.

The legacy `redeemed_by` column is vestigial: it holds a single slot and was never written. Redemption tracking is `invite_redemptions` (migration 055), one row per use, so a multi-use invite records every redeemer and a leaked code can be traced. `user_id` is nullable with no foreign key — an account erasure unlinks the row (`user_id = NULL`) so the count and time survive, matching the reports pattern (migration 048).

### invite_redemptions

```sql
CREATE TABLE invite_redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_id   INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id     INTEGER,
    redeemed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

A row is written in the same transaction as the account and the invite's `use_count` (`CreateUserWithInvite`); a failed registration records none.

---

### import_jobs and message_import_authors

```sql
CREATE TABLE import_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id          INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_name         TEXT    NOT NULL DEFAULT '',
    discord_channel_id  TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
    total               INTEGER NOT NULL DEFAULT 0,
    imported            INTEGER NOT NULL DEFAULT 0,
    skipped             INTEGER NOT NULL DEFAULT 0,
    skipped_attachments INTEGER NOT NULL DEFAULT 0,
    error               TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at         TEXT
);
CREATE UNIQUE INDEX idx_import_jobs_one_running ON import_jobs(status) WHERE status = 'running';

CREATE TABLE message_import_authors (
    message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    discord_user_id TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    color           TEXT
);
```

One DiscordChatExporter export becomes one new text channel. The import
(`service/discordimport`, with `db/discord_import.go`) creates the channel with
`channels.import_pending = 1` and fills it 500 messages per writer transaction.
Every read that hands channels to clients, permission checks, unread counts,
retention, search scope or the channel statistic skips a pending channel, so
nobody can see or address it. When the last chunk is in, one transaction clears
the flag, sets every non-system account's `read_states` for the channel past the last
imported message with `mention_count` 0, and marks the job `done`. Then one
channel-created event goes out. There are no per-message events and no
notifications.

Retention: imported messages follow the server-wide window and a channel's own
window like any other message, by the dates they were sent on; a channel still
being built is not swept. Date bounds in search and in the ban purge find native
messages as before: the id probe leaves out every channel an import built or is
building (a running import's committed chunks already break the id order), a search that includes such a channel judges its rows by timestamp alone,
and every other channel in the same search keeps its id range. Publishing renames the channel
with " (imported)", then " (imported 2)" and so on if a visible text channel in
the same category already has the name. A file in a pending channel is not
readable by anyone.

Imported messages belong to the hidden `system` account (see `users` above).
`message_import_authors` holds the Discord display name (nickname, else account
name) and colour each is shown under; the row goes with the message. An
imported message has `kind` 0, the original `timestamp`, `edited_at` and
`pinned` (with `pinned_at`, and no pin row), `mentions_everyone` 0 and no
`message_mentions` rows. `reply_to` is set only when the replied-to message is in
the same export. Content goes through the same sanitizer and 4000-rune limit as
a sent message, and text over the limit is cut and ends in `…`.

Only `Default` and `Reply` messages are imported; every other type counts in
`skipped`, as does a message with no usable time or no text and no file. An
attachment is copied only when its path is a file inside the export's zip, under
the usual file-type policy, content check and size cap. A link to somewhere else
is never fetched: it counts in `skipped_attachments`, as does a file that is
missing or refused. A zip is refused for an entry with an absolute path, a `..`
segment, a drive letter or a symlink, and for more entries or uncompressed bytes
than its cap.

One import runs at a time: the unique index on `status = 'running'` refuses a
second job. A job that fails or is cancelled deletes its channel (a shutdown ends it failed, an administrator's cancel ends it cancelled; a chunk is written early once its copied files pass 64 MB or have waited 10 minutes, so the orphan sweep cannot take them first) (messages,
author rows and read states cascade) and ends `failed` or `cancelled` with the
reason. Files already copied stay as attachment rows with no message, which the
orphan attachment sweep reclaims after its grace period. At boot, any job still
`running` is failed with a restart reason and any channel still pending is
deleted, since the process that was building it is gone.

---

### read_states

```sql
CREATE TABLE read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);
```

`mention_count` is incremented shortly after message insert (a bounded worker
batches a ~250 ms window of messages into one write per channel; deleting,
purging or erasing a message flushes its pending write first) for every
mentioned user who
can read the channel, except the author and except users who have blocked the
author. `@everyone` counts every reader; `@here` counts only readers whose
_broadcast_ status is not `offline` — the column stores the status the user
chose, so a reader who picked `invisible` is collapsed to `offline` here and is
skipped, exactly as they appear to everyone else. Edits never increment it — a badge is only
raised by the original send, so an edit cannot double-count a mention. The
`channel_focus` read-state upsert resets it to 0, the `ready` payload ships
it per channel, and each raise or reversal pushes the reader a per-user
`mention_count` frame so a badge in a channel they are not viewing stays live
(DP-27; delivery conditions in
[protocol.md](protocol.md#mention_count-server---client-direct)).

---

### audit_log

```sql
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

### voice_states

Ephemeral -- all rows deleted on server startup.

```sql
CREATE TABLE voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_deafened INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

`server_muted` / `server_deafened` are moderator-imposed (`MUTE_MEMBERS`) and,
unlike `muted` / `deafened`, the user cannot clear them. They survive a channel
switch (the join upsert does not reset them) but not a leave, which deletes the
row.

---

### dm_participants

```sql
CREATE TABLE dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
```

N rows per channel: two for a 1:1 DM, three to ten for a group
(`db.MaxGroupDMParticipants`). Every DM authorization check is a lookup on
`(user_id, channel_id)`, which is why group DMs needed no new authorization
path — only `channels.is_group` to tell the two kinds apart.

A group leave deletes the row. When the last one goes, the `channels` row is
deleted with it: a DM nobody is in is reachable by nobody, and its messages and
attachments cascade off the channel.

---

### dm_open_state

```sql
CREATE TABLE dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);
```

---

### login_attempts

Login attempt log used for IP-based rate limiting and lockouts.

```sql
CREATE TABLE login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT    NOT NULL,
    username   TEXT,
    success    INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

### settings

Generic key/value store for server settings (`server_name`, `motd`,
`registration_mode`, …). Written by the admin API; read by the REST layer and
the WebSocket hub (cached with a short TTL).

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

### emoji

Server-wide custom emoji: one row per `:shortcode:`.

```sql
CREATE TABLE emoji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode   TEXT    NOT NULL UNIQUE,
    filename    TEXT    NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    mime_type   TEXT    NOT NULL DEFAULT 'image/png'   -- migration 026
);
```

`filename` holds the **storage UUID** the image bytes were written under (the
same convention as `attachments.stored_as`); the column name is inherited from
the initial schema. It is never derived from anything the uploader sent and is
never shown to a user.

`shortcode` is always lowercase — `[a-z0-9_]{2,32}` is the only spelling the
validator admits — which is what makes the plain `UNIQUE` index a
case-insensitive one without a `COLLATE NOCASE` change.

`mime_type` (migration 026) is the type **sniffed from the file's own bytes** at
upload, restricted to `image/png`, `image/jpeg`, `image/gif` and `image/webp`.
It exists so `GET /api/v1/emoji/{id}/image` can set a Content-Type without
opening and re-sniffing the file on every request. The `DEFAULT` is only there
to make the `ALTER` legal; nothing had ever written to this table before
migration 026, because the table shipped in 001 with no server code at all.

Writes are gated on `MANAGE_SERVER` (see api.md for why no new permission bit
was added), and every mutation broadcasts the whole set as `emoji_update`.

---

### rate_lockouts

Persists rate-limiter lockouts (e.g. repeated failed logins) so they survive
server restarts. Sliding-window counters themselves stay in memory.

```sql
CREATE TABLE rate_lockouts (
    key        TEXT    PRIMARY KEY,
    expires_at TEXT    NOT NULL
);
```

---

### user_blocks

User blocking (added by migration 012): a block prevents DM creation and
messaging between the two users.

```sql
CREATE TABLE user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);
```

---

### events

Persistent broadcast log (migration 014) — the cold tier of the reconnect
replay pipeline (see [protocol.md](protocol.md)). Written asynchronously by
the event persister, pruned by retention (configurable, default 24h). The
hub's in-memory sequence counter is seeded from `MAX(events.seq)` at startup
so sequence numbers stay monotonic across restarts.

```sql
CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT    NOT NULL,
    payload    BLOB    NOT NULL,
    channel_id INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

### plugins / plugin_kv

Plugin registry and per-plugin key/value storage (migration 015). `plugin_kv`
is namespaced per plugin via the composite primary key.

```sql
CREATE TABLE plugins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    version       TEXT    NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 0,
    manifest_json TEXT    NOT NULL,
    installed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plugin_kv (
    plugin_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key       TEXT    NOT NULL,
    value     BLOB    NOT NULL,
    PRIMARY KEY (plugin_id, key)
);
```

---

## Indexes

| Index Name                        | Table                  | Columns                                                             | Purpose                                                                                                                            |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `idx_sessions_user`               | sessions               | `(user_id)`                                                         | Fast deletion of all sessions for a user                                                                                           |
| `idx_sessions_expires_at`         | sessions               | `(expires_at)`                                                      | Sargable 15-minute session-expiry sweep (031)                                                                                      |
| `idx_messages_channel`            | messages               | `(channel_id, id DESC)`                                             | Latest messages in channel query                                                                                                   |
| `idx_messages_user`               | messages               | `(user_id)`                                                         | Filter by author                                                                                                                   |
| `idx_messages_pinned`             | messages               | `(channel_id, id DESC)` partial: `WHERE pinned = 1 AND deleted = 0` | Pinned-message listing without scanning channel history (019)                                                                      |
| `idx_audit_timestamp`             | audit_log              | `(created_at DESC)`                                                 | Pagination of audit log                                                                                                            |
| `idx_audit_log_actor`             | audit_log              | `(actor_id)`                                                        | Filter by actor                                                                                                                    |
| `idx_audit_log_action`            | audit_log              | `(action)`                                                          | Dashboard action-filter `SELECT DISTINCT action` without a full scan (054)                                                         |
| `idx_login_ip`                    | login_attempts         | `(ip_address, timestamp)`                                           | Rate limiting queries                                                                                                              |
| `idx_voice_states_channel`        | voice_states           | `(channel_id)`                                                      | All users in a voice channel                                                                                                       |
| `idx_channel_overrides_role`      | channel_overrides      | `(role_id, channel_id, allow, deny)`                                | Covering per-role override fetch (019; replaced `idx_channel_overrides_channel_role`, which duplicated the UNIQUE auto-index)      |
| `idx_dm_participants_user`        | dm_participants        | `(user_id)`                                                         | DM channel lookup                                                                                                                  |
| `idx_attachments_uploader`        | attachments            | `(uploader_id)`                                                     | Upload-ownership checks                                                                                                            |
| `idx_attachments_message`         | attachments            | `(message_id)`                                                      | Message → attachments fetch (019, recreated by 030's rebuild)                                                                      |
| `idx_user_blocks_blocked`         | user_blocks            | `(blocked_id, blocker_id)`                                          | Reverse block lookup                                                                                                               |
| `idx_events_channel_seq`          | events                 | `(channel_id, seq)`                                                 | Cold-tier replay per channel                                                                                                       |
| `idx_events_created_at`           | events                 | `(created_at)`                                                      | Retention pruning                                                                                                                  |
| `idx_api_tokens_user`             | api_tokens             | `(user_id)`                                                         | Per-user token listing/revocation (018)                                                                                            |
| `idx_message_mentions_user`       | message_mentions       | `(mentioned_user_id)`                                               | Per-user mention lookup                                                                                                            |
| `idx_channel_user_overrides_user` | channel_user_overrides | `(user_id)`                                                         | "every override this member carries" — the direction the permission cache populates from (the PK covers the per-channel direction) |
| `idx_roles_name_nocase`           | roles                  | `(name COLLATE NOCASE)` UNIQUE                                      | Case-insensitive role-name uniqueness                                                                                              |
| `idx_users_avatar`                | users                  | `(avatar)` partial: `WHERE avatar IS NOT NULL`                      | File route's avatar-authorization probe (027)                                                                                      |
| `idx_channels_dm_group`           | channels               | `(is_group)` partial: `WHERE type = 'dm'`                           | Group-DM filtering (028)                                                                                                           |

Sessions are looked up by token and invites by code through their `UNIQUE`
auto-indexes; the duplicating `idx_sessions_token` / `idx_invites_code` were
dropped by migration 020.

---

## Permission Bitfield System

Permissions are stored as an integer bitfield (31 bits used) in
`roles.permissions`, `channel_overrides.allow`/`deny`, and
`channel_user_overrides.allow`/`deny`.

### Bit Map

| Bit | Hex          | Name               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `0x1`        | `SEND_MESSAGES`    | Post messages in text channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1   | `0x2`        | `READ_MESSAGES`    | View messages in text channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | `0x4`        | `MANAGE_CONFIG`    | Read and change the server's config overrides and restart it (`GET`/`PATCH /admin/api/config/settings`, `POST /admin/api/restart`), via `permissions.CanManageConfig`. Owner tier (WP 8.4d): the owner, or a role that holds the bit explicitly; `ADMINISTRATOR` does not stand in for it. Only the owner can add or remove it. Nobody but the owner holds it after migration 082                                                                                                                                                                                                                                                                                                                                                         |
| 3   | `0x8`        | `MANAGE_UPDATES`   | Check for and apply server updates (`GET /admin/api/updates`, `POST /admin/api/updates/apply`), via `permissions.CanManageUpdates`. Owner tier (WP 8.4d), like `MANAGE_CONFIG`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | `0x10`       | `MANAGE_TOKENS`    | Create, list and revoke API tokens (`/admin/api/tokens`), via `permissions.CanManageTokens`. Owner tier (WP 8.4d). A holder who is not the owner sees and revokes only the tokens bound to them (revoking another's is a 404) and creates tokens only for themself (another username is a 403); the owner is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | `0x20`       | `ATTACH_FILES`     | Upload file attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | `0x40`       | `ADD_REACTIONS`    | Add emoji reactions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | `0x80`       | `ISSUE_RECOVERY`   | Issue a one-time recovery credential to a locked-out member (`POST /admin/api/users/{id}/recovery-credential`), via `permissions.CanIssueRecovery`. Owner tier (WP 8.4d). A holder who is not the owner can only issue to a member ranked strictly below them, never the owner; the owner has no such limit                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | `0x100`      | `VIEW_DIAGNOSTICS` | Open the server log stream (`POST /admin/api/logs/ticket`, then the stream, re-checked on every write), read and change the log level (`/admin/api/logs/level`), build support bundles (`/admin/api/support-bundles/*`) and read the attention panel (`GET /admin/api/attention`), via `permissions.CanViewDiagnostics`. Administrator tier (WP 8.4d): `ADMINISTRATOR` passes without it, and the owner or an Administrator can add or remove it                                                                                                                                                                                                                                                                                          |
| 9   | `0x200`      | `CONNECT_VOICE`    | Join voice channels (outside a DM, `READ_MESSAGES` in the channel too)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | `0x400`      | `SPEAK_VOICE`      | Transmit audio in voice channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | `0x800`      | `USE_VIDEO`        | Enable camera in voice channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 12  | `0x1000`     | `SHARE_SCREEN`     | Share screen in voice channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 13  | `0x2000`     | `MOVE_MEMBERS`     | Move any member between voice channels, whatever their rank, the owner included unless the owner has switched `voice_owner_movable` off (`voice_mod_move`), via `permissions.AuthorizeVoiceMover`. Server-wide, outside the admin perimeter. Only the owner or an Administrator can add or remove it on a role or override, or assign, remove or delete a role that carries it. Nobody but the owner holds it after migration 080. It is the only bit that opens a move: `MUTE_MEMBERS` does not, and `ADMINISTRATOR` does not stand in for it                                                                                                                                                                                            |
| 14  | `0x4000`     | `MANAGE_BACKUPS`   | Create a backup, list backups and issue a backup download link, then open it (`POST /admin/api/backup`, `GET /admin/api/backups`, `POST /admin/api/backups/{name}/link` and its `/download`), via `permissions.CanManageBackups`. Inside the admin perimeter, so a holder can reach `/admin/api` at all. A backup holds every message and every password hash, so only the owner or an Administrator can add or remove it on a role or override, or assign, remove or delete a role that carries it. Restore, delete, the full archive, the backup schedule and retention, updates, API tokens and server configuration stay Owner-only. Nobody but the owner holds it after migration 081; a role with `ADMINISTRATOR` passes without it |
| 15  | `0x8000`     | `RESTORE_BACKUPS`  | Restore a backup, delete a backup, download the full archive and issue its link (`POST /admin/api/backups/{name}/restore`, `DELETE /admin/api/backups/{name}`, `GET /admin/api/archive`, `POST /admin/api/archive/link` and its `/download`), via `permissions.CanRestoreBackups`; a holder also lists backups (`GET /admin/api/backups`) to pick one. Owner tier (WP 8.4d). A link is re-checked when it is opened, so a holder who lost the bit gets nothing. The backup schedule and retention stay Owner-only                                                                                                                                                                                                                         |
| 16  | `0x10000`    | `MANAGE_MESSAGES`  | Delete others' messages, pin/unpin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 17  | `0x20000`    | `MANAGE_CHANNELS`  | Create, edit, delete channels, edit channel permission overrides (`/admin/api/channels*`; create, edit and delete also at `/api/v1/moderation/channels`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 18  | `0x40000`    | `KICK_MEMBERS`     | Force-logout a lower-ranked user (`DELETE /admin/api/users/{id}/sessions`, or `DELETE /api/v1/moderation/members/{id}/sessions`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 19  | `0x80000`    | `BAN_MEMBERS`      | Ban/unban a lower-ranked user (`PATCH /admin/api/users/{id}`, or `PATCH /api/v1/moderation/members/{id}`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | `0x100000`   | `MUTE_MEMBERS`     | Server-side mute, deafen and disconnect in voice, and moving members the actor outranks (`voice_mod_mute`/`_deafen`/`_kick`/`_move`), via the channel-scoped `permissions.AuthorizeVoiceModerator`; also admits to the admin perimeter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 21  | `0x200000`   | `MENTION_EVERYONE` | Give `@everyone`/`@here` real mention semantics (highlight + mention badge). Without it the token stays plain text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 22  | `0x400000`   | `MODERATE_MEMBERS` | Warn and time out members (B5-9), and read/work the report queue (`GET/POST /api/v1/moderation/queue…`, B5-8). Deliberately outside the admin perimeter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 23  | `0x800000`   | `MANAGE_NICKNAMES` | Set or clear another member's nickname (`PUT /api/v1/moderation/users/{id}/nickname`, WP 6.4), for a member the actor outranks. Server-wide, deliberately outside the admin perimeter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 24  | `0x1000000`  | `MANAGE_ROLES`     | Assign a role below the actor's own rank to a lower-ranked user (`PATCH /admin/api/users/{id}`, or `PATCH /api/v1/moderation/members/{id}`), and create/edit/delete/reorder roles below the actor's own (`/admin/api/roles…`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 25  | `0x2000000`  | `MANAGE_SERVER`    | Read and modify server settings (`/admin/api/settings`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 26  | `0x4000000`  | `MANAGE_INVITES`   | Create and revoke invite codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 27  | `0x8000000`  | `VIEW_AUDIT_LOG`   | Read the audit log (`GET /admin/api/audit-log`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 28  | `0x10000000` | `ERASE_ACCOUNTS`   | Erase a member's account (`DELETE /admin/api/users/{id}`), via `permissions.CanEraseAccounts`. Administrator tier (WP 8.4d): `ADMINISTRATOR` passes without it. The actor must still strictly outrank the target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 30  | `0x40000000` | `ADMINISTRATOR`    | Bypasses ALL permission checks except the five owner-tier bits (WP 8.4d), which only the owner or an explicit holder passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Bits 29, 31 are reserved.

### Permission groups

The bit map above is the authority on what each bit _does_; this grouping is
how the bits are _presented_ — it is the layout of the admin panel's role
permission grid (`PERM_GROUPS` in `Server/admin/static/js/roles-channels.js`).
It carries no semantics, but the two must stay in step: every defined bit
belongs to exactly one group, and a bit missing from the grouping is a bit no
operator can grant through the panel.

| Group        | Bits                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General      | `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_INVITES`, `MANAGE_SERVER`, `VIEW_AUDIT_LOG`, `MODERATE_MEMBERS`, `MANAGE_NICKNAMES`, `MANAGE_BACKUPS`, `ADMINISTRATOR` |
| Text         | `READ_MESSAGES`, `SEND_MESSAGES`, `ATTACH_FILES`, `ADD_REACTIONS`, `MENTION_EVERYONE`, `MANAGE_MESSAGES`                                                          |
| Voice        | `CONNECT_VOICE`, `SPEAK_VOICE`, `USE_VIDEO`, `SHARE_SCREEN`                                                                                                       |
| Moderation   | `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`, `MOVE_MEMBERS`                                                                                                     |
| Owner powers | `RESTORE_BACKUPS`, `MANAGE_CONFIG`, `MANAGE_UPDATES`, `MANAGE_TOKENS`, `ISSUE_RECOVERY`, `VIEW_DIAGNOSTICS`, `ERASE_ACCOUNTS`                                     |

### Admin perimeter

`permissions.AdminPerimeter` is the ANY-of mask that admits a principal to
`/admin/api/*`: `ADMINISTRATOR | MANAGE_CHANNELS | MANAGE_ROLES |
MANAGE_SERVER | VIEW_AUDIT_LOG | KICK_MEMBERS | BAN_MEMBERS | MUTE_MEMBERS |
MANAGE_BACKUPS` plus the seven owner-type bits (WP 8.4d).
Holding one bit only gets a principal through the door — each route group
re-checks the specific bit it needs, so the seeded Moderator role can manage
channels and ban members without reading settings or the audit log. Routes
that were Owner-only (restoring and deleting backups, the full archive,
updates, API tokens, server configuration, recovery credentials) are the
owner's or an explicit holder's of their owner-type bit (WP 8.4d), and
`ADMINISTRATOR` does not stand in for that bit; creating, listing and
downloading a backup is the owner's or a `MANAGE_BACKUPS` holder's. Log
streaming, the log level, support bundles, the attention panel and account
erasure are `VIEW_DIAGNOSTICS` or `ERASE_ACCOUNTS`, which `ADMINISTRATOR`
still passes. Only the backup schedule and retention stay Owner-only.
See `docs/api.md` for the per-route mapping.

### Permission Checking Logic

```
1. Get the user's role -> role.Permissions (base)
2. If (base & ADMINISTRATOR) != 0 -> ALLOW everything
3. Get channel_overrides      for (channel_id, role_id) -> allow,  deny
4. Get channel_user_overrides for (channel_id, user_id) -> uAllow, uDeny
5. roleLayer = (base      & ~deny)  | allow
6. effective = (roleLayer & ~uDeny) | uAllow
7. Check: (effective & required_permission) == required_permission
```

The order is Discord's: **base role permissions -> role override -> user
override**. Within a layer deny is applied first (strips bits) then allow (adds
bits), so allow wins when both target the same bit. Across layers the later,
narrower layer wins:

| Situation                                    | Outcome                            |
| -------------------------------------------- | ---------------------------------- |
| role override allows, user override denies   | denied                             |
| role override denies, user override allows   | allowed                            |
| user override allows and denies the same bit | allowed                            |
| holder has `ADMINISTRATOR`                   | allowed regardless of either layer |

`permissions.EffectiveChannelPerms` is the single implementation of steps 5-6,
and `permissions.EffectivePerms` the one-layer primitive it is built from. The
`ADMINISTRATOR` bypass lives at the call sites (`Checker.HasChannelPerm`,
`Checker.HasChannelPermBatch`, and through it `VisibleChannelIDs`), not inside
the formula — it is a bypass, not a bit that survives an override.

Both layers are fetched together and per member, never per channel:
`db.GetMemberGrants(userID)` reads the held roles, their channel overrides and
the member overrides in three batch queries, which is what keeps `buildReady`, REST
`ListVisibleChannels`, reconnect replay filtering and the cached
`service.PermissionService` free of N+1 lookups and unable to drift from each other.

A member holding several roles is composed per role: each held role is resolved
with its own override in the channel (`(perms &^ deny) | allow`), the results are
OR'd, then the member layer applies (`(roleLayer &^ userDeny) | userAllow`);
`ADMINISTRATOR` in any held role bypasses. A member with one role resolves
exactly as the table above. `permissions.MemberChannelPerms` is the
implementation, fed by `Subject.Layers`.

DM channels bypass role permissions entirely and use participant-based authorization instead.

### Default Role Permission Values

| Role      | Hex          | Permissions                                                                                                                                                                                                                                                                                                                                         |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner     | `0x7FFFFFFF` | Everything including ADMINISTRATOR                                                                                                                                                                                                                                                                                                                  |
| Admin     | `0x2FFF1E63` | Everything except ADMINISTRATOR, MOVE_MEMBERS (080), MANAGE_BACKUPS (081) and the seven owner-type bits (082)                                                                                                                                                                                                                                       |
| Moderator | `0x00EF1E63` | Messages, voice (connect, speak, video, share), manage messages and channels, kick and ban, plus `MENTION_EVERYONE` (migration 022), `MODERATE_MEMBERS` (048) and `MANAGE_NICKNAMES` (078); no `MUTE_MEMBERS` (so no voice mute, deafen, disconnect or move), no `MOVE_MEMBERS` (080), no `MANAGE_BACKUPS` (081), none of the owner-type bits (082) |
| Member    | `0x1E63`     | Send, read, attach, react, voice, video, screen share                                                                                                                                                                                                                                                                                               |
