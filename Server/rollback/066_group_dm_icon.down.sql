-- Rollback of migration 066: drop the group DM icon.
--
-- Cost: every group DM forgets its icon. The icon files stay in the attachments
-- table as unlinked rows that the orphan sweep reclaims. The group icon rows
-- (messages.kind 6) are deleted with what they name, because an older binary
-- has no notion of that kind and would show them as plain messages. The
-- messages_ad trigger drops each row from the FTS index. The other group event
-- rows (kind 2 to 5) are untouched.
DROP INDEX IF EXISTS idx_channels_dm_icon;

DELETE FROM messages WHERE kind = 6;

ALTER TABLE channels DROP COLUMN dm_icon;

DELETE FROM schema_versions WHERE version = '066_group_dm_icon.sql';
