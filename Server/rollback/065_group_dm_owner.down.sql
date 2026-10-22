-- Rollback of migration 065: drop the group DM owner and the group event rows.
--
-- Cost: every group event row (messages.kind 2 to 6) is deleted with what it
-- names, and every group DM forgets its owner, so the next server version that
-- has an owner picks one again from the lowest member id. Ordinary messages
-- and the call log rows are untouched. The event rows go first because an
-- older binary has no notion of these kinds and would show them as plain
-- messages. The messages_ad trigger drops each row from the FTS index.
DROP INDEX IF EXISTS idx_message_group_events_target;

DROP TABLE IF EXISTS message_group_events;

DELETE FROM messages WHERE kind BETWEEN 2 AND 6;

ALTER TABLE channels DROP COLUMN dm_owner_id;

DELETE FROM schema_versions WHERE version = '065_group_dm_owner.sql';
