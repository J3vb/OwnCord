-- Rollback of migration 081 (data-only): nothing to restore.
--
-- Cost: none. The migration cleared bit 14 (MANAGE_BACKUPS) on every role except
-- the owner. An older binary ignores that bit, and the bit was unused before
-- 081, so the earlier value carried no meaning. Roles that were given
-- MANAGE_BACKUPS by hand after 081 keep the bit, which the older binary ignores.
-- Re-applying 081 clears it again on every role except the owner.
DELETE FROM schema_versions WHERE version = '081_manage_backups.sql';
