<!-- Generated: 2026-03-20 | Tables: 16 | Migrations: 7 | Token estimate: ~700 -->

# Data Codemap (SQLite)

## Tables

| Table | PK | Key Columns | Indexes |
|-------|----|----|---------|
| roles | id | name, permissions (bitfield), position, is_default | — |
| users | id | username, password (bcrypt), role_id FK, status, banned, totp_secret | username UNIQUE |
| sessions | id | user_id FK, token, ip_address, expires_at | token UNIQUE |
| channels | id | name, type (text/voice), category, position, voice_max_users | — |
| channel_overrides | id | channel_id FK, role_id FK, allow/deny (bitfields) | (channel_id, role_id) |
| messages | id | channel_id FK, user_id FK, content, reply_to, deleted, pinned | (channel_id, id DESC) |
| messages_fts | rowid | FTS5 virtual table (content, channel_id) | — |
| attachments | id (UUID) | message_id FK, filename, stored_as, mime_type, size | — |
| reactions | id | message_id FK, user_id FK, emoji | (message_id, emoji) UNIQUE w/ user |
| voice_states | user_id | channel_id, muted, deafened, camera, screenshare, joined_at | — |
| invites | id | code UNIQUE, created_by FK, max_uses, use_count, expires_at | — |
| read_states | (user_id, channel_id) | last_message_id, mention_count | — |
| audit_log | id | actor_id, action, target_type, target_id, detail, created_at | (actor_id), (created_at DESC) |
| login_attempts | id | ip_address, username, success, timestamp | (ip_address, timestamp) |
| settings | key | value (JSON text) | — |
| emoji, sounds | id | Custom emoji/soundboard storage | — |

## Migration History

| # | File | Change |
|---|------|--------|
| 001 | initial_schema.sql | All base tables + FTS5 |
| 002 | voice_states.sql | voice_states table |
| 003a | audit_log.sql | Canonicalize audit columns |
| 003b | voice_optimization.sql | camera/screenshare fields, voice channel config |
| 004 | fix_member_permissions.sql | Member role perms = 0x663 |
| 005 | channel_overrides_index.sql | Composite index for permission lookups |
| 006 | member_video_permissions.sql | Add USE_VIDEO + SHARE_SCREEN bits |

## Query Files (db/)

| File | Tables | Methods |
|------|--------|---------|
| auth_queries.go | users, sessions, invites | CreateUser, GetUserBy*, BanUser, Session CRUD, Invite CRUD |
| channel_queries.go | channels, channel_overrides | List/Get/Create/Delete Channel, permissions |
| message_queries.go | messages, reactions, read_states | CRUD, Search (FTS5), pagination, reactions |
| voice_queries.go | voice_states | Join/Leave, GetState, Update mute/camera/etc |
| attachment_queries.go | attachments | Create, Link to message, Get by message IDs |
| admin_queries.go | audit_log, settings, users | Stats, audit, settings, backup |

## DB Config
- Driver: `modernc.org/sqlite` (pure Go, no CGO)
- WAL mode, busy timeout 5s, single-writer
- Foreign keys enforced
