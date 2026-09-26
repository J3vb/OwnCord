-- Rollback of the B5-9 moderation-actions draft (migration 049).
--
-- Run 050's rollback (appeals) FIRST -- appeals.action_id references this
-- table, and dropping moderation_actions first would leave 050's own
-- rollback nothing to point its foreign key at if it were ever re-run.
--
-- Cost: every appeal's anchor disappears, so any surviving appeal row
-- becomes unexplainable. Active timeouts stop being enforced the moment
-- this table is gone, because there is nowhere left to read expires_at
-- from. Unacknowledged warnings are lost outright. Bans stay in effect
-- regardless, because BanUser's ban state lives on the users table, not
-- here -- this table only ever held the ban's ledger entry, never the ban
-- itself.
DROP INDEX IF EXISTS idx_moderation_actions_timeouts;
DROP INDEX IF EXISTS idx_moderation_actions_target;
DROP TABLE IF EXISTS moderation_actions;

DELETE FROM schema_versions WHERE version = '049_moderation_actions.sql';
