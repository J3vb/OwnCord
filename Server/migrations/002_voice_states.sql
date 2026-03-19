-- Phase 5: Voice state tracking table.
-- Stores which voice channel each user is currently connected to,
-- along with their mute/deafen/speaking state.
CREATE TABLE IF NOT EXISTS voice_states (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted      INTEGER NOT NULL DEFAULT 0,
    deafened   INTEGER NOT NULL DEFAULT 0,
    speaking   INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);
