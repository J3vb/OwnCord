-- Rollback of 042. The backfill moved an erased actor's token out of
-- subject_token, where migration 038 had put it, into the actor_token column
-- 041 added. Moving them back restores the pre-042 representation, so that
-- rolling 041 back afterwards does not drop the column with the only copy of
-- those tokens in it.
--
-- Two kinds of row do not return to exactly what 042 found, both for the
-- reason 041 exists. A row whose target is also an erased subject now holds
-- a token on each side, and the pre-041 schema has one column: the target's
-- is kept and the actor's is forfeited. A row unlinked after 041 landed
-- never had its actor token in subject_token at all, and lands there now --
-- which is where migration 038 would have put it.
UPDATE audit_log SET subject_token = actor_token
 WHERE actor_token IS NOT NULL AND subject_token IS NULL;
DELETE FROM schema_versions WHERE version = '042_audit_actor_token_backfill.sql';
