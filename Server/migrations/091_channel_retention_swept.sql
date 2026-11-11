-- Migration 091: the retention sweep each channel's rows have finished.

-- The start-up marker replay re-applies a channel's recorded cutoff, which
-- exists for a restored older backup that holds messages already swept once.
-- Without a record in the database itself it could not tell that case from a
-- database that already ran every sweep, and it removed a message that was
-- pinned at the sweep and unpinned later. The marker file gives each sweep of a
-- channel a random id and this table holds the id of the last one this database
-- finished. A restored backup carries an older id here, or none, so the replay
-- still runs for it. The first start after the upgrade has no record yet, so it
-- replays once for every channel.
CREATE TABLE channel_retention_swept (
    channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    -- deletion_markers.sweep_id in the marker file when the sweep finished
    sweep      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
