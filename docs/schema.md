# Database Schema Reference

OwnCord uses a single SQLite database file (`data/chatserver.db`) with the pure-Go driver `modernc.org/sqlite` (no CGO). Migrations run automatically on startup.

> **Data-access layers:** most `Server/db` methods delegate to the
> sqlc-generated layer (`Server/db/dbgen`, from `Server/db/queries/`) per
> decision D2 in
> [plans/audit-2026-07-19-decisions.md](plans/audit-2026-07-19-decisions.md);
> a deliberate remainder (variable `IN` lists, FTS, multi-statement
> transactions) still runs as hand-written SQL — tracked in
> [plans/sqlc-adoption.md](plans/sqlc-adoption.md). See
> [architecture/data-model.md](architecture/data-model.md) for the full
> picture.

---

## Database Configuration

| PRAGMA         | Value       | Purpose                                    |
| -------------- | ----------- | ------------------------------------------ |
| `journal_mode` | `WAL`       | Write-Ahead Logging for concurrent readers |
| `foreign_keys` | `ON`        | Enforces all `REFERENCES` constraints      |
| `busy_timeout` | `5000`      | Waits up to 5 seconds for the write lock   |
| `synchronous`  | `NORMAL`    | Safe with WAL mode, reduces fsync calls    |
| `temp_store`   | `MEMORY`    | Temporary tables stored in RAM             |
| `mmap_size`    | `268435456` | 256 MB memory-mapped I/O                   |
| `cache_size`   | `-64000`    | 64 MB page cache                           |

SQLite only allows one writer at a time. File-backed databases (the production
mode) therefore run a split pool: a single-connection writer pool
(`SetMaxOpenConns(1)`) plus a multi-connection read-only pool sized
`max(4, NumCPU)` and clamped to 1–64, configurable via `database.max_readers`
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

| File                                           | Description                                                                                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_initial_schema.sql`                       | All core tables, default roles and settings                                                                                                                                                                             |
| `002_voice_states.sql`                         | Adds `voice_states` table                                                                                                                                                                                               |
| `003_audit_log.sql`                            | Recreates `audit_log` with canonical column names (via a transient `audit_log_v6` rename)                                                                                                                               |
| `004_voice_optimization.sql`                   | Adds `camera`, `screenshare` to voice_states; voice settings to channels                                                                                                                                                |
| `005_fix_member_permissions.sql`               | Fixes Member role permissions                                                                                                                                                                                           |
| `006_channel_overrides_index.sql`              | Adds composite index on channel_overrides                                                                                                                                                                               |
| `007_member_video_permissions.sql`             | Adds USE_VIDEO and SHARE_SCREEN to Member role                                                                                                                                                                          |
| `008_attachment_dimensions.sql`                | Adds `width` and `height` to attachments                                                                                                                                                                                |
| `009_dm_tables.sql`                            | Adds `dm_participants` and `dm_open_state` tables                                                                                                                                                                       |
| `010_attachment_uploader.sql`                  | Adds `attachments.uploader_id` + index for upload-ownership checks                                                                                                                                                      |
| `011_rate_lockouts.sql`                        | Adds `rate_lockouts` so rate-limit lockouts survive restarts                                                                                                                                                            |
| `012_user_blocks.sql`                          | Adds `user_blocks` (blocks DM creation/messaging between users)                                                                                                                                                         |
| `013_channel_type_constraint.sql`              | INSERT/UPDATE triggers restricting `channels.type` to `text`/`voice`/`dm`                                                                                                                                               |
| `014_events_table.sql`                         | Adds `events` — persistent broadcast log for reconnect cold-tier replay                                                                                                                                                 |
| `015_plugins.sql`                              | Adds `plugins` and `plugin_kv` for the WASM plugin runtime                                                                                                                                                              |
| `016_announcement_channel_type.sql`            | Recreates the channel-type triggers to allow `announcement`                                                                                                                                                             |
| `017_user_identity_key.sql`                    | Adds `users.identity_public_key` (long-term E2EE identity key for voice TOFU)                                                                                                                                           |
| `018_api_tokens.sql`                           | Adds `api_tokens` — long-lived, revocable bearer tokens for headless clients (bot/service auth)                                                                                                                         |
| `019_perf_indexes.sql`                         | Adds hot-path indexes                                                                                                                                                                                                   |
| `020_drop_redundant_indexes.sql`               | Drops indexes duplicating UNIQUE auto-indexes                                                                                                                                                                           |
| `021_voice_server_moderation.sql`              | Adds `server_muted`, `server_deafened` to voice_states (moderator-imposed)                                                                                                                                              |
| `022_message_mentions.sql`                     | Adds `message_mentions` + `messages.mentions_everyone`, and grants `MENTION_EVERYONE` (bit 21) to the seeded Owner/Admin/Moderator roles                                                                                |
| `023_role_management.sql`                      | Adds `idx_roles_name_nocase` — role names become unique case-insensitively, matching how they are looked up                                                                                                             |
| `024_channel_user_overrides.sql`               | Adds `channel_user_overrides` — per-member channel permission overrides, the last layer of the resolution order                                                                                                         |
| `025_channel_nsfw.sql`                         | Adds `channels.nsfw` — the age-gate flag the server stores and broadcasts but imposes no behaviour of its own on                                                                                                        |
| `026_emoji_mime.sql`                           | Adds `emoji.mime_type` — the sniffed image type, so the emoji image route can send a Content-Type without re-reading the file                                                                                           |
| `027_user_profile_fields.sql`                  | Adds `users.display_name`, `users.about`, `users.custom_status`, and a partial index on `users(avatar)` for the file route's avatar-authorization probe                                                                 |
| `028_group_dms.sql`                            | Adds `channels.is_group` + a partial index — marks a DM channel as a group so group-ness survives people leaving                                                                                                        |
| `029_drop_sounds_table.sql`                    | Drops `sounds` — dead since 001; the soundboard it was created for was never built (A-2026-07-13)                                                                                                                       |
| `030_attachments_unlink_on_message_delete.sql` | Rebuilds `attachments` with `message_id ON DELETE SET NULL` (was CASCADE) — cascaded message deletes now unlink rows instead of removing them, so the periodic orphan sweep can still find and reclaim the stored files |
| `031_sessions_expiry_index.sql`                | Normalizes legacy `sessions.expires_at` values to RFC3339 UTC and adds `idx_sessions_expires_at` so the 15-minute expiry sweep is sargable                                                                              |

---

## Table index (generated)

<!-- gendocs:schema:start -->

Generated from the migrated schema by `cd Server && go run -tags otel,wazero ./cmd/gendocs` — do not edit by hand; `make docs-verify` fails when it drifts. 32 tables: `sqlite_sequence` and the FTS5 shadow tables behind `messages_fts` are included; the `sqlite_stat*` tables `ANALYZE` writes are not, since they hold planner statistics and which of them exists depends on the SQLite build.

| Table                    | Columns                                                                                                                                                                                                                                                                                                                                                                                        | Indexes                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `api_tokens`             | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `token_hash TEXT NOT NULL`, `label TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_used_at TEXT`, `expires_at TEXT`, `revoked_at TEXT`                                                                                                                                                                                                          | `idx_api_tokens_user`, `sqlite_autoindex_api_tokens_1`                                  |
| `attachments`            | `id TEXT PK`, `message_id INTEGER`, `filename TEXT NOT NULL`, `stored_as TEXT NOT NULL`, `mime_type TEXT NOT NULL`, `size INTEGER NOT NULL`, `uploaded_at TEXT NOT NULL`, `width INTEGER`, `height INTEGER`, `uploader_id INTEGER`                                                                                                                                                             | `idx_attachments_message`, `idx_attachments_uploader`, `sqlite_autoindex_attachments_1` |
| `audit_log`              | `id INTEGER PK`, `actor_id INTEGER NOT NULL`, `action TEXT NOT NULL`, `target_type TEXT NOT NULL`, `target_id INTEGER NOT NULL`, `detail TEXT NOT NULL`, `created_at TEXT NOT NULL`                                                                                                                                                                                                            | `idx_audit_log_actor`, `idx_audit_timestamp`                                            |
| `channel_overrides`      | `id INTEGER PK`, `channel_id INTEGER NOT NULL`, `role_id INTEGER NOT NULL`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                  | `idx_channel_overrides_role`, `sqlite_autoindex_channel_overrides_1`                    |
| `channel_user_overrides` | `channel_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`, `allow INTEGER NOT NULL`, `deny INTEGER NOT NULL`                                                                                                                                                                                                                                                                             | `idx_channel_user_overrides_user`, `sqlite_autoindex_channel_user_overrides_1`          |
| `channels`               | `id INTEGER PK`, `name TEXT NOT NULL`, `type TEXT NOT NULL`, `category TEXT`, `topic TEXT`, `position INTEGER NOT NULL`, `slow_mode INTEGER NOT NULL`, `archived INTEGER NOT NULL`, `created_at TEXT NOT NULL`, `voice_max_users INTEGER NOT NULL`, `voice_quality TEXT`, `mixing_threshold INTEGER`, `voice_max_video INTEGER NOT NULL`, `nsfw INTEGER NOT NULL`, `is_group INTEGER NOT NULL` | `idx_channels_dm_group`                                                                 |
| `dm_open_state`          | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `opened_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                     | `sqlite_autoindex_dm_open_state_1`                                                      |
| `dm_participants`        | `channel_id INTEGER NOT NULL PK`, `user_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                                | `idx_dm_participants_user`, `sqlite_autoindex_dm_participants_1`                        |
| `emoji`                  | `id INTEGER PK`, `shortcode TEXT NOT NULL`, `filename TEXT NOT NULL`, `uploaded_by INTEGER NOT NULL`, `created_at TEXT NOT NULL`, `mime_type TEXT NOT NULL`                                                                                                                                                                                                                                    | `sqlite_autoindex_emoji_1`                                                              |
| `events`                 | `seq INTEGER PK`, `event_type TEXT NOT NULL`, `payload BLOB NOT NULL`, `channel_id INTEGER NOT NULL`, `created_at TIMESTAMP NOT NULL`                                                                                                                                                                                                                                                          | `idx_events_channel_seq`, `idx_events_created_at`                                       |
| `invites`                | `id INTEGER PK`, `code TEXT NOT NULL`, `created_by INTEGER NOT NULL`, `redeemed_by INTEGER`, `max_uses INTEGER`, `use_count INTEGER NOT NULL`, `expires_at TEXT`, `created_at TEXT NOT NULL`, `revoked INTEGER NOT NULL`                                                                                                                                                                       | `sqlite_autoindex_invites_1`                                                            |
| `login_attempts`         | `id INTEGER PK`, `ip_address TEXT NOT NULL`, `username TEXT`, `success INTEGER NOT NULL`, `timestamp TEXT NOT NULL`                                                                                                                                                                                                                                                                            | `idx_login_ip`                                                                          |
| `message_mentions`       | `message_id INTEGER NOT NULL PK`, `mentioned_user_id INTEGER NOT NULL PK`                                                                                                                                                                                                                                                                                                                      | `idx_message_mentions_user`, `sqlite_autoindex_message_mentions_1`                      |
| `messages`               | `id INTEGER PK`, `channel_id INTEGER NOT NULL`, `user_id INTEGER NOT NULL`, `content TEXT NOT NULL`, `reply_to INTEGER`, `edited_at TEXT`, `deleted INTEGER NOT NULL`, `pinned INTEGER NOT NULL`, `timestamp TEXT NOT NULL`, `mentions_everyone INTEGER NOT NULL`                                                                                                                              | `idx_messages_channel`, `idx_messages_pinned`, `idx_messages_user`                      |
| `messages_fts`           | `content`                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                       |
| `messages_fts_config`    | `k NOT NULL PK`, `v`                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                       |
| `messages_fts_data`      | `id INTEGER PK`, `block BLOB`                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                       |
| `messages_fts_docsize`   | `id INTEGER PK`, `sz BLOB`                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                       |
| `messages_fts_idx`       | `segid NOT NULL PK`, `term NOT NULL PK`, `pgno`                                                                                                                                                                                                                                                                                                                                                | —                                                                                       |
| `plugin_kv`              | `plugin_id INTEGER NOT NULL PK`, `key TEXT NOT NULL PK`, `value BLOB NOT NULL`                                                                                                                                                                                                                                                                                                                 | `sqlite_autoindex_plugin_kv_1`                                                          |
| `plugins`                | `id INTEGER PK`, `name TEXT NOT NULL`, `version TEXT NOT NULL`, `enabled INTEGER NOT NULL`, `manifest_json TEXT NOT NULL`, `installed_at TIMESTAMP NOT NULL`                                                                                                                                                                                                                                   | `sqlite_autoindex_plugins_1`                                                            |
| `rate_lockouts`          | `key TEXT PK`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                      | `sqlite_autoindex_rate_lockouts_1`                                                      |
| `reactions`              | `id INTEGER PK`, `message_id INTEGER NOT NULL`, `user_id INTEGER NOT NULL`, `emoji TEXT NOT NULL`                                                                                                                                                                                                                                                                                              | `sqlite_autoindex_reactions_1`                                                          |
| `read_states`            | `user_id INTEGER NOT NULL PK`, `channel_id INTEGER NOT NULL PK`, `last_message_id INTEGER NOT NULL`, `mention_count INTEGER NOT NULL`                                                                                                                                                                                                                                                          | `sqlite_autoindex_read_states_1`                                                        |
| `roles`                  | `id INTEGER PK`, `name TEXT NOT NULL`, `color TEXT`, `permissions INTEGER NOT NULL`, `position INTEGER NOT NULL`, `is_default INTEGER NOT NULL`                                                                                                                                                                                                                                                | `idx_roles_name_nocase`, `sqlite_autoindex_roles_1`                                     |
| `schema_versions`        | `version TEXT PK`, `applied_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                  | `sqlite_autoindex_schema_versions_1`                                                    |
| `sessions`               | `id INTEGER PK`, `user_id INTEGER NOT NULL`, `token TEXT NOT NULL`, `device TEXT`, `ip_address TEXT`, `created_at TEXT NOT NULL`, `last_used TEXT NOT NULL`, `expires_at TEXT NOT NULL`                                                                                                                                                                                                        | `idx_sessions_expires_at`, `idx_sessions_user`, `sqlite_autoindex_sessions_1`           |
| `settings`               | `key TEXT PK`, `value TEXT NOT NULL`                                                                                                                                                                                                                                                                                                                                                           | `sqlite_autoindex_settings_1`                                                           |
| `sqlite_sequence`        | `name`, `seq`                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                       |
| `user_blocks`            | `blocker_id INTEGER NOT NULL PK`, `blocked_id INTEGER NOT NULL PK`, `created_at TEXT NOT NULL`                                                                                                                                                                                                                                                                                                 | `idx_user_blocks_blocked`, `sqlite_autoindex_user_blocks_1`                             |
| `users`                  | `id INTEGER PK`, `username TEXT NOT NULL`, `password TEXT NOT NULL`, `avatar TEXT`, `role_id INTEGER NOT NULL`, `totp_secret TEXT`, `status TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_seen TEXT`, `banned INTEGER NOT NULL`, `ban_reason TEXT`, `ban_expires TEXT`, `identity_public_key TEXT`, `display_name TEXT`, `about TEXT`, `custom_status TEXT`                                | `idx_users_avatar`, `sqlite_autoindex_users_1`                                          |
| `voice_states`           | `user_id INTEGER PK`, `channel_id INTEGER NOT NULL`, `muted INTEGER NOT NULL`, `deafened INTEGER NOT NULL`, `speaking INTEGER NOT NULL`, `joined_at TEXT NOT NULL`, `camera INTEGER NOT NULL`, `screenshare INTEGER NOT NULL`, `server_muted INTEGER NOT NULL`, `server_deafened INTEGER NOT NULL`                                                                                             | `idx_voice_states_channel`                                                              |

<!-- gendocs:schema:end -->

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
    is_default  INTEGER NOT NULL DEFAULT 0
);
```

**Default roles** — current values after the full migration set (001 seeds
different masks: 005/007 raise Member's, 022 grants `MENTION_EVERYONE` to
Owner/Admin/Moderator). Not fixed at runtime — see _Role semantics_ below:

| id  | name      | color     | permissions  | position | Notes                                                 |
| --- | --------- | --------- | ------------ | -------- | ----------------------------------------------------- |
| 1   | Owner     | `#E74C3C` | `0x7FFFFFFF` | 100      | All 31 permission bits set                            |
| 2   | Admin     | `#F39C12` | `0x3FFFFFFF` | 80       | Everything except ADMINISTRATOR                       |
| 3   | Moderator | `#3498DB` | `0x002FFFFF` | 60       | All message + voice + moderation + mention-everyone   |
| 4   | Member    | NULL      | `0x1E63`     | 40       | Send, read, attach, react, voice, video, screen share |

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
  transaction. `users.role_id` is a single role per user — there is no
  many-to-many membership table.

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

`status` holds the status the user **chose**, `invisible` included — it is
deliberately not collapsed to `offline` at the write, because the server has to
be able to tell "chose to appear offline" from "is not connected" on the next
connect. The collapse happens at read time instead (`db.BroadcastStatus` /
`StatusForViewer`): every payload another user can see maps `invisible` to
`offline`, while the owner's own payloads keep the true value.

A chosen `idle`/`dnd`/`invisible` therefore survives a disconnect (only
`online` is cleared, by `MarkUserDisconnected`) and survives a server restart
(`ResetAllUserStatuses` clears only `online`). It cannot render as "present" in
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
    expires_at TEXT    NOT NULL
);
```

Session TTL: 30 days. Token is stored as SHA-256 hash.

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
expires; `revoked_at` NULL = active. Mint/list/revoke via `server token …`. Separate from
`sessions` so bulk logout and the per-user session cap never affect these.

---

### channels

```sql
CREATE TABLE channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,
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
    is_group         INTEGER NOT NULL DEFAULT 0
);
```

Channel types: `text`, `voice`, `announcement`, `dm`. Migration 013 installs
INSERT/UPDATE triggers restricting the value to this set (migration 016 added
`announcement`). Announcement channels are readable like text channels but
posting is restricted to users with `MANAGE_MESSAGES` (enforced in the service
layer, `Server/service/message.go`).

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

`PATCH /admin/api/channels/{id}` (`MANAGE_CHANNELS`) is the write path for
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
(`db.GetChannelOverridesFor`). The composite PRIMARY KEY replaces the surrogate
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

---

### message_mentions

```sql
CREATE TABLE message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
);

CREATE INDEX idx_message_mentions_user ON message_mentions(mentioned_user_id);
```

The user IDs a message resolved from its `@username` tokens, capped at 20 rows
per message. Resolution is case-insensitive whole-word matching against
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
    uploader_id INTEGER REFERENCES users(id)
);
```

Uses UUID primary keys. `message_id` is NULL during upload, linked when the
message is sent. `uploader_id` (added by migration 010) records who uploaded
the file and backs the ownership check when attaching an upload to a message.
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

`mention_count` is incremented on message insert for every mentioned user who
can read the channel, except the author and except users who have blocked the
author. `@everyone` counts every reader; `@here` counts only readers whose
_broadcast_ status is not `offline` — the column stores the status the user
chose, so a reader who picked `invisible` is collapsed to `offline` here and is
skipped, exactly as they appear to everyone else. Edits never increment it — a badge is only
raised by the original send, so an edit cannot double-count a mention. The
`channel_focus` read-state upsert resets it to 0, and the `ready` payload ships
it per channel.

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
`registration_open`, …). Written by the admin API; read by the REST layer and
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

| Bit | Hex          | Name               | Description                                                                                                                                                                       |
| --- | ------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `0x1`        | `SEND_MESSAGES`    | Post messages in text channels                                                                                                                                                    |
| 1   | `0x2`        | `READ_MESSAGES`    | View messages in text channels                                                                                                                                                    |
| 5   | `0x20`       | `ATTACH_FILES`     | Upload file attachments                                                                                                                                                           |
| 6   | `0x40`       | `ADD_REACTIONS`    | Add emoji reactions                                                                                                                                                               |
| 9   | `0x200`      | `CONNECT_VOICE`    | Join voice channels                                                                                                                                                               |
| 10  | `0x400`      | `SPEAK_VOICE`      | Transmit audio in voice channels                                                                                                                                                  |
| 11  | `0x800`      | `USE_VIDEO`        | Enable camera in voice channels                                                                                                                                                   |
| 12  | `0x1000`     | `SHARE_SCREEN`     | Share screen in voice channels                                                                                                                                                    |
| 16  | `0x10000`    | `MANAGE_MESSAGES`  | Delete others' messages, pin/unpin                                                                                                                                                |
| 17  | `0x20000`    | `MANAGE_CHANNELS`  | Create, edit, delete channels, edit channel permission overrides (`/admin/api/channels*`)                                                                                         |
| 18  | `0x40000`    | `KICK_MEMBERS`     | Force-logout a lower-ranked user (`DELETE /admin/api/users/{id}/sessions`)                                                                                                        |
| 19  | `0x80000`    | `BAN_MEMBERS`      | Ban/unban a lower-ranked user (`PATCH /admin/api/users/{id}`)                                                                                                                     |
| 20  | `0x100000`   | `MUTE_MEMBERS`     | Server-side mute/deafen in voice — admits to the admin perimeter; no route enforces it yet                                                                                        |
| 21  | `0x200000`   | `MENTION_EVERYONE` | Give `@everyone`/`@here` real mention semantics (highlight + mention badge). Without it the token stays plain text                                                                |
| 24  | `0x1000000`  | `MANAGE_ROLES`     | Assign a role below the actor's own rank to a lower-ranked user (`PATCH /admin/api/users/{id}`), and create/edit/delete/reorder roles below the actor's own (`/admin/api/roles…`) |
| 25  | `0x2000000`  | `MANAGE_SERVER`    | Read and modify server settings (`/admin/api/settings`)                                                                                                                           |
| 26  | `0x4000000`  | `MANAGE_INVITES`   | Create and revoke invite codes                                                                                                                                                    |
| 27  | `0x8000000`  | `VIEW_AUDIT_LOG`   | Read the audit log (`GET /admin/api/audit-log`)                                                                                                                                   |
| 30  | `0x40000000` | `ADMINISTRATOR`    | Bypasses ALL permission checks                                                                                                                                                    |

Bits 2-4, 7, 13-15, 22-23, 28-29, 31 are reserved.

### Permission groups

The bit map above is the authority on what each bit _does_; this grouping is
how the bits are _presented_ — it is the layout of the admin panel's role
permission grid (`PERM_GROUPS` in `Server/admin/static/index.html`). It carries
no semantics, but the two must stay in step: every defined bit belongs to
exactly one group, and a bit missing from the grouping is a bit no operator can
grant through the panel.

| Group      | Bits                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| General    | `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_INVITES`, `MANAGE_SERVER`, `VIEW_AUDIT_LOG`, `ADMINISTRATOR`  |
| Text       | `READ_MESSAGES`, `SEND_MESSAGES`, `ATTACH_FILES`, `ADD_REACTIONS`, `MENTION_EVERYONE`, `MANAGE_MESSAGES` |
| Voice      | `CONNECT_VOICE`, `SPEAK_VOICE`, `USE_VIDEO`, `SHARE_SCREEN`                                              |
| Moderation | `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`                                                            |

### Admin perimeter

`permissions.AdminPerimeter` is the ANY-of mask that admits a principal to
`/admin/api/*`: `ADMINISTRATOR | MANAGE_CHANNELS | MANAGE_ROLES |
MANAGE_SERVER | VIEW_AUDIT_LOG | KICK_MEMBERS | BAN_MEMBERS | MUTE_MEMBERS`.
Holding one bit only gets a principal through the door — each route group
re-checks the specific bit it needs, so the seeded Moderator role can manage
channels and ban members without reading settings or the audit log. Owner-only
routes (backups, updates, API tokens) still gate on role _position_, not on a
bit. See `docs/api.md` for the per-route mapping.

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
`db.GetChannelOverridesFor(roleID, userID)` runs two batch queries and merges
them, which is what keeps `buildReady`, REST `ListVisibleChannels`, reconnect
replay filtering and the cached `service.PermissionService` free of N+1 lookups
and unable to drift from each other.

DM channels bypass role permissions entirely and use participant-based authorization instead.

### Default Role Permission Values

| Role      | Hex          | Permissions                                                                          |
| --------- | ------------ | ------------------------------------------------------------------------------------ |
| Owner     | `0x7FFFFFFF` | Everything including ADMINISTRATOR                                                   |
| Admin     | `0x3FFFFFFF` | Everything except ADMINISTRATOR                                                      |
| Moderator | `0x002FFFFF` | All message + voice + moderation, plus `MENTION_EVERYONE` (granted by migration 022) |
| Member    | `0x1E63`     | Send, read, attach, react, voice, video, screen share                                |
