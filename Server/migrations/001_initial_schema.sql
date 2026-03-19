-- Migration 001: Initial schema
-- All tables for the OwnCord server database.

-- Roles must be created before users (foreign key dependency).
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

-- Insert default roles on first run.
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default)
VALUES
    (1, 'Owner',     '#E74C3C', 0x7FFFFFFF, 100, 0),
    (2, 'Admin',     '#F39C12', 0x3FFFFFFF,  80, 0),
    (3, 'Moderator', '#3498DB', 0x000FFFFF,  60, 0),
    (4, 'Member',    NULL,      0x00000663,  40, 1);

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL DEFAULT 'text',
    category   TEXT,
    topic      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    slow_mode  INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS messages (
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

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user    ON messages(user_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS invites (
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

CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT,
    target_id   INTEGER,
    details     TEXT,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT    NOT NULL,
    username   TEXT,
    success    INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip_address, timestamp);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default server settings.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name',        'OwnCord Server'),
    ('server_icon',        ''),
    ('motd',               'Welcome!'),
    ('max_upload_bytes',   '26214400'),
    ('voice_quality',      'high'),
    ('require_2fa',        '0'),
    ('registration_open',  '0'),
    ('backup_schedule',    'daily'),
    ('backup_retention',   '7'),
    ('schema_version',     '1');

CREATE TABLE IF NOT EXISTS emoji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode   TEXT    NOT NULL UNIQUE,
    filename    TEXT    NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    filename    TEXT    NOT NULL,
    duration_ms INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
