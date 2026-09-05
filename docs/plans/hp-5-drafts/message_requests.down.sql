-- Rollback of the B5-6 message-requests draft (migration 046).
--
-- Cost: every pending request and every ignored/deleted decision the
-- recipient made is lost -- there is no record left of who was ever held at
-- the door, or who was told no. Accepted pairs survive a round trip only
-- because they are indistinguishable from any other live one-to-one DM: if
-- 046 is re-applied later, its grandfathering backfill re-derives
-- 'grandfathered' trust for every one-to-one DM pair that still has
-- messages, including ones that were originally 'accepted' -- the source
-- column's finer distinction (accepted vs. sent_first vs. grandfathered) is
-- not recoverable, only the fact of trust is.
DROP INDEX IF EXISTS idx_message_requests_recipient_state;
DROP TABLE IF EXISTS message_requests;
DROP TABLE IF EXISTS trusted_senders;

DELETE FROM schema_versions WHERE version = '046_message_requests.sql';
