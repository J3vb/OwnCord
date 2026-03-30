<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~700 -->

# Data Layer Codemap

## SQLite Schema (8 migrations)

### Core Tables

**users** -- User accounts
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| username | TEXT UNIQUE | COLLATE NOCASE, 2-32 runes |
| password | TEXT | bcrypt hash |
| avatar | TEXT | nullable, file ID |
| role_id | INTEGER FK | -> roles(id), default 4 (Member) |
| totp_secret | TEXT | nullable, TOTP seed |
| status | TEXT | online/idle/dnd/offline |
| banned, ban_reason, ban_expires | | ban system |

**roles** -- Permission roles (4 defaults)
| ID | Name | Permissions | Position |
|----|------|-------------|----------|
| 1 | Owner | 0x7FFFFFFF | 100 |
| 2 | Admin | 0x3FFFFFFF | 80 |
| 3 | Moderator | 0x000FFFFF | 60 |
| 4 | Member | 0x00000663 | 40 (default) |

**channels** -- Text + voice + DM channels
- type: "text" | "voice" | "dm"
- voice fields: voice_max_users, voice_quality, mixing_threshold, voice_max_video

**channel_overrides** -- Per-role allow/deny bitfields per channel
- UNIQUE(channel_id, role_id)

### Messaging Tables

**messages** -- Chat messages
- FK: channel_id -> channels, user_id -> users, reply_to -> messages
- Indexes: (channel_id, id DESC), (user_id)

**messages_fts** -- FTS5 virtual table for full-text search
- Triggers: messages_ai (insert), messages_ad (delete), messages_au (update)

**attachments** -- File uploads linked to messages
- id: TEXT PK (UUID), mime_type, size, width/height (images)

**reactions** -- Emoji reactions
- UNIQUE(message_id, user_id, emoji)

### Auth Tables

**sessions** -- Login sessions
- token (SHA-256 hash), device, ip, 30-day TTL
- Indexes: (token), (user_id)

**login_attempts** -- Brute-force tracking
- Index: (ip_address, timestamp)

### DM Tables (migration 008)

**dm_participants** -- DM channel membership
- PK: (channel_id, user_id)
- Index: (user_id)

**dm_open_state** -- Per-user DM visibility
- PK: (user_id, channel_id)

### Voice Table (migration 002)

**voice_states** -- Active voice connections
- PK: user_id, FK: channel_id
- muted, deafened, speaking, joined_at
- Index: (channel_id)

### Other Tables

| Table | Purpose |
|-------|---------|
| invites | Invite codes with max_uses, expiry, revocation |
| read_states | Per-user per-channel last_message_id + mention_count |
| audit_log | Admin action log (user_id, action, target, details) |
| settings | Key-value server config (schema_version, require_2fa, etc.) |
| emoji | Custom emoji (shortcode, filename) |
| sounds | Custom sound effects |

## Migration History

| # | File | Change |
|---|------|--------|
| 001 | initial_schema.sql | All base tables, FTS5, triggers, default roles |
| 002 | voice_states.sql | voice_states table |
| 003a | audit_log.sql | Canonicalize audit columns |
| 003b | voice_optimization.sql | camera/screenshare fields, voice channel config |
| 004 | fix_member_permissions.sql | Member role perms = 0x663 |
| 005 | channel_overrides_index.sql | Composite index for permission lookups |
| 006 | member_video_permissions.sql | Add USE_VIDEO + SHARE_SCREEN bits |
| 007 | attachment_dimensions.sql | width/height columns on attachments |
| 008 | dm_tables.sql | dm_participants + dm_open_state tables |

## DB Access Layer (db/)
| File | Lines | Operations |
|------|-------|-----------|
| auth_queries.go | 434 | CreateUser, AuthenticateUser, CreateSession, ValidateSession, SetTOTPSecret |
| message_queries.go | 522 | InsertMessage, GetMessages, EditMessage, DeleteMessage, SearchMessages (FTS5) |
| channel_queries.go | 243 | ListChannels, CreateChannel, UpdateChannel, DeleteChannel, GetChannelPermissions |
| dm_queries.go | 286 | GetOrCreateDMChannel, GetUserDMChannels, OpenDM, CloseDM, IsDMParticipant |
| voice_queries.go | 278 | JoinVoice, LeaveVoice, GetVoiceStates, UpdateVoiceState |
| admin_queries.go | 374 | GetStats, ListUsers, BanUser, AuditLog, GetSettings |
| attachment_queries.go | 156 | InsertAttachment, GetAttachment, GetMessageAttachments |
| account.go | 101 | ChangePassword, ChangeAvatar, DeleteAccount |
| errors.go | 33 | Sentinel errors: ErrNotFound, ErrDuplicate, ErrForbidden |
| db.go | 136 | Open, WAL mode, busy timeout, FK enforcement |
| models.go | 198 | All Go struct definitions (User, Message, Channel, VoiceState, etc.) |
