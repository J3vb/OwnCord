-- Migration 092: indexes for the lookups SQLite runs when a message or a
-- channel is deleted.

-- Deleting a message row nulls every column that points at it with ON DELETE
-- SET NULL. Without an index on the pointing column SQLite reads the whole
-- table for each deleted message, so retention sweeps, erasure and channel,
-- thread and group DM deletes grew slower with every channel row. Partial,
-- like idx_channels_thread_starter in 074, because most rows hold NULL.
CREATE INDEX IF NOT EXISTS idx_channels_thread_post_message
    ON channels(thread_post_message_id) WHERE thread_post_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_requests_first_message
    ON message_requests(first_message_id) WHERE first_message_id IS NOT NULL;

-- Deleting a channel row removes or nulls its rows in these tables. None had
-- an index led by channel_id (read_states, dm_open_state and
-- nsfw_acknowledgements are keyed by user first, and the message_calls index
-- covers open calls only), so each channel delete read them in full.
CREATE INDEX IF NOT EXISTS idx_read_states_channel ON read_states(channel_id);
CREATE INDEX IF NOT EXISTS idx_dm_open_state_channel ON dm_open_state(channel_id);
CREATE INDEX IF NOT EXISTS idx_nsfw_acknowledgements_channel ON nsfw_acknowledgements(channel_id);
CREATE INDEX IF NOT EXISTS idx_message_requests_channel ON message_requests(channel_id);
CREATE INDEX IF NOT EXISTS idx_message_calls_channel ON message_calls(channel_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_channel
    ON import_jobs(channel_id) WHERE channel_id IS NOT NULL;
