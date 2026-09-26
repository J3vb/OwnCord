-- B4-10 draft: anti-resurrection markers (BPR-053).
-- A backup taken before an erasure holds the subject in full (O1 A5, drill
-- D2). The marker is what a restore replays: for every marker, the restored
-- database is erased again before it serves. Markers therefore live in
-- their own file (data/erasure/markers.sqlite), never in the database a
-- restore overwrites; this schema is that file's, applied by the server on
-- open exactly like the main migrations.
--
-- Unlinkable: subject_token = HMAC-SHA256(marker_key, user_id) with a key
-- generated once beside the TOTP key. Without the key a marker names no
-- one; with it the server can recognise a resurrected row (users.id) and
-- re-run the erasure. The token is what audit rows keep (audit_unlinking).
CREATE TABLE deletion_markers (
    subject_token TEXT    PRIMARY KEY,
    -- account: the subject's account was erased (B4-9)
    -- messages: retention removed messages (B4-11) — kept so a restore does
    -- not resurrect content the policy already deleted, keyed by channel
    scope         TEXT    NOT NULL CHECK (scope IN ('account', 'messages')),
    channel_id    INTEGER,
    -- for scope = messages: nothing older than this survives a restore
    cutoff        TEXT,
    erased_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    -- bumped every time a restore replayed this marker
    replays       INTEGER NOT NULL DEFAULT 0,
    last_replay   TEXT
);
