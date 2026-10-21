-- Rollback of migration 070: drop the per-user direct message privacy store.
--
-- Cost: every saved privacy choice is lost, so each member is back to both
-- settings on. Nothing else reads the table in this release.
DROP TABLE IF EXISTS user_privacy;

DELETE FROM schema_versions WHERE version = '070_user_privacy.sql';
