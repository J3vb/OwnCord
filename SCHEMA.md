# Database Schema (SQLite)

Single file: `data/chatserver.db`. WAL mode enabled. Migrations run automatically on server startup.

---

## Users

```sql
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,  -- bcrypt hash
    avatar      TEXT,              -- filename in uploads/ or NULL
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,              -- encrypted TOTP secret or NULL if 2FA disabled
    status      TEXT    NOT NULL DEFAULT 'offline',  -- online, idle, dnd, offline
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT     -- NULL = permanent, datetime = temp ban
);
```

## Sessions

```sql
CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,  -- 256-bit random, hex encoded
    device     TEXT,                     -- user-agent or client identifier
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL           -- 30 days from creation
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

## Roles

```sql
CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,              -- hex color e.g. #E74C3C, NULL for default
    permissions INTEGER NOT NULL DEFAULT 0,  -- bitfield
    position    INTEGER NOT NULL DEFAULT 0,  -- hierarchy: higher = more power
    is_default  INTEGER NOT NULL DEFAULT 0   -- 1 = assigned to new users
);

-- Default roles (inserted on first run)
-- Owner:     permissions = 0x7FFFFFFF (all bits set)
-- Admin:     permissions = 0x3FFFFFFF
-- Moderator: permissions = 0x000FFFFF
-- Member:    permissions = 0x00100601
```

### Permission Bitfield

```
Bit 0:  SEND_MESSAGES        (0x1)
Bit 1:  READ_MESSAGES         (0x2)
Bit 5:  ATTACH_FILES          (0x20)
Bit 6:  ADD_REACTIONS          (0x40)
Bit 8:  USE_SOUNDBOARD         (0x100)
Bit 9:  CONNECT_VOICE          (0x200)
Bit 10: SPEAK_VOICE            (0x400)
Bit 11: USE_VIDEO              (0x800)
Bit 12: SHARE_SCREEN           (0x1000)
Bit 16: MANAGE_MESSAGES        (0x10000)   -- delete others' messages, pin
Bit 17: MANAGE_CHANNELS        (0x20000)
Bit 18: KICK_MEMBERS           (0x40000)
Bit 19: BAN_MEMBERS            (0x80000)
Bit 20: MUTE_MEMBERS           (0x100000)  -- server mute/deafen
Bit 24: MANAGE_ROLES           (0x1000000)
Bit 25: MANAGE_SERVER          (0x2000000)
Bit 26: MANAGE_INVITES         (0x4000000)
Bit 27: VIEW_AUDIT_LOG         (0x8000000)
Bit 30: ADMINISTRATOR          (0x40000000) -- bypasses all checks
```

## Channels

```sql
CREATE TABLE channels (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    type     TEXT    NOT NULL DEFAULT 'text',  -- text, voice, announcement
    category TEXT,                              -- category name for grouping
    topic    TEXT,                              -- channel description
    position INTEGER NOT NULL DEFAULT 0,
    slow_mode INTEGER NOT NULL DEFAULT 0,      -- seconds between messages, 0 = off
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Channel Permission Overrides

```sql
CREATE TABLE channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,  -- permission bits to grant
    deny       INTEGER NOT NULL DEFAULT 0,  -- permission bits to revoke
    UNIQUE(channel_id, role_id)
);
```

## Messages

```sql
CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,  -- 1 = soft deleted
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX idx_messages_user ON messages(user_id);
```

## Message Full-Text Search

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
```

## Attachments

```sql
CREATE TABLE attachments (
    id         TEXT    PRIMARY KEY,  -- UUID
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename   TEXT    NOT NULL,     -- original filename
    stored_as  TEXT    NOT NULL,     -- UUID filename on disk
    mime_type  TEXT    NOT NULL,
    size       INTEGER NOT NULL,     -- bytes
    uploaded_at TEXT   NOT NULL DEFAULT (datetime('now'))
);
```

## Reactions

```sql
CREATE TABLE reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);
```

## Invites

```sql
CREATE TABLE invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,  -- random token
    created_by  INTEGER NOT NULL REFERENCES users(id),
    redeemed_by INTEGER REFERENCES users(id),
    max_uses    INTEGER,                  -- NULL = unlimited
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,                      -- NULL = never
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_invites_code ON invites(code);
```

## Read State (unread tracking)

```sql
CREATE TABLE read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);
```

## Audit Log

```sql
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    action     TEXT    NOT NULL,  -- e.g. user_ban, channel_create, message_delete, role_update
    target_type TEXT,             -- user, channel, message, role, invite
    target_id   INTEGER,
    details    TEXT,              -- JSON with extra context
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
```

## Login Attempts (rate limiting)

```sql
CREATE TABLE login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT    NOT NULL,
    username   TEXT,
    success    INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_ip ON login_attempts(ip_address, timestamp);
```

## Server Settings (key-value)

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default settings inserted on first run:
-- server_name, server_icon, motd, max_upload_bytes, voice_quality,
-- require_2fa, registration_open (always 0), backup_schedule, backup_retention
```

## Custom Emoji

```sql
CREATE TABLE emoji (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode  TEXT    NOT NULL UNIQUE,  -- e.g. :pepe:
    filename   TEXT    NOT NULL,          -- stored in uploads/emoji/
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

## Soundboard

```sql
CREATE TABLE sounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    filename    TEXT    NOT NULL,  -- stored in uploads/sounds/
    duration_ms INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

## Notes

- All datetimes stored as ISO 8601 UTC strings.
- Enable WAL mode on connection: `PRAGMA journal_mode=WAL;`
- Enable foreign keys: `PRAGMA foreign_keys=ON;`
- Use `modernc.org/sqlite` (pure Go, no CGO needed).
- Migrations: store schema version in `settings` table, apply incremental SQL on startup.
