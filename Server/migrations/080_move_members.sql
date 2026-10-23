-- WP 8.4a: the MOVE_MEMBERS permission bit (13, 0x2000 = 8192) lets a member
-- move anyone between voice channels, whatever their rank. Data only: the bit
-- is a value in roles.permissions.
--
-- Nobody holds it after this migration except the owner. The seeded Admin
-- (0x3FFFFFFF) and Moderator (0xEFFFFF) masks carry bit 13 as an unused bit,
-- left over from before it was a defined permission, and a role that kept it
-- would gain the power to move any member. So for every role except the owner
-- (id 1, or a position of 100 or more) the bit is cleared. The owner grants it
-- by hand in the role grid. MUTE_MEMBERS keeps moving lower-ranked members
-- exactly as before, so nothing anyone could do until now is lost.
UPDATE roles SET permissions = permissions & ~8192
 WHERE id != 1 AND position < 100;
