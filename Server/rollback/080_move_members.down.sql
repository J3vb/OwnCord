-- Rollback of migration 080 (data-only): nothing to restore.
--
-- Cost: none. The migration cleared bit 13 (MOVE_MEMBERS) on every role except
-- the owner. An older binary ignores that bit, and the bit was unused before
-- 080, so the earlier value carried no meaning. Roles that were given
-- MOVE_MEMBERS by hand after 080 keep the bit, which the older binary ignores.
-- Re-applying 080 clears it again on every role except the owner.
DELETE FROM schema_versions WHERE version = '080_move_members.sql';
