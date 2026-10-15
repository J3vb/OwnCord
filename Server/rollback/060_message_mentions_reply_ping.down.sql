-- Rollback of migration 060.
--
-- Cost: every reply ping is forgotten. The replied-to author's row stays in
-- message_mentions as an ordinary mention, but a later edit drops it, and
-- deleting the message after that edit no longer takes back the badge the ping
-- raised.
ALTER TABLE message_mentions DROP COLUMN reply_ping;

DELETE FROM schema_versions WHERE version = '060_message_mentions_reply_ping.sql';
