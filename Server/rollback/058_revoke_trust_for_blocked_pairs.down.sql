-- Rollback of the blocked-pair trust cleanup (058). data-only: no schema.
--
-- The migration only deleted rows, so there is no schema to undo and the trust
-- it removed cannot be restored. Anyone who is unblocked after this reversal has
-- to be trusted again by hand, or by accepting their next message request.
DELETE FROM schema_versions WHERE version = '058_revoke_trust_for_blocked_pairs.sql';
