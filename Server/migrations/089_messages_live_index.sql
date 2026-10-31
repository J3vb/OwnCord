-- Migration 089: an index over live (not deleted) messages per channel.

-- The unread counts run once per channel on every sign-in and reconnect: the
-- newest live message id, and up to 100 live messages after the read marker.
-- idx_messages_channel covers deleted rows too, so each seek also reads the
-- row to check the flag. This partial index answers both from the index alone.
CREATE INDEX IF NOT EXISTS idx_messages_channel_live
    ON messages(channel_id, id) WHERE deleted = 0;
