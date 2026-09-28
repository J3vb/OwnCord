-- Rollback of the audit action index (054).
--
-- The index is additive: dropping it only costs the Dashboard's action
-- filter its covering index, and no read depends on it existing.
DROP INDEX IF EXISTS idx_audit_log_action;

DELETE FROM schema_versions WHERE version = '054_audit_action_index.sql';
