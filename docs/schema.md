# Database Schema Reference

OwnCord uses a single SQLite database file (`data/chatserver.db`) with the pure-Go driver `modernc.org/sqlite` (no CGO). Migrations run automatically on startup.

> **Data-access layers:** queries currently run as hand-written SQL in
> `Server/db`; an sqlc-generated layer (`Server/db/dbgen`, from
> `Server/db/queries/`) exists and is slated to become the real query layer
> per decision D2 in
> [plans/audit-2026-07-19-decisions.md](plans/audit-2026-07-19-decisions.md).
> See [architecture/data-model.md](architecture/data-model.md) for the full
> picture.

---

## Database Configuration

| PRAGMA | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Write-Ahead Logging for concurrent readers |
| `foreign_keys` | `ON` | Enforces all `REFERENCES` constraints |
| `busy_timeout` | `5000` | Waits up to 5 seconds for the write lock |
| `synchronous` | `NORMAL` | Safe with WAL mode, reduces fsync calls |
| `temp_store` | `MEMORY` | Temporary tables stored in RAM |
| `mmap_size` | `268435456` | 256 MB memory-mapped I/O |
| `cache_size` | `-64000` | 64 MB page cache |

SQLite only allows one writer at a time. The connection pool is pinned to a single connection.

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

| File | Description |
|------|-------------|
| `001_initial_schema.sql` | All core tables, default roles and settings |
| `002_voice_states.sql` | Adds `voice_states` table |
| `003_audit_log.sql` | Recreates `audit_log` with canonical column names (via a transient `audit_log_v6` rename) |
| `004_voice_optimization.sql` | Adds `camera`, `screenshare` to voice_states; voice settings to channels |
| `005_fix_member_permissions.sql` | Fixes Member role permissions |
| `006_channel_overrides_index.sql` | Adds composite index on channel_overrides |
| `007_member_video_permissions.sql` | Adds USE_VIDEO and SHARE_SCREEN to Member role |
| `008_attachment_dimensions.sql` | Adds `width` and `height` to attachments |
| `009_dm_tables.sql` | Adds `dm_participants` and `dm_open_state` tables |
| `010_attachment_uploader.sql` | Adds `attachments.uploader_id` + index for upload-ownership checks |
| `011_rate_lockouts.sql` | Adds `rate_lockouts` so rate-limit lockouts survive restarts |
| `012_user_blocks.sql` | Adds `user_blocks` (blocks DM creation/messaging between users) |
| `013_channel_type_constraint.sql` | INSERT/UPDATE triggers restricting `channels.type` to `text`/`voice`/`dm` |
| `014_events_table.sql` | Adds `events` — persistent broadcast log for reconnect cold-tier replay |
| `015_plugins.sql` | Adds `plugins` and `plugin_kv` for the WASM plugin runtime |
| `016_announcement_channel_type.sql` | Recreates the channel-type triggers to allow `announcement` |
| `017_user_identity_key.sql` | Adds `users.identity_public_key` (long-term E2EE identity key for voice TOFU) |
| `018_api_tokens.sql` | Adds `api_tokens` — long-lived, revocable bearer tokens for headless clients (bot/service auth) |
| `019_perf_indexes.sql` | Adds hot-path indexes |
| `020_drop_redundant_indexes.sql` | Drops indexes duplicating UNIQUE auto-indexes |
| `021_voice_server_moderation.sql` | Adds `server_muted`, `server_deafened` to voice_states (moderator-imposed) |
| `022_message_mentions.sql` | Adds `message_mentions` + `messages.mentions_everyone`, and grants `MENTION_EVERYONE` (bit 21) to the seeded Owner/Admin/Moderator roles |

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

**Default roles:**

| id | name | color | permissions | position | Notes |
|----|------|-------|-------------|----------|-------|
| 1 | Owner | `#E74C3C` | `0x7FFFFFFF` | 100 | All 31 permission bits set |
| 2 | Admin | `#F39C12` | `0x3FFFFFFF` | 80 | Everything except ADMINISTRATOR |
| 3 | Moderator | `#3498DB` | `0x000FFFFF` | 60 | All message + voice + moderation |
| 4 | Member | NULL | `0x1E63` | 40 | Send, read, attach, react, voice, video, screen share |

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
    identity_public_key TEXT
);
```

Valid status values: `online`, `idle`, `dnd`, `offline`. All statuses are reset to `offline` on server startup.

`identity_public_key` (added in migration 017) is the user's long-term E2EE
identity public key (base64 ECDSA P-256) used for TOFU pinning of voice E2EE
announces; `NULL` = not published (legacy client).

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
    voice_max_video  INTEGER NOT NULL DEFAULT 25
);
```

Channel types: `text`, `voice`, `announcement`, `dm`. Migration 013 installs
INSERT/UPDATE triggers restricting the value to this set (migration 016 added
`announcement`). Announcement channels are readable like text channels but
posting is restricted to users with `MANAGE_MESSAGES` (enforced in the service
layer, `Server/service/message.go`).

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

Effective permission calculation: `effective = (base_permissions & ~deny) | allow`

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
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
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
`users.status` is not `offline`. Edits never increment it — a badge is only
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

Custom emoji metadata.

```sql
CREATE TABLE emoji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode   TEXT    NOT NULL UNIQUE,
    filename    TEXT    NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

### sounds

**Dead schema.** Created by the initial schema for the soundboard feature,
which has since been removed; the table remains but nothing reads or writes it.
Slated for a cleanup migration (audit A-2026-07-13).

```sql
CREATE TABLE sounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    filename    TEXT    NOT NULL,
    duration_ms INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

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

| Index Name | Table | Columns | Purpose |
|------------|-------|---------|---------|
| `idx_sessions_token` | sessions | `(token)` | Fast session lookup by token hash |
| `idx_sessions_user` | sessions | `(user_id)` | Fast deletion of all sessions for a user |
| `idx_messages_channel` | messages | `(channel_id, id DESC)` | Latest messages in channel query |
| `idx_messages_user` | messages | `(user_id)` | Filter by author |
| `idx_invites_code` | invites | `(code)` | Fast invite validation |
| `idx_audit_timestamp` | audit_log | `(created_at DESC)` | Pagination of audit log |
| `idx_audit_log_actor` | audit_log | `(actor_id)` | Filter by actor |
| `idx_login_ip` | login_attempts | `(ip_address, timestamp)` | Rate limiting queries |
| `idx_voice_states_channel` | voice_states | `(channel_id)` | All users in a voice channel |
| `idx_channel_overrides_channel_role` | channel_overrides | `(channel_id, role_id)` | Permission lookup |
| `idx_dm_participants_user` | dm_participants | `(user_id)` | DM channel lookup |
| `idx_attachments_uploader` | attachments | `(uploader_id)` | Upload-ownership checks |
| `idx_user_blocks_blocked` | user_blocks | `(blocked_id, blocker_id)` | Reverse block lookup |
| `idx_events_channel_seq` | events | `(channel_id, seq)` | Cold-tier replay per channel |
| `idx_events_created_at` | events | `(created_at)` | Retention pruning |
| `idx_message_mentions_user` | message_mentions | `(mentioned_user_id)` | Per-user mention lookup |

---

## Permission Bitfield System

Permissions are stored as an integer bitfield (31 bits used) in `roles.permissions`, `channel_overrides.allow`, and `channel_overrides.deny`.

### Bit Map

| Bit | Hex | Name | Description |
|-----|-----|------|-------------|
| 0 | `0x1` | `SEND_MESSAGES` | Post messages in text channels |
| 1 | `0x2` | `READ_MESSAGES` | View messages in text channels |
| 5 | `0x20` | `ATTACH_FILES` | Upload file attachments |
| 6 | `0x40` | `ADD_REACTIONS` | Add emoji reactions |
| 9 | `0x200` | `CONNECT_VOICE` | Join voice channels |
| 10 | `0x400` | `SPEAK_VOICE` | Transmit audio in voice channels |
| 11 | `0x800` | `USE_VIDEO` | Enable camera in voice channels |
| 12 | `0x1000` | `SHARE_SCREEN` | Share screen in voice channels |
| 16 | `0x10000` | `MANAGE_MESSAGES` | Delete others' messages, pin/unpin |
| 17 | `0x20000` | `MANAGE_CHANNELS` | Create, edit, delete channels, edit channel permission overrides (`/admin/api/channels*`) |
| 18 | `0x40000` | `KICK_MEMBERS` | Force-logout a lower-ranked user (`DELETE /admin/api/users/{id}/sessions`) |
| 19 | `0x80000` | `BAN_MEMBERS` | Ban/unban a lower-ranked user (`PATCH /admin/api/users/{id}`) |
| 20 | `0x100000` | `MUTE_MEMBERS` | Server-side mute/deafen in voice — admits to the admin perimeter; no route enforces it yet |
| 21 | `0x200000` | `MENTION_EVERYONE` | Give `@everyone`/`@here` real mention semantics (highlight + mention badge). Without it the token stays plain text |
| 24 | `0x1000000` | `MANAGE_ROLES` | Assign a role below the actor's own rank to a lower-ranked user (`PATCH /admin/api/users/{id}`) |
| 25 | `0x2000000` | `MANAGE_SERVER` | Read and modify server settings (`/admin/api/settings`) |
| 26 | `0x4000000` | `MANAGE_INVITES` | Create and revoke invite codes |
| 27 | `0x8000000` | `VIEW_AUDIT_LOG` | Read the audit log (`GET /admin/api/audit-log`) |
| 30 | `0x40000000` | `ADMINISTRATOR` | Bypasses ALL permission checks |

Bits 2-4, 7, 13-15, 22-23, 28-29, 31 are reserved.

### Admin perimeter

`permissions.AdminPerimeter` is the ANY-of mask that admits a principal to
`/admin/api/*`: `ADMINISTRATOR | MANAGE_CHANNELS | MANAGE_ROLES |
MANAGE_SERVER | VIEW_AUDIT_LOG | KICK_MEMBERS | BAN_MEMBERS | MUTE_MEMBERS`.
Holding one bit only gets a principal through the door — each route group
re-checks the specific bit it needs, so the seeded Moderator role can manage
channels and ban members without reading settings or the audit log. Owner-only
routes (backups, updates, API tokens) still gate on role *position*, not on a
bit. See `docs/api.md` for the per-route mapping.

### Permission Checking Logic

```
1. Get the user's role -> role.Permissions (base)
2. If (base & ADMINISTRATOR) != 0 -> ALLOW everything
3. Get channel_overrides for (channel_id, role_id) -> allow, deny
4. effective = (base & ~deny) | allow
5. Check: (effective & required_permission) != 0
```

Deny is applied first (strips bits), then allow (adds bits), so allow wins
when both target the same bit — matching Discord's channel-override semantics
(`permissions.EffectivePerms`).

DM channels bypass role permissions entirely and use participant-based authorization instead.

### Default Role Permission Values

| Role | Hex | Permissions |
|------|-----|-------------|
| Owner | `0x7FFFFFFF` | Everything including ADMINISTRATOR |
| Admin | `0x3FFFFFFF` | Everything except ADMINISTRATOR |
| Moderator | `0x002FFFFF` | All message + voice + moderation, plus `MENTION_EVERYONE` (granted by migration 022) |
| Member | `0x1E63` | Send, read, attach, react, voice, video, screen share |
