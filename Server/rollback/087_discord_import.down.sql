-- Rollback of migration 087: remove the Discord import tables and the pending flag.
--
-- Cost: every import job record and every imported message's Discord author name
-- is lost. Imported messages and channels stay, owned by the hidden import
-- account, which keeps its registration_status of 'system' (an older binary
-- already lists only 'active' members, so the account stays out of sight).
--
-- A channel still being built (import_pending = 1) is deleted, since an older
-- binary would show it half finished.
DELETE FROM channels WHERE import_pending = 1;
DROP INDEX IF EXISTS idx_users_system_account;
DROP TABLE IF EXISTS message_import_authors;
DROP INDEX IF EXISTS idx_import_jobs_one_running;
DROP TABLE IF EXISTS import_jobs;
ALTER TABLE channels DROP COLUMN import_pending;

DELETE FROM schema_versions WHERE version = '087_discord_import.sql';
