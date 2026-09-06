-- Rollback of the B5-9 moderator-action ledger migration (049).
--
-- Run this BEFORE 048's reversal (048 has no foreign key pointing at this
-- table, so ordering against 048 costs nothing either way) and, when B5-10's
-- migration 050 exists, run 050's reversal FIRST -- appeals.action_id
-- references this table, and dropping moderation_actions first would leave
-- 050's own rollback nothing to point its foreign key at if it were ever
-- re-run. No 050 exists in this tree yet, so this file sits at the front of
-- Order for now.
--
-- Cost: every warning, timeout, and the ledger rows ban/kick/removal added
-- to their existing mechanisms are gone. Active timeouts stop being
-- enforced the moment this table is gone, because there is nowhere left to
-- read expires_at from. Unacknowledged warnings are lost outright. Bans
-- stay in effect regardless, because BanUser's ban state lives on the users
-- table, not here -- this table only ever held the ban's ledger entry,
-- never the ban itself. Kicked sessions stay revoked for the same reason.
--
-- voice_states.server_muted_by (round 4, Codex review Part A) is dropped
-- FIRST, before the table it references: any live SFU mute ownership
-- pointer goes with it, same cost as everything else this reversal already
-- accepts for a timeout's voice half.
ALTER TABLE voice_states DROP COLUMN server_muted_by;
DROP INDEX IF EXISTS idx_moderation_actions_report;
DROP INDEX IF EXISTS idx_moderation_actions_timeouts;
DROP INDEX IF EXISTS idx_moderation_actions_target;
DROP TABLE IF EXISTS moderation_actions;

DELETE FROM schema_versions WHERE version = '049_moderation_actions.sql';
