-- Migration 091: the cutoff each channel's retention sweep has reached.

-- The start-up marker replay re-applies a channel's recorded cutoff, which
-- exists for a restored older backup that holds messages already swept once.
-- Without a record in the database itself it could not tell that case from a
-- database that already swept to the cutoff, and it removed a message that was
-- pinned at the sweep and unpinned later. A restored backup carries its own
-- older cutoff here, or none, so the replay still runs for it. The first start
-- after the upgrade has no record yet, so it replays once for every channel.
CREATE TABLE channel_retention_swept (
    channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    -- UTC in the messages.timestamp layout, only ever moved forward
    cutoff     TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
