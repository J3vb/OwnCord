-- Rollback of migration 064: drop the DM call log.
--
-- Cost: every call log row (messages.kind = 1) is deleted, with its call times
-- and participant list. Ordinary messages are untouched. The call rows go
-- first because an older binary has no notion of kind and would show them as
-- plain messages. The messages_ad trigger drops each row from the FTS index.
DROP INDEX IF EXISTS idx_message_call_participants_user;

DROP TABLE IF EXISTS message_call_participants;

DROP INDEX IF EXISTS idx_message_calls_open;

DROP TABLE IF EXISTS message_calls;

DELETE FROM messages WHERE kind = 1;

ALTER TABLE messages DROP COLUMN kind;

DELETE FROM schema_versions WHERE version = '064_call_log.sql';
