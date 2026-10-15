-- Rollback of migration 060.
--
-- Cost: every reply ping is forgotten. The replied-to author's row stays in
-- message_mentions as an ordinary mention (highlight and badge reversal keep
-- working), but an edit would now replace it with the content-derived set.
ALTER TABLE message_mentions DROP COLUMN reply_ping;

DELETE FROM schema_versions WHERE version = '060_message_mentions_reply_ping.sql';
