-- Optional password on a voice channel. password_hash is a bcrypt hash and
-- NULL means the channel has no password. password_version starts at 0 and goes
-- up by one every time the password is set, changed or removed, so a grant for
-- an older password stops counting.
--
-- channel_password_grants remembers who already entered the right password:
-- one row per member and channel, valid only while its password_version equals
-- the channel's current one. A row is never permission to join by itself, the
-- role rules still decide that first. Both parents cascade, so deleting a
-- channel or a user removes the rows.
ALTER TABLE channels ADD COLUMN password_hash TEXT;
ALTER TABLE channels ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS channel_password_grants (
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_version INTEGER NOT NULL,
    granted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (channel_id, user_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_channel_password_grants_user ON channel_password_grants(user_id);
