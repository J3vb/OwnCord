-- Rollback of the retention finished-sweep record (091).
--
-- The table only tells the start-up marker replay that a database already
-- finished the sweep a channel's marker names. Dropping it loses nothing a
-- message depends on: the older server has no such record and replays every
-- marker. The marker file keeps its sweep_id column, which that server ignores.
DROP TABLE IF EXISTS channel_retention_swept;

DELETE FROM schema_versions WHERE version = '091_channel_retention_swept.sql';
