-- B4-11: retention (BPR-054, owner decisions 4 and 5).
-- Indefinite by default: the server-wide window is a settings row
-- (retention_days, 0 = keep forever) so it rides the existing settings
-- audit, a channel policy overrides the server policy in either direction,
-- pinned messages are exempt, DMs are never in scope, no hold mechanism
-- exists in beta, so nothing here models one.
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention_days', '0');

CREATE TABLE channel_retention (
    channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    -- 0 = keep forever, overriding a server-wide window, NULL rows do not exist
    days       INTEGER NOT NULL CHECK (days >= 0),
    updated_by INTEGER NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per sweep, so the operator can see what retention removed and
-- the erasure-style file journal has a parent to resume from.
CREATE TABLE retention_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at      TEXT,
    channels         INTEGER NOT NULL DEFAULT 0,
    messages_deleted INTEGER NOT NULL DEFAULT 0,
    files            TEXT    NOT NULL DEFAULT '[]',
    files_removed    INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT
);
