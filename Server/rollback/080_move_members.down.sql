-- Rollback of migration 080 (data-only): the Move Members bit is cleared and the
-- default Moderator loses Mute Members.
--
-- Cost: before 080, MUTE_MEMBERS alone gated moving a member in voice, so the
-- bit is cleared on every role except the owner, and roles that hold
-- MUTE_MEMBERS keep their ability to move through it. The untouched Moderator
-- (0xFFFFFF = 16777215) goes back to 15728639 (0xEFFFFF), which cannot mute or
-- move in voice. Bit 13 is cleared on the seeded Admin and Moderator masks as
-- well, which is harmless: an older binary ignores the bit. A Moderator role
-- that was edited after 080 is left alone apart from the cleared bit. Re-applying
-- 080 grants both again to a role that is still untouched.
UPDATE roles SET permissions = permissions & ~1048576
 WHERE id = 3 AND name = 'Moderator' AND permissions = 16777215;

UPDATE roles SET permissions = permissions & ~8192
 WHERE id != 1 AND position < 100;

DELETE FROM schema_versions WHERE version = '080_move_members.sql';
