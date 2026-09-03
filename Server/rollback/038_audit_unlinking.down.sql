-- Rollback of 038, from the audit_unlinking draft's own down file with the
-- schema_versions delete added. SQLite 3.35+ (modernc.org/sqlite carries it)
-- drops the column in place, and the partial index has to go first because
-- SQLite refuses to drop a column an index names. The unlinked rows stay
-- unlinked: the ids they lost were the point and are not recoverable.
DROP INDEX IF EXISTS idx_audit_log_subject_token;
ALTER TABLE audit_log DROP COLUMN subject_token;
DELETE FROM schema_versions WHERE version = '038_audit_unlinking.sql';
