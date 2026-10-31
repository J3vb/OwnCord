-- Rollback of the live-message index (089).
--
-- The index is additive: dropping it only makes the unread counts read each
-- message row again, and no read depends on it existing.
DROP INDEX IF EXISTS idx_messages_channel_live;

DELETE FROM schema_versions WHERE version = '089_messages_live_index.sql';
