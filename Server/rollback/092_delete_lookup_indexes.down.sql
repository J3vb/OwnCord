-- Rollback of the delete lookup indexes (092).
--
-- The indexes are additive: dropping them only makes message and channel
-- deletes read the pointing tables in full again, and no read depends on them
-- existing.
DROP INDEX IF EXISTS idx_channels_thread_post_message;
DROP INDEX IF EXISTS idx_message_requests_first_message;
DROP INDEX IF EXISTS idx_read_states_channel;
DROP INDEX IF EXISTS idx_dm_open_state_channel;
DROP INDEX IF EXISTS idx_nsfw_acknowledgements_channel;
DROP INDEX IF EXISTS idx_message_requests_channel;
DROP INDEX IF EXISTS idx_message_calls_channel;
DROP INDEX IF EXISTS idx_import_jobs_channel;

DELETE FROM schema_versions WHERE version = '092_delete_lookup_indexes.sql';
