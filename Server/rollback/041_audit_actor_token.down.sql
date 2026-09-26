-- Rollback of 041. The partial index goes first, because SQLite refuses to
-- drop a column an index names.
--
-- Run the 042 rollback before this one. It moves the actor tokens back into
-- subject_token, where migration 038 kept them, and this rollback discards
-- whatever is still in actor_token when it drops the column.
DROP INDEX IF EXISTS idx_audit_log_actor_token;
ALTER TABLE audit_log DROP COLUMN actor_token;
DELETE FROM schema_versions WHERE version = '041_audit_actor_token.sql';
