-- Phase B Step 7: Event persistence layer.
-- Stores broadcast events for cold-replay during reconnection when the
-- in-memory ring buffer no longer covers the client's last_seq. Pruned by a
-- background goroutine after the configured retention window (default 24h).
CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT    NOT NULL,
    payload    BLOB    NOT NULL,
    channel_id INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_channel_seq ON events(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
