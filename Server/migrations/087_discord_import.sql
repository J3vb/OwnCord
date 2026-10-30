-- Import a Discord channel export as a new channel.
--
-- channels.import_pending is 1 while an import is still building the channel.
-- Every read that hands channels to clients or to a permission check skips such
-- a row, so a half-built import is invisible until the import finishes and
-- flips the flag in the same transaction that marks every member's read state.
ALTER TABLE channels ADD COLUMN import_pending INTEGER NOT NULL DEFAULT 0;

-- One row per import. channel_id and created_by are cleared, not cascaded, when
-- the channel or the admin is deleted, so the history of an import outlives
-- both. imported and skipped count messages, skipped_attachments counts files
-- that were not copied (a remote link, a file missing from the export, a type the
-- upload policy refuses). The partial unique index allows one running import at
-- a time.
CREATE TABLE import_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id         INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_name        TEXT    NOT NULL DEFAULT '',
    discord_channel_id TEXT    NOT NULL DEFAULT '',
    status             TEXT    NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
    total              INTEGER NOT NULL DEFAULT 0,
    imported           INTEGER NOT NULL DEFAULT 0,
    skipped            INTEGER NOT NULL DEFAULT 0,
    skipped_attachments INTEGER NOT NULL DEFAULT 0,
    error              TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at        TEXT
);

CREATE UNIQUE INDEX idx_import_jobs_one_running ON import_jobs(status) WHERE status = 'running';

-- The Discord name and colour an imported message is shown under. Every
-- imported message is owned by the one hidden import account, so this row is
-- what says who wrote it. It goes with the message.
CREATE TABLE message_import_authors (
    message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    discord_user_id TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    color           TEXT
);

-- The hidden import account is a users row whose registration_status is
-- 'system'. The member list, the admin member list and the two-factor count
-- already keep only 'active' rows, and a direct message needs an active
-- recipient, so a 'system' row falls out of all of them without a new filter.
-- At most one such row can exist. The importer creates it on first use.
CREATE UNIQUE INDEX idx_users_system_account ON users(registration_status) WHERE registration_status = 'system';
