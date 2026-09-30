-- Rollback of the pinned_at pin-ordering column (056).
--
-- Additive only: dropping the column loses the pin timestamps, so a pinned
-- panel reverts to message-id order. No message becomes unpinned and no
-- permission depends on the column.
ALTER TABLE messages DROP COLUMN pinned_at;

DELETE FROM schema_versions WHERE version = '056_message_pinned_at.sql';
