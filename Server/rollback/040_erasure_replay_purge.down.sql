-- Rollback of 040. Dropping replay_purged loses the record of which erasure
-- jobs had their replay frames taken out of the pipeline. A job read after
-- this rollback counts as purged, which is the pre-040 assumption: the event
-- pruner bounds what a missed purge could still be holding.
--
-- The index goes too, so the erasure's reply-to cascade is back to scanning
-- the messages table per deleted row. That is slow, not wrong.
DROP INDEX IF EXISTS idx_messages_reply_to;
ALTER TABLE erasure_jobs DROP COLUMN replay_purged;
DELETE FROM schema_versions WHERE version = '040_erasure_replay_purge.sql';
