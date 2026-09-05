-- B5-4 (BG-05 storage half, plan decision 9): Web Push subscriptions, one
-- row per (user, endpoint). Nothing dispatches to them yet (that is B5-11,
-- behind HP-5). endpoint + auth + p256dh are a push credential, so rows are
-- written only for the authenticated principal, listed only to them without
-- the credential fields, and deleted on revoke, on the staleness sweep, on
-- VAPID key rotation (vapid_key_id no longer matches the running key) and
-- on B4-9 erasure (erasureStatements, class 2a in db.SubjectInventory).
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT    NOT NULL,
    p256dh       TEXT    NOT NULL,
    auth         TEXT    NOT NULL,
    device_name  TEXT    NOT NULL DEFAULT '',
    vapid_key_id TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_last_seen ON push_subscriptions(last_seen_at);
