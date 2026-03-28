# Database Schema (SQLite) -- Comprehensive Reference

Single file: `data/chatserver.db`. Pure-Go driver `modernc.org/sqlite` (no CGO).
Migrations run automatically on startup via `db.Migrate()`.

---

## Table of Contents

1. [Database Configuration](#database-configuration)
2. [Migration System](#migration-system)
3. [Sentinel Errors](#sentinel-errors)
4. [Tables](#tables)
   - [roles](#roles)
   - [users](#users)
   - [sessions](#sessions)
   - [channels](#channels)
   - [channel_overrides](#channel_overrides)
   - [messages](#messages)
   - [messages_fts (FTS5)](#messages_fts-fts5-virtual-table)
   - [attachments](#attachments)
   - [reactions](#reactions)
   - [invites](#invites)
   - [read_states](#read_states)
   - [audit_log](#audit_log)
   - [login_attempts](#login_attempts)
   - [settings](#settings)
   - [emoji](#emoji)
   - [sounds](#sounds)
   - [voice_states](#voice_states)
   - [dm_participants](#dm_participants)
   - [dm_open_state](#dm_open_state)
   - [schema_versions](#schema_versions)
5. [Indexes](#indexes)
6. [Permission Bitfield System](#permission-bitfield-system)
7. [Queries by Domain](#queries-by-domain)
   - [User Operations](#user-operations)
   - [Session Operations](#session-operations)
   - [Channel Operations](#channel-operations)
   - [Message Operations](#message-operations)
   - [Full-Text Search](#full-text-search)
   - [Reaction Operations](#reaction-operations)
   - [Read State Operations](#read-state-operations)
   - [Invite Operations](#invite-operations)
   - [Role Operations](#role-operations)
   - [Voice Operations](#voice-operations)
   - [DM Operations](#dm-operations)
   - [Attachment Operations](#attachment-operations)
   - [Admin / Settings / Audit](#admin--settings--audit)
   - [Backup Operations](#backup-operations)
8. [Query Patterns](#query-patterns)

---

## Database Configuration

The database is opened and configured in `db.Open()`. Every connection has
the following PRAGMAs applied at startup before any queries execute:

| PRAGMA | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Write-Ahead Logging. Allows concurrent readers while one writer operates. Dramatically improves read throughput for a single-writer system. |
| `foreign_keys` | `ON` | Enforces all `REFERENCES` constraints. Without this, SQLite silently ignores foreign keys. |
| `busy_timeout` | `5000` | Waits up to 5 seconds for the write lock instead of returning `SQLITE_BUSY` immediately. Prevents transient failures under load. |
| `synchronous` | `NORMAL` | Safe with WAL mode. Reduces fsync calls compared to `FULL`. Data is durable against application crashes; only an OS crash during a checkpoint could theoretically lose committed data. |
| `temp_store` | `MEMORY` | Temporary tables and indices are stored in RAM instead of on disk. Speeds up sorting, grouping, and complex queries. |
| `mmap_size` | `268435456` | 256 MB memory-mapped I/O. The OS maps the database file directly into the process address space, avoiding `read()` system calls for hot pages. |
| `cache_size` | `-64000` | Negative value = kilobytes. Sets the page cache to 64 MB (approximately 15,000 pages at 4 KB page size). Keeps frequently accessed pages in memory. |

### Connection Pooling

```go
sqlDB.SetMaxOpenConns(1)
```

SQLite only allows one writer at a time. The pool is pinned to a **single
connection** so concurrent goroutines queue on the Go side (via `sync.Mutex`
inside `database/sql`) rather than getting `SQLITE_BUSY` errors. For
`:memory:` databases this also guarantees all callers share the same state.

Reads and writes are serialized through this single connection. WAL mode
still benefits performance because the single connection can read its own
uncommitted data, and the OS-level mmap avoids redundant I/O.

### Shutdown

On `db.Close()`, `PRAGMA optimize` is executed first. This lets SQLite
analyze and update query planner statistics based on actual usage during the
session, improving plan quality on the next startup.

---

## Migration System

Source: `db/migrate.go`

### Tracking Table

```sql
CREATE TABLE IF NOT EXISTS schema_versions (
    version    TEXT PRIMARY KEY,      -- migration filename (e.g. "001_initial_schema.sql")
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))  -- UTC timestamp of application
);
```

### How It Works

1. **Collect** all `.sql` files from the embedded `migrations/` FS,
   sorted lexicographically by filename.
2. **Seed existing databases**: If `schema_versions` does not exist but
   `users` does, this is a pre-tracking database. All migration filenames
   are inserted into `schema_versions` without executing the SQL, preventing
   destructive re-application.
3. **Apply new migrations**: For each `.sql` file not yet in `schema_versions`:
   - Begin a transaction.
   - Execute the SQL.
   - Insert the filename into `schema_versions` inside the same transaction.
   - Commit. If the server crashes between commit and the next migration,
     the already-applied migration is recorded and will not re-run.

### Migration History

| File | Description |
|------|-------------|
| `001_initial_schema.sql` | All core tables: roles, users, sessions, channels, channel_overrides, messages, messages_fts, attachments, reactions, invites, read_states, audit_log, login_attempts, settings, emoji, sounds. Default roles and settings inserted. |
| `002_voice_states.sql` | Adds `voice_states` table with user_id (PK), channel_id, muted, deafened, speaking, joined_at. Adds `idx_voice_states_channel` index. |
| `003_audit_log.sql` | Recreates `audit_log` with Phase-6 column names: `actor_id` (was `user_id`), `detail` (was `details`), `created_at` (was `timestamp`). Adds `idx_audit_log_actor` index. |
| `003_voice_optimization.sql` | Adds `camera` and `screenshare` columns to `voice_states`. Adds `voice_max_users`, `voice_quality`, `mixing_threshold`, `voice_max_video` to `channels`. |
| `004_fix_member_permissions.sql` | Fixes Member role: adds READ_MESSAGES, ATTACH_FILES, ADD_REACTIONS bits. New value: `0x663` (1635). |
| `005_channel_overrides_index.sql` | Adds composite index `idx_channel_overrides_channel_role` on `(channel_id, role_id)`. |
| `006_member_video_permissions.sql` | Adds USE_VIDEO and SHARE_SCREEN to Member role. New value: `0x1E63` (7779). |
| `007_attachment_dimensions.sql` | Adds `width` and `height` nullable INTEGER columns to `attachments`. |
| `008_dm_tables.sql` | Adds `dm_participants` table (composite PK: channel_id, user_id) and `dm_open_state` table. Adds `idx_dm_participants_user`. |

Note: `003_audit_log.sql` and `003_voice_optimization.sql` both have the
`003` prefix. Lexicographic ordering places `003_audit_log.sql` before
`003_voice_optimization.sql`, so they apply in that order.

---

## Sentinel Errors

Source: `db/errors.go`

The `db` package defines four sentinel errors. All query functions wrap
errors using `fmt.Errorf("...: %w", err)` so callers can check with
`errors.Is()`:

| Error | Value | Usage |
|-------|-------|-------|
| `ErrNotFound` | `"not found"` | Resource does not exist (e.g., message not found on edit/delete, setting key missing). |
| `ErrForbidden` | `"forbidden"` | Caller lacks permission (e.g., editing another user's message). |
| `ErrConflict` | `"conflict"` | Uniqueness constraint violation (e.g., duplicate username on registration). |
| `ErrBanned` | `"banned"` | User is banned from the server. |

Query functions return `nil, nil` (not `ErrNotFound`) when a lookup returns
no rows for `GetUserByID`, `GetChannel`, `GetInvite`, `GetVoiceState`, etc.
The `ErrNotFound` sentinel is used for operations that fail when the resource
is absent (e.g., `EditMessage`, `DeleteMessage`, `SetMessagePinned`,
`UseInviteAtomic`).

---

## Tables

### roles

Defines permission tiers. Created before `users` due to FK dependency.

```sql
CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- Stable numeric ID
    name        TEXT    NOT NULL UNIQUE,             -- Display name: "Owner", "Admin", etc.
    color       TEXT,                                -- Hex color (e.g., "#E74C3C") for UI display, NULL = default text color
    permissions INTEGER NOT NULL DEFAULT 0,          -- Bitfield of granted permissions (see Permission Bitfield section)
    position    INTEGER NOT NULL DEFAULT 0,          -- Hierarchy rank: higher number = more authority. Used for role ordering and permission checks.
    is_default  INTEGER NOT NULL DEFAULT 0           -- 1 = auto-assigned to new users on registration. Exactly one role should have this set.
);
```

**Default seed data** (inserted via `INSERT OR IGNORE` in migration 001):

| id | name | color | permissions | position | is_default | Notes |
|----|------|-------|-------------|----------|------------|-------|
| 1 | Owner | `#E74C3C` | `0x7FFFFFFF` (2147483647) | 100 | 0 | All 31 permission bits set. Highest authority. |
| 2 | Admin | `#F39C12` | `0x3FFFFFFF` (1073741823) | 80 | 0 | All bits except ADMINISTRATOR (bit 30). |
| 3 | Moderator | `#3498DB` | `0x000FFFFF` (1048575) | 60 | 0 | Bits 0-19: all message, voice, and moderation permissions. |
| 4 | Member | NULL | `0x1E63` (7779) | 40 | 1 | SEND_MESSAGES, READ_MESSAGES, ATTACH_FILES, ADD_REACTIONS, CONNECT_VOICE, SPEAK_VOICE, USE_VIDEO, SHARE_SCREEN. Updated by migrations 004 and 006. |

---

### users

Every registered account. The first user registered is assigned the Owner
role by the registration handler (not by the schema).

```sql
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,       -- Unique user identifier, monotonically increasing.
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- Display name. COLLATE NOCASE ensures case-insensitive uniqueness: "Alice" and "alice" cannot both exist. Lookups are also case-insensitive.
    password    TEXT    NOT NULL,                         -- bcrypt hash (never plaintext). Generated during registration, verified during login.
    avatar      TEXT,                                    -- Filename of avatar image in uploads/ directory, or NULL if no avatar is set.
    role_id     INTEGER NOT NULL DEFAULT 4               -- FK to roles.id. Default 4 = Member (the is_default role). Changed via admin role assignment.
                REFERENCES roles(id),
    totp_secret TEXT,                                    -- Encrypted TOTP secret for 2FA. NULL = 2FA not enabled. When set, login requires a valid TOTP code.
    status      TEXT    NOT NULL DEFAULT 'offline',      -- Presence status. Valid values: "online", "idle", "dnd", "offline". Never "invisible". Updated on connect/disconnect/user action.
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')), -- ISO 8601 UTC registration timestamp.
    last_seen   TEXT,                                    -- ISO 8601 UTC timestamp of last activity. Updated by UpdateUserStatus. NULL until first activity.
    banned      INTEGER NOT NULL DEFAULT 0,              -- 0 = not banned, 1 = banned. Checked during session validation.
    ban_reason  TEXT,                                    -- Human-readable ban reason shown to the user. NULL when not banned.
    ban_expires TEXT                                     -- ISO 8601 UTC expiry for temporary bans. NULL = permanent ban. Compared with strftime for auto-expiry.
);
```

**Startup behavior**: `ResetAllUserStatuses()` sets all non-offline users
to `'offline'` on server start, clearing stale state from previous runs.

---

### sessions

Token-based authentication. Each login creates a session; the token is sent
in the `Authorization` header (or WebSocket auth message).

```sql
CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL                          -- FK to the owning user. ON DELETE CASCADE: banning/deleting a user removes all sessions.
               REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,                  -- SHA-256 hash of the 256-bit random session token. The plaintext token is sent to the client; only the hash is stored. Compared via constant-time hash comparison.
    device     TEXT,                                     -- User-Agent or client identifier string. Informational only, shown in session management.
    ip_address TEXT,                                     -- Client IP at session creation time. Used for audit/display.
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),-- Updated by TouchSession on each authenticated request.
    expires_at TEXT    NOT NULL                          -- 30 days from creation (sessionTTL = 30*24*time.Hour). Expired sessions are purged by DeleteExpiredSessions.
);
```

**Session TTL**: 30 days, defined as `const sessionTTL = 30 * 24 * time.Hour`
in `models.go`.

---

### channels

All channel types (text, voice, announcement, dm) share this table. DM
channels have `type = 'dm'` and an empty `name`.

```sql
CREATE TABLE channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,                   -- Channel display name. Empty string for DM channels.
    type             TEXT    NOT NULL DEFAULT 'text',    -- Channel type: "text", "voice", "announcement", "dm". No CHECK constraint; validated at the application layer.
    category         TEXT,                               -- Category grouping name (e.g., "General", "Gaming"). NULL = uncategorized. Stored as NULL via nullableString() helper when empty.
    topic            TEXT,                               -- Channel description/topic. NULL = no topic set.
    position         INTEGER NOT NULL DEFAULT 0,         -- Sort order within the channel list. Lower = higher in list. Channels with same position sort by id.
    slow_mode        INTEGER NOT NULL DEFAULT 0,         -- Cooldown in seconds between user messages. 0 = disabled.
    archived         INTEGER NOT NULL DEFAULT 0,         -- 0 = active, 1 = archived (read-only).
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,         -- Maximum users in voice channel. 0 = unlimited. Added in migration 003_voice_optimization.
    voice_quality    TEXT,                               -- "low", "medium", "high", or NULL (use server default from settings). Added in migration 003_voice_optimization.
    mixing_threshold INTEGER,                            -- Audio mixing threshold override. NULL = use server default. Added in migration 003_voice_optimization.
    voice_max_video  INTEGER NOT NULL DEFAULT 25         -- Maximum simultaneous video streams. Added in migration 003_voice_optimization.
);
```

---

### channel_overrides

Per-channel permission overrides for specific roles. Allows granting or
revoking permissions beyond what the role's base permissions provide.

```sql
CREATE TABLE channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,  -- Which channel this override applies to. Cascade-deletes when channel is removed.
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,     -- Which role this override applies to. Cascade-deletes when role is removed.
    allow      INTEGER NOT NULL DEFAULT 0,   -- Permission bits to GRANT in addition to role base. Bitwise OR with base permissions.
    deny       INTEGER NOT NULL DEFAULT 0,   -- Permission bits to REVOKE from role base. Bitwise AND NOT with base permissions. Deny takes precedence over allow.
    UNIQUE(channel_id, role_id)              -- One override per channel-role pair. Enforced at the schema level.
);
```

**Effective permission calculation** (application layer):
```
effective = (base_permissions & ~deny) | allow
```
Deny is applied first (strips bits), then allow is applied (adds bits).
Allow takes precedence when both target the same bit.

---

### messages

All chat messages across all channel types (text, DM, announcement).

```sql
CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,        -- Monotonically increasing. Used for cursor-based pagination (before parameter) and read-state tracking.
    channel_id INTEGER NOT NULL                          -- Channel this message belongs to.
               REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),    -- Author. No ON DELETE CASCADE: messages persist if user is deleted (preserves history).
    content    TEXT    NOT NULL,                          -- Message text. Sanitized before storage. May contain URLs (including GIF URLs from Tenor).
    reply_to   INTEGER                                   -- ID of the message being replied to. NULL if not a reply.
               REFERENCES messages(id) ON DELETE SET NULL,-- SET NULL: if the parent message is deleted, the reply becomes a standalone message.
    edited_at  TEXT,                                     -- ISO 8601 UTC timestamp of last edit. NULL if never edited. Set by EditMessage.
    deleted    INTEGER NOT NULL DEFAULT 0,               -- 0 = visible, 1 = soft-deleted. Soft-deleted messages are excluded from queries but retained in the database. UI shows "[message deleted]".
    pinned     INTEGER NOT NULL DEFAULT 0,               -- 0 = not pinned, 1 = pinned. Pinned messages appear in the pins panel.
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))  -- Creation timestamp. ISO 8601 UTC.
);
```

**Soft deletion**: Messages are never physically removed by user action.
`DeleteMessage` sets `deleted = 1`. All read queries filter with
`WHERE deleted = 0` except `GetMessage` (which returns deleted messages
so the deletion event can be broadcast).

---

### messages_fts (FTS5 Virtual Table)

Full-text search index synchronized with the `messages` table via triggers.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,                    -- Indexed column: message text content
    content='messages',         -- Content table: FTS5 reads content from the messages table (content-sync mode)
    content_rowid='id'          -- Row ID mapping: FTS5 rowid = messages.id
);
```

**Content-sync mode**: The FTS5 table does not store a copy of the content.
It stores only the inverted index (term positions, document frequencies).
When you query the FTS table, it joins back to `messages` via `rowid = id`
to retrieve the actual text. This saves storage but requires the triggers
below to keep the index consistent.

**Synchronization triggers**:

```sql
-- AFTER INSERT: Index new message content.
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- AFTER DELETE: Remove from index. The special 'delete' command tells FTS5
-- to remove the entry for the given rowid/content pair.
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
END;

-- AFTER UPDATE: Delete old entry, insert new. This handles message edits.
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
```

**Search query** (used by `SearchMessages`):
```sql
SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content, m.timestamp
FROM messages_fts f
JOIN messages m ON f.rowid = m.id
JOIN channels c ON m.channel_id = c.id
JOIN users u ON m.user_id = u.id
WHERE messages_fts MATCH ? AND m.deleted = 0
ORDER BY rank LIMIT ?
```

The `MATCH` operator accepts FTS5 query syntax: simple terms, phrase
queries (`"exact phrase"`), prefix queries (`term*`), boolean operators
(`AND`, `OR`, `NOT`). The `rank` column is a built-in BM25 relevance
score (lower = more relevant).

---

### attachments

File uploads linked to messages. Uses UUID primary keys (not AUTOINCREMENT).

```sql
CREATE TABLE attachments (
    id          TEXT    PRIMARY KEY,                     -- UUID string generated by the upload handler. Text PK, not integer.
    message_id  INTEGER                                  -- FK to the message this file is attached to. NULL during upload (before the message is sent). Linked by LinkAttachmentsToMessage after message creation.
                REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,                         -- Original filename as uploaded by the user (e.g., "photo.jpg").
    stored_as   TEXT    NOT NULL,                         -- UUID-based filename on disk in the uploads/ directory. Prevents collisions and path traversal.
    mime_type   TEXT    NOT NULL,                         -- MIME type (e.g., "image/png", "application/pdf"). Set during upload based on content detection.
    size        INTEGER NOT NULL,                         -- File size in bytes. Validated against max_upload_bytes setting.
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,                                 -- Image width in pixels. NULL for non-image files. Added in migration 007.
    height      INTEGER                                  -- Image height in pixels. NULL for non-image files. Added in migration 007.
);
```

**Upload flow**: Attachments are created with `message_id = NULL` during
the upload phase. When the user sends a message with `attachment_ids`,
`LinkAttachmentsToMessage` atomically links them using
`WHERE message_id IS NULL` to prevent double-linking in a race.

**Orphan cleanup**: `DeleteOrphanedAttachments(cutoff)` removes records
where `message_id IS NULL AND uploaded_at < cutoff`, returning stored
filenames for disk cleanup.

---

### reactions

Emoji reactions on messages. One row per user-emoji-message combination.

```sql
CREATE TABLE reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,  -- Cascade: deleting a message removes its reactions.
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- Cascade: deleting a user removes their reactions.
    emoji      TEXT    NOT NULL,                          -- Unicode emoji character or custom emoji shortcode.
    UNIQUE(message_id, user_id, emoji)                   -- Each user can react with a given emoji only once per message. Adding a duplicate fails with a constraint error.
);
```

---

### invites

Server invite codes for user registration (registration is invite-only;
`registration_open` setting is always `0`).

```sql
CREATE TABLE invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,                  -- Random 8-byte (16-char hex) code. Generated by generateInviteCode() using crypto/rand.
    created_by  INTEGER NOT NULL REFERENCES users(id),   -- User who created the invite.
    redeemed_by INTEGER REFERENCES users(id),            -- Legacy column. Not used by current code (UseInviteAtomic increments use_count instead).
    max_uses    INTEGER,                                 -- Maximum number of redemptions. NULL = unlimited uses.
    use_count   INTEGER NOT NULL DEFAULT 0,              -- Current number of times this invite has been used.
    expires_at  TEXT,                                     -- ISO 8601 UTC expiry. NULL = never expires.
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0               -- 0 = active, 1 = revoked by admin/creator. Revoked invites cannot be used.
);
```

**Atomic use** (`UseInviteAtomic`): A single UPDATE statement validates
all conditions and increments `use_count` atomically, preventing TOCTOU
races:
```sql
UPDATE invites SET use_count = use_count + 1
WHERE code = ? AND revoked = 0
  AND (max_uses IS NULL OR use_count < max_uses)
  AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))
```
If zero rows are affected, the invite is invalid (missing, revoked,
expired, or exhausted).

---

### read_states

Tracks per-user, per-channel read position for unread counting.

```sql
CREATE TABLE read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,          -- ID of the last message the user has "read". Messages with id > this value are considered unread.
    mention_count   INTEGER NOT NULL DEFAULT 0,          -- Number of unread @mentions. Currently maintained but not actively used by the client.
    PRIMARY KEY (user_id, channel_id)                    -- Composite PK: one read state per user per channel. Upserted via ON CONFLICT.
);
```

**Upsert pattern** (`UpdateReadState`):
```sql
INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, ?)
ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id
```

---

### audit_log

Tracks administrative and security-relevant actions. Recreated in migration
003 with renamed columns (`actor_id` instead of `user_id`, `detail` instead
of `details`, `created_at` instead of `timestamp`).

```sql
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,              -- User who performed the action. 0 = system action. NOT a foreign key (actor may be deleted).
    action      TEXT    NOT NULL,                         -- Action identifier: "user_ban", "user_unban", "channel_create", "channel_delete", "role_change", "invite_create", "invite_revoke", etc.
    target_type TEXT    NOT NULL DEFAULT '',              -- Type of entity acted upon: "user", "channel", "message", "role", "invite".
    target_id   INTEGER NOT NULL DEFAULT 0,              -- ID of the target entity.
    detail      TEXT    NOT NULL DEFAULT '',              -- JSON string with extra context (e.g., ban reason, old/new role names).
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Query**: `GetAuditLog` LEFT JOINs `users` on `actor_id` to include the
actor's username (or empty string if the actor has been deleted).

---

### login_attempts

Rate limiting for authentication. Tracks every login attempt by IP.

```sql
CREATE TABLE login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT    NOT NULL,                          -- Client IP address.
    username   TEXT,                                     -- Username attempted. NULL for unknown/invalid usernames.
    success    INTEGER NOT NULL DEFAULT 0,               -- 0 = failed, 1 = successful.
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Note:** The current auth system uses an in-memory sliding-window rate
limiter (`auth/ratelimit.go`) instead of querying this table. The table
exists in the schema but is not actively read by the rate limiter. Lockout
occurs after 10 consecutive failures from the same IP (15-minute lockout).
The table could be used for audit/forensics but is not cleaned up
automatically.

---

### settings

Key-value store for server-wide configuration.

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

**Default values** (inserted by migration 001):

| Key | Default Value | Description |
|-----|---------------|-------------|
| `server_name` | `"OwnCord Server"` | Display name in the client UI. |
| `server_icon` | `""` (empty) | Server icon filename. |
| `motd` | `"Welcome!"` | Message of the day shown to connecting clients. |
| `max_upload_bytes` | `"26214400"` | 25 MB upload limit (stored as string, parsed to int). |
| `voice_quality` | `"high"` | Default voice quality for channels without an override. |
| `require_2fa` | `"0"` | Whether TOTP 2FA is mandatory for all users. |
| `registration_open` | `"0"` | Always 0. Registration requires an invite code. |
| `backup_schedule` | `"daily"` | How often automatic backups run. |
| `backup_retention` | `"7"` | Number of backup files to retain. |
| `schema_version` | `"1"` | Legacy version counter (superseded by schema_versions table). |

**Upsert pattern** (`SetSetting`):
```sql
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
```

---

### emoji

Custom server emoji (user-uploaded).

```sql
CREATE TABLE emoji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode   TEXT    NOT NULL UNIQUE,                  -- Emoji shortcode (e.g., ":pepe:"). Must be unique.
    filename    TEXT    NOT NULL,                         -- File stored in uploads/emoji/ directory.
    uploaded_by INTEGER NOT NULL REFERENCES users(id),   -- User who uploaded the emoji.
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

### sounds

Soundboard sounds for voice channels.

```sql
CREATE TABLE sounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,                         -- Display name of the sound.
    filename    TEXT    NOT NULL,                         -- File stored in uploads/sounds/ directory.
    duration_ms INTEGER NOT NULL,                        -- Duration in milliseconds. Used for UI display and playback scheduling.
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

### voice_states

Tracks which voice channel each user is currently connected to and their
audio/video state. **Ephemeral**: all rows are deleted on server startup
via `ClearAllVoiceStates()` since voice connections do not survive restarts.

```sql
CREATE TABLE voice_states (
    user_id     INTEGER PRIMARY KEY                      -- One voice state per user (can only be in one voice channel at a time). PK = unique + indexed.
                REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL                         -- The voice channel the user is connected to.
                REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,              -- 0 = unmuted, 1 = muted (user self-mute or server mute).
    deafened    INTEGER NOT NULL DEFAULT 0,              -- 0 = not deafened, 1 = deafened.
    speaking    INTEGER NOT NULL DEFAULT 0,              -- 0 = silent, 1 = currently speaking. Updated by voice activity detection.
    camera      INTEGER NOT NULL DEFAULT 0,              -- 0 = camera off, 1 = camera on. Added in migration 003_voice_optimization.
    screenshare INTEGER NOT NULL DEFAULT 0,              -- 0 = not sharing, 1 = screen sharing. Added in migration 003_voice_optimization.
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))-- When the user joined the voice channel. Used for ordering users in the channel.
);
```

**Join behavior** (`JoinVoiceChannel`): Uses `INSERT ... ON CONFLICT DO UPDATE`
to atomically join a channel. If the user is already in a different channel,
the row is replaced (all flags reset to 0, `joined_at` reset to now).

---

### dm_participants

Links users to their shared DM channel. Each DM channel has exactly two
participant rows.

```sql
CREATE TABLE dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)                    -- Composite PK: one entry per user per DM channel.
);
```

Note: Migration 008 uses `(channel_id, user_id)` as the primary key. The
original SCHEMA.md described a different schema with `user_a_id`/`user_b_id`
columns and `channel_id` as PK -- the migration (source of truth) uses the
normalized form with separate rows per participant.

---

### dm_open_state

Tracks whether a user has a DM channel visible in their sidebar. Users can
close DMs (hiding them) without deleting the channel or its messages.

```sql
CREATE TABLE dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),-- When the DM was last opened. Used for sorting DMs by most recent activity when no messages exist.
    PRIMARY KEY (user_id, channel_id)
);
```

**Open/Close**:
- `OpenDM`: `INSERT OR IGNORE` -- idempotent, no-op if already open.
- `CloseDM`: `DELETE` -- removes the row.
- Auto-reopen: When a message arrives in a closed DM, the server calls
  `OpenDM` before broadcasting the message event.

---

### schema_versions

Migration tracking table, created by `migrate.go`.

```sql
CREATE TABLE IF NOT EXISTS schema_versions (
    version    TEXT PRIMARY KEY,                          -- Migration filename (e.g., "001_initial_schema.sql").
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))    -- UTC timestamp when the migration was applied.
);
```

---

## Indexes

Every index, what table it covers, and why it exists:

| Index Name | Table | Columns | Purpose |
|------------|-------|---------|---------|
| `idx_sessions_token` | sessions | `(token)` | Fast session lookup by token hash on every authenticated request. Without this, every API call would require a full table scan. |
| `idx_sessions_user` | sessions | `(user_id)` | Fast deletion of all sessions for a user (force logout, ban). Also used by `GetUserSessions`. |
| `idx_messages_channel` | messages | `(channel_id, id DESC)` | Primary query pattern: "get latest N messages in channel X". The compound index covers both the WHERE clause and ORDER BY in a single index scan, avoiding a filesort. DESC ensures newest messages are found first. |
| `idx_messages_user` | messages | `(user_id)` | Supports queries filtering by author (e.g., "messages by user X"). Currently used by potential future moderation queries. |
| `idx_invites_code` | invites | `(code)` | Fast invite validation during registration. The `code` column is already UNIQUE, so this index is redundant (SQLite auto-creates an index for UNIQUE constraints). Kept for documentation clarity. |
| `idx_audit_timestamp` | audit_log | `(created_at DESC)` | Pagination of audit log entries (newest first). The `GetAuditLog` query orders by `id DESC`, but this index on `created_at DESC` still helps when filtering by time range. |
| `idx_audit_log_actor` | audit_log | `(actor_id)` | Filter audit log entries by actor (e.g., "what did user X do?"). Added in migration 003. |
| `idx_login_ip` | login_attempts | `(ip_address, timestamp)` | Rate limiting: "how many failed attempts from IP X in the last 15 minutes?" The compound index supports both the WHERE filter on IP and the time-range condition. |
| `idx_voice_states_channel` | voice_states | `(channel_id)` | Fast lookup of all users in a given voice channel. Used by `GetChannelVoiceStates`, `CountChannelVoiceUsers`, and `CountActiveCameras`. |
| `idx_channel_overrides_channel_role` | channel_overrides | `(channel_id, role_id)` | Covers the `GetChannelPermissions` query exactly (`WHERE channel_id = ? AND role_id = ?`). Added in migration 005 to prevent N+1 degradation when listing channels with permission checks. |
| `idx_dm_participants_user` | dm_participants | `(user_id)` | Supports the DM channel lookup query in `GetOrCreateDMChannel`, which JOINs `dm_participants` on `user_id`. Without this, finding a DM between two users would scan the entire table. |

**Implicit indexes** (created automatically by SQLite):

- Every `PRIMARY KEY` column has an implicit unique index.
- Every `UNIQUE` constraint has an implicit index.
- Composite PKs (`read_states`, `dm_participants`, `dm_open_state`) have
  implicit indexes on the combined columns.

---

## Permission Bitfield System

Permissions are stored as an integer bitfield (Go `int64`, 31 bits used) in `roles.permissions`,
`channel_overrides.allow`, and `channel_overrides.deny`.

### Bit Map

| Bit | Hex | Decimal | Name | Description |
|-----|-----|---------|------|-------------|
| 0 | `0x1` | 1 | `SEND_MESSAGES` | Post messages in text channels. |
| 1 | `0x2` | 2 | `READ_MESSAGES` | View messages in text channels. Without this, the channel is invisible. |
| 5 | `0x20` | 32 | `ATTACH_FILES` | Upload file attachments to messages. |
| 6 | `0x40` | 64 | `ADD_REACTIONS` | Add emoji reactions to messages. |
| 8 | `0x100` | 256 | `USE_SOUNDBOARD` | Play sounds from the soundboard in voice channels. |
| 9 | `0x200` | 512 | `CONNECT_VOICE` | Join voice channels. |
| 10 | `0x400` | 1024 | `SPEAK_VOICE` | Transmit audio in voice channels. |
| 11 | `0x800` | 2048 | `USE_VIDEO` | Enable camera in voice channels. Added to Member role in migration 006. |
| 12 | `0x1000` | 4096 | `SHARE_SCREEN` | Share screen in voice channels. Added to Member role in migration 006. |
| 16 | `0x10000` | 65536 | `MANAGE_MESSAGES` | Delete other users' messages, pin/unpin messages. |
| 17 | `0x20000` | 131072 | `MANAGE_CHANNELS` | Create, edit, delete channels. |
| 18 | `0x40000` | 262144 | `KICK_MEMBERS` | Kick users from the server. |
| 19 | `0x80000` | 524288 | `BAN_MEMBERS` | Ban/unban users. |
| 20 | `0x100000` | 1048576 | `MUTE_MEMBERS` | Server-side mute/deafen other users in voice. |
| 24 | `0x1000000` | 16777216 | `MANAGE_ROLES` | Create, edit, delete roles. |
| 25 | `0x2000000` | 33554432 | `MANAGE_SERVER` | Modify server settings (name, icon, MOTD, etc.). |
| 26 | `0x4000000` | 67108864 | `MANAGE_INVITES` | Create and revoke invite codes. |
| 27 | `0x8000000` | 134217728 | `VIEW_AUDIT_LOG` | View the audit log. |
| 30 | `0x40000000` | 1073741824 | `ADMINISTRATOR` | Bypasses ALL permission checks. Only Owner role has this by default. |

Bits 2-4, 7, 13-15, 21-23, 28-29, 31 are **reserved** (unused, value 0).

### Permission Checking Logic

Permission checks happen in the application layer (not SQL). The
algorithm for a user in a specific channel:

```
1. Get the user's role -> role.Permissions (base)
2. If (base & ADMINISTRATOR) != 0 -> ALLOW everything (short-circuit)
3. Get channel_overrides for (channel_id, role_id) -> allow, deny
4. effective = (base | allow) & ~deny
5. Check: (effective & required_permission) != 0
```

**DM channels bypass role permissions entirely.** DM authorization uses
`IsDMParticipant(userID, channelID)` instead of role-based checks. Every
handler touching a channel must branch on `channel.Type == "dm"`.

### Default Role Permission Values

| Role | Hex | Binary (relevant bits) | Permissions |
|------|-----|----------------------|-------------|
| Owner | `0x7FFFFFFF` | All 31 bits set | Everything including ADMINISTRATOR |
| Admin | `0x3FFFFFFF` | Bits 0-29 set | Everything except ADMINISTRATOR |
| Moderator | `0x000FFFFF` | Bits 0-19 set | All message + voice + moderation |
| Member | `0x1E63` | Bits 0,1,5,6,9,10,11,12 | Send, read, attach, react, voice connect/speak, video, screen share |

---

## Queries by Domain

All queries use parameterized bind parameters (`?`) to prevent SQL
injection. No raw string interpolation is used in queries except for the
`VACUUM INTO` backup command (which has structural validation guards).

### User Operations

Source: `db/auth_queries.go`, `db/admin_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `CreateUser` | `INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)` | Returns `LastInsertId()`. |
| `GetUserByUsername` | `SELECT ... FROM users WHERE username = ? COLLATE NOCASE` | Case-insensitive lookup. Returns `nil, nil` if not found. |
| `GetUserByID` | `SELECT ... FROM users WHERE id = ?` | Returns `nil, nil` if not found. |
| `UpdateUserStatus` | `UPDATE users SET status = ?, last_seen = datetime('now') WHERE id = ?` | Also updates `last_seen`. |
| `ResetAllUserStatuses` | `UPDATE users SET status = 'offline' WHERE status != 'offline'` | Called on server startup. |
| `BanUser` | `UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?` | `expires` is ISO 8601 or NULL (permanent). |
| `UnbanUser` | `UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?` | Clears all ban fields. |
| `UpdateUserRole` | `UPDATE users SET role_id = ? WHERE id = ?` | Admin role change. |
| `ListAllUsers` | `SELECT u.*, COALESCE(r.name, '') FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.id ASC LIMIT ? OFFSET ?` | Paginated, includes role name. |
| `ListMembers` | `SELECT u.id, u.username, u.avatar, u.status, LOWER(r.name) FROM users u JOIN roles r ON u.role_id = r.id WHERE u.banned = 0 ORDER BY u.username ASC` | For ready payload. Excludes banned users. Role name lowercased. |
| `UserCount` | `SELECT COUNT(*) FROM users` | Used to determine if this is the first user (assigned Owner role). |

### Session Operations

Source: `db/auth_queries.go`, `db/admin_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `CreateSession` | `INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)` | `expires_at` = now + 30 days. `token` is SHA-256 hash. |
| `GetSessionByTokenHash` | `SELECT ... FROM sessions WHERE token = ?` | Returns `nil, nil` if not found. |
| `GetSessionWithBanStatus` | `SELECT s.*, u.banned, u.ban_reason, u.ban_expires FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?` | Single query instead of two round-trips. Used by auth middleware. |
| `DeleteSession` | `DELETE FROM sessions WHERE token = ?` | Logout. |
| `DeleteExpiredSessions` | `DELETE FROM sessions WHERE strftime('%s', expires_at) < strftime('%s', 'now')` | Periodic cleanup. Uses `strftime` for format-agnostic comparison. |
| `TouchSession` | `UPDATE sessions SET last_used = datetime('now') WHERE token = ?` | Updates activity timestamp on each request. |
| `ForceLogoutUser` | `DELETE FROM sessions WHERE user_id = ?` | Removes all sessions for a user (admin action). |
| `GetUserSessions` | `SELECT ... FROM sessions WHERE user_id = ? ORDER BY created_at DESC` | Lists all active sessions for admin UI. |

### Channel Operations

Source: `db/channel_queries.go`, `db/admin_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `ListChannels` | `SELECT ... FROM channels ORDER BY position ASC, id ASC` | Returns all channels. Secondary sort by id ensures stable ordering. |
| `GetChannel` | `SELECT ... FROM channels WHERE id = ?` | Returns `nil, nil` if not found. |
| `CreateChannel` | `INSERT INTO channels (name, type, category, topic, position) VALUES (?, ?, ?, ?, ?)` | `category` and `topic` stored as NULL when empty via `nullableString()`. |
| `AdminCreateChannel` | Same as `CreateChannel` but via admin path | Identical SQL. |
| `UpdateChannel` | `UPDATE channels SET name = ?, topic = ?, slow_mode = ? WHERE id = ?` | Basic channel edit. |
| `AdminUpdateChannel` | `UPDATE channels SET name = ?, topic = ?, slow_mode = ?, position = ?, archived = ? WHERE id = ?` | Full admin edit including position and archive. |
| `SetChannelSlowMode` | `UPDATE channels SET slow_mode = ? WHERE id = ?` | Single-field update. |
| `SetChannelVoiceMaxUsers` | `UPDATE channels SET voice_max_users = ? WHERE id = ?` | Single-field update. |
| `DeleteChannel` / `AdminDeleteChannel` | `DELETE FROM channels WHERE id = ?` | Cascades to messages, overrides, etc. |
| `GetChannelPermissions` | `SELECT allow, deny FROM channel_overrides WHERE channel_id = ? AND role_id = ?` | Returns `(0, 0, nil)` when no override exists. |
| `GetAllChannelPermissionsForRole` | `SELECT channel_id, allow, deny FROM channel_overrides WHERE role_id = ?` | Batch fetch all overrides for a role. Returns `map[channelID]ChannelOverride`. Eliminates N+1 queries. |

### Message Operations

Source: `db/message_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `CreateMessage` | `INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)` | Returns `LastInsertId()`. Triggers FTS5 insert. |
| `GetMessage` | `SELECT ... FROM messages WHERE id = ?` | Returns deleted messages too (for broadcast). `nil, nil` if not found. |
| `GetMessages` | `SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ... WHERE m.channel_id = ? [AND m.id < ?] AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?` | Cursor-based pagination. `before` parameter for infinite scroll. |
| `GetMessagesForAPI` | Same as `GetMessages` but with batch reaction/attachment enrichment | Returns `[]MessageAPIResponse` with nested user, reactions, attachments. |
| `EditMessage` | `UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?` | Ownership check first: returns `ErrForbidden` if `msg.UserID != userID`. Triggers FTS5 update. |
| `DeleteMessage` | `UPDATE messages SET deleted = 1 WHERE id = ?` | Soft delete. Ownership or moderator check. Returns `ErrNotFound` / `ErrForbidden`. |
| `SetMessagePinned` | `UPDATE messages SET pinned = ? WHERE id = ? AND deleted = 0` | Returns `ErrNotFound` if message missing or deleted. |
| `GetPinnedMessages` | `SELECT ... WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.id DESC` | Returns all pinned messages with enrichment. |
| `GetLatestMessageID` | `SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND deleted = 0` | Returns 0 if channel has no messages. |

### Full-Text Search

Source: `db/message_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `SearchMessages` | `SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content, m.timestamp FROM messages_fts f JOIN messages m ON f.rowid = m.id JOIN channels c ON m.channel_id = c.id JOIN users u ON m.user_id = u.id WHERE messages_fts MATCH ? [AND m.channel_id = ?] AND m.deleted = 0 ORDER BY rank LIMIT ?` | Returns empty slice for empty query or limit < 1. Optional channel scoping. BM25 relevance ranking. |

### Reaction Operations

Source: `db/message_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `AddReaction` | `INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)` | UNIQUE constraint prevents duplicates. |
| `RemoveReaction` | `DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?` | Returns `ErrNotFound` if no row affected. |
| `GetReactions` | `SELECT emoji, COUNT(*) FROM reactions WHERE message_id = ? GROUP BY emoji` | Aggregated counts per emoji. |
| `getReactionsBatch` | Dynamic IN-clause query with `MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) as me` | Batch fetch for multiple messages. Returns `map[messageID][]ReactionInfo` with per-user "me" flag. |

### Read State Operations

Source: `db/message_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `UpdateReadState` | `INSERT INTO read_states ... ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id` | Upsert: creates or updates. |
| `GetChannelUnreadCounts` | Complex query joining channels, messages, and read_states with COUNT(CASE WHEN ...) | Returns `map[channelID]ChannelUnread` for text channels only. |

### Invite Operations

Source: `db/auth_queries.go`, `db/invite_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `CreateInvite` | `INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)` | Code: 8 random bytes as hex. |
| `GetInvite` | `SELECT ... FROM invites WHERE code = ?` | Returns `nil, nil` if not found. |
| `UseInviteAtomic` | See invites table section above | Single atomic UPDATE with all validation. |
| `RevokeInvite` | `UPDATE invites SET revoked = 1 WHERE code = ?` | Marks as revoked. |
| `ListInvites` | `SELECT ... FROM invites ORDER BY created_at DESC` | All invites, newest first. |

### Role Operations

Source: `db/role_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `GetRoleByID` | `SELECT id, name, color, permissions, position, is_default FROM roles WHERE id = ?` | Returns `nil, nil` if not found. |
| `ListRoles` | `SELECT ... FROM roles ORDER BY position DESC` | Highest position first (Owner at top). |

### Voice Operations

Source: `db/voice_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `JoinVoiceChannel` | `INSERT INTO voice_states ... ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, muted = 0, deafened = 0, speaking = 0, camera = 0, screenshare = 0, joined_at = datetime('now')` | Atomic join/switch. Resets all flags. |
| `LeaveVoiceChannel` | `DELETE FROM voice_states WHERE user_id = ?` | Safe to call when not in a channel. |
| `GetVoiceState` | `SELECT vs.*, u.username FROM voice_states vs JOIN users u ON u.id = vs.user_id WHERE vs.user_id = ?` | Returns `nil, nil` if user is not in voice. |
| `GetChannelVoiceStates` | `SELECT vs.*, u.username FROM voice_states vs JOIN users u ON u.id = vs.user_id WHERE vs.channel_id = ? ORDER BY vs.joined_at ASC` | All users in a channel, ordered by join time. |
| `GetAllVoiceStates` | Same but no WHERE clause, `ORDER BY vs.channel_id, vs.joined_at ASC` | Used at startup for ready payload. Avoids N+1. |
| `UpdateVoiceMute` | `UPDATE voice_states SET muted = ? WHERE user_id = ?` | No-op if user not in voice. |
| `UpdateVoiceDeafen` | `UPDATE voice_states SET deafened = ? WHERE user_id = ?` | No-op if user not in voice. |
| `UpdateVoiceCamera` | `UPDATE voice_states SET camera = ? WHERE user_id = ?` | Camera toggle. |
| `UpdateVoiceScreenshare` | `UPDATE voice_states SET screenshare = ? WHERE user_id = ?` | Screen share toggle. |
| `ClearVoiceState` | `DELETE FROM voice_states WHERE user_id = ?` | On disconnect. Alias for `LeaveVoiceChannel`. |
| `ClearAllVoiceStates` | `DELETE FROM voice_states` | Server startup cleanup. |
| `CountChannelVoiceUsers` | `SELECT COUNT(*) FROM voice_states WHERE channel_id = ?` | For enforcing `voice_max_users`. |
| `CountActiveCameras` | `SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND camera = 1` | For enforcing `voice_max_video`. Uses DB as source of truth (serialized by SQLite) rather than querying LiveKit. |

### DM Operations

Source: `db/dm_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `GetOrCreateDMChannel` | Transactional: SELECT existing DM channel or INSERT new channel + participants + open state | Uses `IMMEDIATE` transaction (serializable isolation) to prevent TOCTOU races. If DM exists, also re-opens it for the initiator (`INSERT OR IGNORE INTO dm_open_state`). |
| `GetUserDMChannels` | Complex 6-table join: `dm_open_state` -> `channels` -> `dm_participants` -> `users` + LEFT JOIN `messages` (latest) + LEFT JOIN `messages` (unread count) + LEFT JOIN `read_states` | Returns `[]DMChannelInfo` with recipient info, last message preview, unread count. Ordered by most recent activity. |
| `OpenDM` | `INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)` | Idempotent. |
| `CloseDM` | `DELETE FROM dm_open_state WHERE user_id = ? AND channel_id = ?` | Hides the DM from sidebar. Does not delete messages. |
| `IsDMParticipant` | `SELECT user_id FROM dm_participants WHERE user_id = ? AND channel_id = ?` | Authorization check. Returns bool. Used by every handler that touches a DM channel. |
| `GetDMParticipantIDs` | `SELECT user_id FROM dm_participants WHERE channel_id = ?` | Returns both user IDs. Used for targeted event broadcasting. |
| `GetDMRecipient` | `SELECT user_id FROM dm_participants WHERE channel_id = ? AND user_id != ? LIMIT 1` then `GetUserByID` | Returns the other participant's full User record. Two queries (could be optimized to one join). |

### Attachment Operations

Source: `db/attachment_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `CreateAttachment` | `INSERT INTO attachments (id, filename, stored_as, mime_type, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)` | `message_id` is NOT set at upload time (left NULL). |
| `GetAttachmentByID` | `SELECT ... FROM attachments WHERE id = ?` | Returns `nil, nil` if not found. |
| `LinkAttachmentsToMessage` | `UPDATE attachments SET message_id = ? WHERE id IN (?,?,...) AND message_id IS NULL` | Dynamic IN-clause. `AND message_id IS NULL` prevents double-linking in concurrent races. Returns rows affected. |
| `GetAttachmentsByMessageIDs` | `SELECT id, message_id, filename, size, mime_type, width, height FROM attachments WHERE message_id IN (?,?,...)` | Batch fetch for message enrichment. URL computed as `/api/v1/files/{id}`. Returns `map[msgID][]AttachmentInfo`. |
| `DeleteOrphanedAttachments` | `SELECT stored_as FROM attachments WHERE message_id IS NULL AND uploaded_at < ?` then `DELETE` | Two-phase: first query filenames for disk cleanup, then delete records. Returns filenames for the caller to remove from disk. |

### Admin / Settings / Audit

Source: `db/admin_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `GetServerStats` | 4 separate COUNT(*) queries + 2 PRAGMA queries | Returns user count, message count (non-deleted), channel count, active invite count, DB size (page_count * page_size). |
| `GetSetting` | `SELECT value FROM settings WHERE key = ?` | Returns `ErrNotFound` (wrapped) when key is missing. |
| `SetSetting` | `INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value` | Upsert. |
| `GetAllSettings` | `SELECT key, value FROM settings` | Returns `map[string]string`. |
| `LogAudit` | `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)` | Timestamps auto-set. |
| `GetAuditLog` | `SELECT a.*, COALESCE(u.username, '') FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ? OFFSET ?` | Paginated, newest first. LEFT JOIN handles deleted actors. |

### Backup Operations

Source: `db/admin_queries.go`

| Function | Query Pattern | Notes |
|----------|--------------|-------|
| `BackupTo` | `VACUUM INTO '{path}'` | Creates an online backup. Delegates to `BackupToSafe` with `data/backups` as safe root. |
| `BackupToSafe` | Same SQL, with path validation | **Security**: Path is validated against a safe root directory (must be a subdirectory). Characters `'`, `"`, `;`, `--`, `\x00` are rejected as defense-in-depth. `VACUUM INTO` does not support bind parameters, so structural validation is critical. |

---

## Query Patterns

### Prepared Statements

The codebase does **not** use explicitly prepared statements
(`sql.Prepare`). Instead, all queries pass SQL strings directly to
`db.Exec()`, `db.Query()`, and `db.QueryRow()`. The `database/sql`
package internally caches prepared statements when using parameterized
queries, so the performance difference is negligible for a single-connection
pool.

### Transaction Handling

Transactions are used in two places:

1. **Migrations** (`migrate.go`): Each migration executes within a
   transaction. The migration SQL and its tracking record are committed
   atomically.

2. **DM channel creation** (`dm_queries.go`): `GetOrCreateDMChannel` uses
   `BeginTx` with `sql.LevelSerializable` isolation to prevent TOCTOU
   races. The transaction covers: lookup existing DM -> create channel ->
   insert participants -> insert open state -> commit.

All other operations are single-statement and rely on SQLite's implicit
auto-commit transactions.

### Batch Query Pattern

Several functions use dynamic `IN (?, ?, ...)` clauses for batch
operations:

- `getReactionsBatch`: Aggregates reactions for multiple message IDs.
- `GetAttachmentsByMessageIDs`: Fetches attachments for multiple messages.
- `LinkAttachmentsToMessage`: Links multiple attachment IDs to a message.

These build placeholder strings dynamically using `strings.Builder` and
pass args as `[]any` slices. This avoids N+1 query problems when enriching
message lists.

### Scan Helpers

The codebase uses dedicated scan functions to handle SQLite's lack of
native boolean type:

- `scanUser`: Scans `banned` as `int`, converts to `bool`.
- `scanMessage`: Scans `deleted` and `pinned` as `int`, converts to `bool`.
- `scanVoiceState` / `scanVoiceStateRow`: Scans all flag columns as `int`.
- `scanChannel`: Scans `archived` as `int`.

Pattern: `field = intValue != 0`

### NULL Handling

- `nullableString(s string) any`: Returns `nil` when `s` is empty, so
  empty strings are stored as SQL NULL in optional TEXT columns (`category`,
  `topic`). Read back with `COALESCE(column, '')`.
- `boolToInt(b bool) int`: Converts Go `bool` to `0`/`1` for SQLite storage.
- Optional fields use Go pointer types (`*string`, `*int`, `*int64`) to
  represent SQL NULLs. `sql.NullInt64` is used in `GetUserDMChannels`.

### Datetime Conventions

- All timestamps stored as ISO 8601 UTC strings:
  `"2006-01-02T15:04:05Z"` (Go reference format) or
  `datetime('now')` (SQLite function).
- Comparison uses `strftime('%s', column)` to convert to Unix timestamps
  for reliable ordering across format variations.
- `COALESCE` handles NULL timestamps in joins (e.g., DM channels with no
  messages yet).
