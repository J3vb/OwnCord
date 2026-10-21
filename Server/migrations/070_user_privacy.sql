-- Per-user direct message privacy (WP 6.8b).
--
-- user_privacy holds one row per user who has saved a privacy choice. A user
-- with no row has both settings on, so this migration writes no rows. The row
-- is read and written only through the owner's own session and is removed with
-- the account.
CREATE TABLE user_privacy (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    allow_member_dms  INTEGER NOT NULL DEFAULT 1 CHECK (allow_member_dms IN (0, 1)),
    message_requests  INTEGER NOT NULL DEFAULT 1 CHECK (message_requests IN (0, 1)),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) WITHOUT ROWID;
