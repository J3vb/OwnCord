-- Call log rows in DMs. A call is one messages row with kind = 1, written and
-- updated only by the server. kind 0 is an ordinary user message, so every
-- existing row keeps its meaning through the DEFAULT.
--
-- message_calls holds the call's times. started_at and last_seen_at use the
-- messages.timestamp layout (UTC, "2006-01-02 15:04:05"). ended_at is NULL while
-- the call is live, and last_seen_at is the end time to use after a crash.
-- The partial unique index means a channel can never have two live calls.
--
-- message_call_participants lists the users who were present at any point.
-- Whether a viewer missed the call is worked out from it per viewer, so there
-- are no per-user rows. All three tables cascade with the message, the channel
-- or the user.
ALTER TABLE messages ADD COLUMN kind INTEGER NOT NULL DEFAULT 0;

CREATE TABLE message_calls (
    message_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    last_seen_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_message_calls_open ON message_calls(channel_id) WHERE ended_at IS NULL;

CREATE TABLE message_call_participants (
    message_id INTEGER NOT NULL REFERENCES message_calls(message_id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_message_call_participants_user ON message_call_participants(user_id);
