-- Rollback of migration 078 (data-only): the default Moderator loses the Manage Nicknames bit.
--
-- Cost: an untouched Moderator role goes back to 7340031 (0x6FFFFF), so
-- moderators can no longer change a member's nickname once an older binary runs
-- (it has no such route anyway). Nicknames already changed stay as they are, and
-- so do the audit rows. A Moderator role that was edited after 078 is left alone,
-- as is the Admin mask, which always held the bit. Re-applying 078 grants it
-- again to a role that is still untouched.
UPDATE roles SET permissions = permissions & ~8388608
 WHERE id = 3 AND name = 'Moderator' AND permissions = 15728639;

DELETE FROM schema_versions WHERE version = '078_manage_nicknames.sql';
