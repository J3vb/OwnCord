package api_test

// The api tests build their databases from a reduced schema instead of the
// full migration set (which seeds channels and settings the tests count).
// These blocks are the parts every schema repeats.

// schemaAccounts holds the accounts, sessions, recovery and category/override tables every api schema carries.
const schemaAccounts = `
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0,
    hoist       INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1635,     40, 1);
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
    ban_expires TEXT,
    registration_status TEXT NOT NULL DEFAULT 'active',
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT,
    custom_status_expires_at TEXT,
    banner_id TEXT,
    banner_color TEXT
);
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS user_roles_on_user_insert AFTER INSERT ON users
BEGIN
    INSERT OR IGNORE INTO user_roles (user_id, role_id)
    SELECT NEW.id, r.id FROM roles r WHERE r.id = NEW.role_id;
END;
CREATE TABLE IF NOT EXISTS erasure_jobs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    state   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    unseen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_kits (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier   TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS recovery_assists (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    issued_by INTEGER NOT NULL,
    verification TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE TABLE IF NOT EXISTS channel_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_categories_name ON channel_categories(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS category_overrides (
    category_id INTEGER NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow       INTEGER NOT NULL DEFAULT 0,
    deny        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id, role_id)
);
CREATE TABLE IF NOT EXISTS category_user_overrides (
    category_id INTEGER NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allow       INTEGER NOT NULL DEFAULT 0,
    deny        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS import_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id         INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_name        TEXT    NOT NULL DEFAULT '',
    discord_channel_id TEXT    NOT NULL DEFAULT '',
    status             TEXT    NOT NULL DEFAULT 'running',
    total              INTEGER NOT NULL DEFAULT 0,
    imported           INTEGER NOT NULL DEFAULT 0,
    skipped            INTEGER NOT NULL DEFAULT 0,
    skipped_attachments INTEGER NOT NULL DEFAULT 0,
    error              TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at        TEXT
);
CREATE TABLE IF NOT EXISTS message_import_authors (
    message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    name            TEXT NOT NULL,
    color           TEXT
);
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
);
CREATE TABLE IF NOT EXISTS message_role_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL,
    PRIMARY KEY (message_id, role_id)
);
`

// schemaMessaging holds the channel overrides, messages and read state.
const schemaMessaging = `
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
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
    mentions_everyone INTEGER NOT NULL DEFAULT 0,
    pinned_at  TEXT,
    kind       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS read_states (
    user_id         INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS dm_open_state (
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);
-- B5-9: PurgeMessages/DeleteMessage write a removal row here in the same
-- transaction as their effect (PurgeChannelMessagesWithAction/
-- DeleteMessageWithRemoval).
CREATE TABLE IF NOT EXISTS moderation_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL CHECK (kind IN ('warning', 'timeout', 'removal', 'kick', 'ban')),
    target_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id        INTEGER NOT NULL DEFAULT 0,
    actor_token     TEXT,
    report_id       INTEGER,
    reason          TEXT    NOT NULL DEFAULT '',
    expires_at      TEXT,
    acknowledged_at TEXT,
    lifted_at       TEXT,
    lifted_by       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`

// schemaPolls holds the polls, forwards and the other message extras.
const schemaPolls = `
-- History reads look up forward blocks on every page (migration 071).
CREATE TABLE IF NOT EXISTS message_forwards (
    message_id        INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    source_channel_id INTEGER NOT NULL,
    source_timestamp  TEXT    NOT NULL
);
-- History reads look up poll blocks on every page (migration 073).
CREATE TABLE IF NOT EXISTS polls (
    message_id        INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question          TEXT    NOT NULL,
    allow_multiselect INTEGER NOT NULL DEFAULT 0,
    expires_at        TEXT    NOT NULL,
    ended_at          TEXT,
    version           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_answers (
    message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    answer_id  INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    emoji      TEXT,
    PRIMARY KEY (message_id, answer_id)
);
CREATE TABLE IF NOT EXISTS poll_votes (
    message_id INTEGER NOT NULL,
    answer_id  INTEGER NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id, answer_id)
);
-- History and search reads look up the sticker block (migration 083).
CREATE TABLE IF NOT EXISTS message_stickers (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    sticker_id INTEGER,
    name       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER,
    duration_ms INTEGER,
    waveform    TEXT,
    uploader_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);
-- Group DM create reads the recipients' DM privacy, trust rows and the
-- creator's message requests (migrations 046 and 070, WP 6.8d).
CREATE TABLE IF NOT EXISTS user_privacy (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    allow_member_dms  INTEGER NOT NULL DEFAULT 1 CHECK (allow_member_dms IN (0, 1)),
    message_requests  INTEGER NOT NULL DEFAULT 1 CHECK (message_requests IN (0, 1)),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS trusted_senders (
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source       TEXT    NOT NULL CHECK (source IN ('accepted', 'sent_first', 'grandfathered')),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (recipient_id, sender_id)
);
CREATE TABLE IF NOT EXISTS message_requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    first_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'accepted', 'ignored', 'deleted', 'blocked')),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_at       TEXT,
    UNIQUE (sender_id, recipient_id)
);
`
