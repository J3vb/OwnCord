-- Migration 093: a push subscription belongs to the session that made it.
--
-- A row written by a signed-in session names that session, and goes with it:
-- signing out, "sign out everywhere", an expired session, a ban and an admin
-- revoke all delete the session row, and with it the pushes to that device.
-- Before this, a signed-out phone kept receiving pushes until the 90-day
-- staleness sweep. Re-subscribing the same endpoint from a new session moves
-- the row to that session (UpsertPushSubscription). Rows written before this
-- migration, or by an API token, have no session and keep the old lifetime.
ALTER TABLE push_subscriptions
    ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE;

-- The cascade looks rows up by session on every session delete.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session
    ON push_subscriptions(session_id) WHERE session_id IS NOT NULL;
