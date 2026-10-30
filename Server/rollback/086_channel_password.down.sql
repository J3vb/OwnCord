-- Rollback of migration 086: every channel password and every grant is
-- forgotten.
--
-- Cost: voice channels that had a password become open to anyone who may join
-- them by role. Channels, members and permissions are untouched. After a
-- re-apply no channel has a password.
DROP INDEX IF EXISTS idx_channel_password_grants_user;

DROP TABLE IF EXISTS channel_password_grants;

ALTER TABLE channels DROP COLUMN password_version;
ALTER TABLE channels DROP COLUMN password_hash;

DELETE FROM schema_versions WHERE version = '086_channel_password.sql';
