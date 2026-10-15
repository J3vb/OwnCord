-- Rollback of migration 062: drop the custom-status expiry index and column.
--
-- Cost: every pending custom-status expiry is forgotten. A status that was
-- set to clear itself stays until its owner changes it.
DROP INDEX IF EXISTS idx_users_custom_status_expires_at;

ALTER TABLE users DROP COLUMN custom_status_expires_at;

DELETE FROM schema_versions WHERE version = '062_custom_status_expiry.sql';
