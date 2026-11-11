-- Rollback of the retention swept-cutoff record (091).
--
-- The table only tells the start-up marker replay that a database already swept
-- a channel to its recorded cutoff. Dropping it loses nothing a message depends
-- on: the older server has no such record and replays every marker.
DROP TABLE IF EXISTS channel_retention_swept;

DELETE FROM schema_versions WHERE version = '091_channel_retention_swept.sql';
