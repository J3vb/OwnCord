# Database Schema Reference

OwnCord uses a single SQLite database file (`data/chatserver.db`) with the pure-Go driver `modernc.org/sqlite` (no CGO). Migrations run automatically on startup.

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
| `003_audit_log.sql` | Recreates `audit_log` with renamed columns |
| `003_voice_optimization.sql` | Adds `camera`, `screenshare` to voice_states; voice settings to channels |
| `004_fix_member_permissions.sql` | Fixes Member role permissions |
| `005_channel_overrides_index.sql` | Adds composite index on channel_overrides |
| `006_member_video_permissions.sql` | Adds USE_VIDEO and SHARE_SCREEN to Member role |
| `007_attachment_dimensions.sql` | Adds `width` and `height` to attachments |
| `008_dm_tables.sql` | Adds `dm_participants` and `dm_open_state` tables |

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
    ban_expires TEXT
);
```

Valid status values: `online`, `idle`, `dnd`, `offline`. All statuses are reset to `offline` on server startup.

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

Channel types: `text`, `voice`, `announcement`, `dm`.

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
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Messages are soft-deleted (`deleted = 1`), never physically removed by user action.

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
    height      INTEGER
);
```

Uses UUID primary keys. `message_id` is NULL during upload, linked when the message is sent.

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
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

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
| 17 | `0x20000` | `MANAGE_CHANNELS` | Create, edit, delete channels |
| 18 | `0x40000` | `KICK_MEMBERS` | Kick users |
| 19 | `0x80000` | `BAN_MEMBERS` | Ban/unban users |
| 20 | `0x100000` | `MUTE_MEMBERS` | Server-side mute/deafen in voice |
| 24 | `0x1000000` | `MANAGE_ROLES` | Create, edit, delete roles |
| 25 | `0x2000000` | `MANAGE_SERVER` | Modify server settings |
| 26 | `0x4000000` | `MANAGE_INVITES` | Create and revoke invite codes |
| 27 | `0x8000000` | `VIEW_AUDIT_LOG` | View the audit log |
| 30 | `0x40000000` | `ADMINISTRATOR` | Bypasses ALL permission checks |

Bits 2-4, 7, 13-15, 21-23, 28-29, 31 are reserved.

### Permission Checking Logic

```
1. Get the user's role -> role.Permissions (base)
2. If (base & ADMINISTRATOR) != 0 -> ALLOW everything
3. Get channel_overrides for (channel_id, role_id) -> allow, deny
4. effective = (base | allow) & ~deny
5. Check: (effective & required_permission) != 0
```

DM channels bypass role permissions entirely and use participant-based authorization instead.

### Default Role Permission Values

| Role | Hex | Permissions |
|------|-----|-------------|
| Owner | `0x7FFFFFFF` | Everything including ADMINISTRATOR |
| Admin | `0x3FFFFFFF` | Everything except ADMINISTRATOR |
| Moderator | `0x000FFFFF` | All message + voice + moderation |
| Member | `0x1E63` | Send, read, attach, react, voice, video, screen share |
