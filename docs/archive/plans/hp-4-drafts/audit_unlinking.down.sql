-- Rollback of the B4-10 audit draft. SQLite 3.35+ (modernc.org/sqlite
-- carries it) drops the column in place; the unlinked rows stay unlinked —
-- the ids they lost were the point and are not recoverable.
DROP INDEX IF EXISTS idx_audit_log_subject_token;
ALTER TABLE audit_log DROP COLUMN subject_token;
