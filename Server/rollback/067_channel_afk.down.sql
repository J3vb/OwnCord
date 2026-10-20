-- Rollback of migration 067: drop the AFK channel flag.
--
-- Cost: the server forgets which voice channel was its AFK channel. Nothing
-- else is lost, and the afk_timeout_seconds setting row stays (an older binary
-- ignores it). An older binary has no AFK channel, so it sends no flag and
-- applies no listen-only rule: members in that channel can speak again.
DROP INDEX IF EXISTS idx_channels_afk;

ALTER TABLE channels DROP COLUMN afk;

DELETE FROM schema_versions WHERE version = '067_channel_afk.sql';
