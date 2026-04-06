-- Migration 001 (PostgreSQL): Initial schema
--
-- This is a consolidated PostgreSQL translation of the SQLite migrations
-- 001-013 found in Server/migrations/. PostgreSQL is a fresh-start backend,
-- so we collapse the SQLite migration history into a single canonical schema
-- file. Future PostgreSQL schema changes should land as 002_*.sql, 003_*.sql,
-- etc., mirroring the SQLite numbering convention.
--
-- DIFFERENCES FROM SQLITE:
--   - INTEGER PRIMARY KEY AUTOINCREMENT  -> BIGSERIAL PRIMARY KEY
--   - TEXT NOT NULL DEFAULT (datetime('now')) -> TIMESTAMPTZ NOT NULL DEFAULT NOW()
--   - INTEGER (used as bool) -> BOOLEAN NOT NULL DEFAULT FALSE
--   - INTEGER permission bitfield -> BIGINT NOT NULL DEFAULT 0
--   - FTS5 virtual table -> tsvector column on messages + GIN index +
--     trigger to keep tsvector in sync (see "Full-text search" section).
--   - SQLite triggers using RAISE(ABORT) -> native CHECK constraints.
--   - COLLATE NOCASE -> CITEXT extension on the username column.
--
-- The store.MessageStore.SearchMessages implementation must dispatch on
-- backend type because the query syntax differs (MATCH vs @@).

CREATE EXTENSION IF NOT EXISTS citext;

-- ── roles ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT      NOT NULL UNIQUE,
    color       TEXT,
    permissions BIGINT    NOT NULL DEFAULT 0,
    position    INTEGER   NOT NULL DEFAULT 0,
    is_default  BOOLEAN   NOT NULL DEFAULT FALSE
);

-- Default roles. Permission bitfields match the SQLite seed values.
-- Member final value (7779) reflects SQLite migrations 005 and 007 combined.
INSERT INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, FALSE),
    (2, 'Admin',     '#F39C12', 1073741823,  80, FALSE),
    (3, 'Moderator', '#3498DB',    1048575,  60, FALSE),
    (4, 'Member',    NULL,            7779,  40, TRUE)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence past the seeded rows so user-created roles get IDs >= 5.
SELECT setval('roles_id_seq', GREATEST((SELECT MAX(id) FROM roles), 1));

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id          BIGSERIAL   PRIMARY KEY,
    username    CITEXT      NOT NULL UNIQUE,
    password    TEXT        NOT NULL,
    avatar      TEXT,
    role_id     BIGINT      NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT        NOT NULL DEFAULT 'offline',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ,
    banned      BOOLEAN     NOT NULL DEFAULT FALSE,
    ban_reason  TEXT,
    ban_expires TIMESTAMPTZ
);

-- ── sessions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    id         BIGSERIAL   PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT        NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

-- ── channels ────────────────────────────────────────────────────────────────
-- Includes columns from migrations 001 + 004 (voice columns).
-- The CHECK constraint replaces SQLite migration 013's trigger.
CREATE TABLE IF NOT EXISTS channels (
    id               BIGSERIAL   PRIMARY KEY,
    name             TEXT        NOT NULL,
    type             TEXT        NOT NULL DEFAULT 'text'
        CHECK (type IN ('text', 'voice', 'dm')),
    category         TEXT,
    topic            TEXT,
    position         INTEGER     NOT NULL DEFAULT 0,
    slow_mode        INTEGER     NOT NULL DEFAULT 0,
    archived         BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voice_max_users  INTEGER     NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER     NOT NULL DEFAULT 25
);

-- ── channel_overrides ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_overrides (
    id         BIGSERIAL PRIMARY KEY,
    channel_id BIGINT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    BIGINT    NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      BIGINT    NOT NULL DEFAULT 0,
    deny       BIGINT    NOT NULL DEFAULT 0,
    UNIQUE (channel_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_overrides_channel_role
    ON channel_overrides(channel_id, role_id);

-- ── messages + full-text search ─────────────────────────────────────────────
-- PostgreSQL uses a tsvector column with a GIN index instead of the SQLite
-- FTS5 virtual table. The fts column is maintained automatically by a
-- trigger so application code doesn't need to set it.
CREATE TABLE IF NOT EXISTS messages (
    id         BIGSERIAL   PRIMARY KEY,
    channel_id BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id),
    content    TEXT        NOT NULL,
    reply_to   BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TIMESTAMPTZ,
    deleted    BOOLEAN     NOT NULL DEFAULT FALSE,
    pinned     BOOLEAN     NOT NULL DEFAULT FALSE,
    timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fts        tsvector
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user    ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_fts     ON messages USING GIN (fts);

CREATE OR REPLACE FUNCTION messages_fts_update() RETURNS trigger AS $$
BEGIN
    NEW.fts := to_tsvector('simple', COALESCE(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_fts_update ON messages;
CREATE TRIGGER trg_messages_fts_update
    BEFORE INSERT OR UPDATE OF content ON messages
    FOR EACH ROW
    EXECUTE FUNCTION messages_fts_update();

-- ── attachments ─────────────────────────────────────────────────────────────
-- Combines migrations 001 + 008 (width, height) + 010 (uploader_id).
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT        PRIMARY KEY,
    message_id  BIGINT      REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT        NOT NULL,
    stored_as   TEXT        NOT NULL,
    mime_type   TEXT        NOT NULL,
    size        BIGINT      NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    width       INTEGER,
    height      INTEGER,
    uploader_id BIGINT      REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);

-- ── reactions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reactions (
    id         BIGSERIAL PRIMARY KEY,
    message_id BIGINT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    BIGINT    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT      NOT NULL,
    UNIQUE (message_id, user_id, emoji)
);

-- ── invites ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
    id          BIGSERIAL   PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    created_by  BIGINT      NOT NULL REFERENCES users(id),
    redeemed_by BIGINT      REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER     NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked     BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

-- ── read_states ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS read_states (
    user_id         BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id BIGINT NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

-- ── audit_log ───────────────────────────────────────────────────────────────
-- Phase-6 canonical column names (matches SQLite migration 003).
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    actor_id    BIGINT      NOT NULL DEFAULT 0,
    action      TEXT        NOT NULL,
    target_type TEXT        NOT NULL DEFAULT '',
    target_id   BIGINT      NOT NULL DEFAULT 0,
    detail      TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);

-- ── login_attempts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGSERIAL   PRIMARY KEY,
    ip_address TEXT        NOT NULL,
    username   TEXT,
    success    BOOLEAN     NOT NULL DEFAULT FALSE,
    timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip_address, timestamp);

-- ── settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
    ('server_name',        'OwnCord Server'),
    ('server_icon',        ''),
    ('motd',               'Welcome!'),
    ('max_upload_bytes',   '26214400'),
    ('voice_quality',      'high'),
    ('require_2fa',        '0'),
    ('registration_open',  '0'),
    ('backup_schedule',    'daily'),
    ('backup_retention',   '7'),
    ('schema_version',     '1')
ON CONFLICT (key) DO NOTHING;

-- ── emoji ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emoji (
    id          BIGSERIAL   PRIMARY KEY,
    shortcode   TEXT        NOT NULL UNIQUE,
    filename    TEXT        NOT NULL,
    uploaded_by BIGINT      NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── sounds ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sounds (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        NOT NULL,
    filename    TEXT        NOT NULL,
    duration_ms INTEGER     NOT NULL,
    uploaded_by BIGINT      NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── voice_states ────────────────────────────────────────────────────────────
-- Combines migrations 002 + 004 (camera, screenshare).
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     BIGINT      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       BOOLEAN     NOT NULL DEFAULT FALSE,
    deafened    BOOLEAN     NOT NULL DEFAULT FALSE,
    speaking    BOOLEAN     NOT NULL DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    camera      BOOLEAN     NOT NULL DEFAULT FALSE,
    screenshare BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);

-- ── direct messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);

CREATE TABLE IF NOT EXISTS dm_open_state (
    user_id    BIGINT      NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, channel_id)
);

-- ── rate_lockouts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_lockouts (
    key        TEXT        PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);

-- ── user_blocks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id, blocker_id);

-- ── events (Phase B Step 7: event persistence) ──────────────────────────────
-- Cold-storage replay buffer for WebSocket reconnections that fall outside the
-- in-memory ring window. Pruned by a background goroutine after the configured
-- retention window (default 24h).
CREATE TABLE IF NOT EXISTS events (
    seq        BIGSERIAL   PRIMARY KEY,
    event_type TEXT        NOT NULL,
    payload    BYTEA       NOT NULL,
    channel_id BIGINT      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_channel_seq ON events(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_created_at  ON events(created_at);

-- ── plugins (Phase C Step 9: Wazero plugin runtime) ─────────────────────────
CREATE TABLE IF NOT EXISTS plugins (
    id            BIGSERIAL   PRIMARY KEY,
    name          TEXT        NOT NULL UNIQUE,
    version       TEXT        NOT NULL,
    enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    manifest_json TEXT        NOT NULL,
    installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_kv (
    plugin_id BIGINT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key       TEXT   NOT NULL,
    value     BYTEA  NOT NULL,
    PRIMARY KEY (plugin_id, key)
);
