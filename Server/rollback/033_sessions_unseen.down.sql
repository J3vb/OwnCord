-- Rollback of 033. The new-login signal goes away with the column: sessions
-- that had not been acknowledged yet lose that fact and read as seen, which
-- is how a pre-033 server treats every session.
ALTER TABLE sessions DROP COLUMN unseen;
DELETE FROM schema_versions WHERE version = '033_sessions_unseen.sql';
