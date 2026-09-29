-- Rollback of invite redemption tracking (055).
--
-- The table is additive: dropping it loses the redemption history only. The
-- invite's use_count and the legacy redeemed_by column are untouched, so no
-- invite becomes unusable and no permission depends on this table existing.
DROP INDEX IF EXISTS idx_invite_redemptions_user;
DROP INDEX IF EXISTS idx_invite_redemptions_invite;
DROP TABLE invite_redemptions;

DELETE FROM schema_versions WHERE version = '055_invite_redemptions.sql';
