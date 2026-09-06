-- B5-7 draft: per-user, per-channel NSFW acknowledgement (BPR-063, BG-18's
-- server half, plan decision 13).
--
-- One row per user per channel. Its existence is the gate: every content
-- path a labelled channel can be read through -- message history and
-- around/pins, full-text search, live socket delivery and replay, and
-- attachment bytes -- returns nothing fetchable until the row exists
-- (decision 13 names all four paths -- a gate on channel reads alone is an
-- incomplete implementation).
--
-- A new device inherits the acknowledgement, because the row is
-- server-side and keyed by (user_id, channel_id), not by session or device.
-- Revocation is the user's lever: it deletes the row, and the next read
-- picks that up -- there is no session-scoped cache to invalidate, and no
-- "next session" delay.
--
-- Clearing a channel's nsfw flag deletes that channel's acknowledgement
-- rows in the SAME transaction as the flag change, so a later re-label
-- re-prompts every member rather than silently trusting acknowledgements
-- made against a different warning. (This half is application logic in
-- service/channel_admin.go, not schema -- noted here because it is a
-- consequence of this table's shape.)
--
-- Never expired by a sweep: this is a consent record, not a cache, and S4's
-- lifecycle table is explicit that a re-prompt the user did not ask for is
-- the same annoyance the row exists to remove.
--
-- Erasure: the user half needs an entry in erasureStatements
-- (Server/db/erasure.go) and db.SubjectInventory (Server/db/inventory.go).
-- The channel half needs none -- ON DELETE CASCADE on channel_id means a
-- deleted channel takes its acknowledgement rows with it for free, the same
-- shape channel_retention (migration 039) already uses for its own
-- channel_id column.
CREATE TABLE IF NOT EXISTS nsfw_acknowledgements (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    acknowledged_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id)
);
