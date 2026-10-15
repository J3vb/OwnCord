-- A custom status can now clear itself. custom_status_expires_at holds the
-- instant the status ends, written by Go as 2006-01-02T15:04:05Z (NULL = no
-- expiry). The partial index keeps the expirer's MIN/range reads cheap: only
-- the few rows that carry an expiry are indexed.
ALTER TABLE users ADD COLUMN custom_status_expires_at TEXT;

CREATE INDEX idx_users_custom_status_expires_at
    ON users(custom_status_expires_at)
    WHERE custom_status_expires_at IS NOT NULL;
