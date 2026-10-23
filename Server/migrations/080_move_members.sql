-- WP 8.4a: the MOVE_MEMBERS permission bit (13, 0x2000 = 8192) lets a member
-- move anyone between voice channels, whatever their rank. Until now
-- MUTE_MEMBERS (20, 0x100000 = 1048576) gated mute, deafen, move and
-- disconnect together. Data only: the bit is a value in roles.permissions.
--
-- Default Moderator, scoped like 048 and 078: only the UNTOUCHED default row
-- (id 3, name 'Moderator', 0xEFFFFF = 15728639 after 078) gains MUTE_MEMBERS.
-- The original seed mask 0x000FFFFF stops at bit 19, so the default Moderator
-- never held it although docs/schema.md describes it as "all voice +
-- moderation". It becomes 0xFFFFFF (16777215). A Moderator that was renamed or
-- edited gets nothing here and is granted the bits by hand in the role grid.
UPDATE roles SET permissions = permissions | 1048576
 WHERE id = 3 AND name = 'Moderator' AND permissions = 15728639;

-- Move Members: the seeded Admin (0x3FFFFFFF) and Moderator masks already
-- carry bit 13 as an unused bit, so it is set on purpose here rather than
-- left to chance. For every role except the owner (id 1, or a position of 100
-- or more), clear it, then set it again on each role that holds MUTE_MEMBERS.
-- Net effect: everyone who could move before can still move, and no other
-- role holds the bit. The owner role is not touched.
UPDATE roles SET permissions = permissions & ~8192
 WHERE id != 1 AND position < 100;

UPDATE roles SET permissions = permissions | 8192
 WHERE id != 1 AND position < 100 AND (permissions & 1048576) = 1048576;
