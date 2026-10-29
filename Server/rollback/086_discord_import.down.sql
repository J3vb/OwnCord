-- Rollback of migration 086: remove the Discord import tables and the pending flag.
--
-- Cost: every import job record and every imported message's Discord author name
-- is lost. Imported messages and channels stay, owned by the hidden import
-- account, which keeps its registration_status of 'system' (an older binary
-- lists it as an ordinary member, so delete the account's messages first if you
-- do not want it shown). A channel still being built (import_pending = 1) is
-- deleted, since an older binary would show it half finished.
DELETE FROM channels WHERE import_pending = 1;
DROP INDEX IF EXISTS idx_users_system_account;
DROP TABLE IF EXISTS message_import_authors;
DROP INDEX IF EXISTS idx_import_jobs_one_running;
DROP TABLE IF EXISTS import_jobs;
ALTER TABLE channels DROP COLUMN import_pending;

DELETE FROM schema_versions WHERE version = '086_discord_import.sql';
