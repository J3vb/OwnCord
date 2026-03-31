-- Migration 004: Fix Member role permissions
-- The Member role was missing READ_MESSAGES (0x2), ATTACH_FILES (0x20),
-- and ADD_REACTIONS (0x40) bits. Also had MUTE_MEMBERS which is mod-level.
-- New value: 0x663 = SEND_MESSAGES | READ_MESSAGES | ATTACH_FILES |
--                     ADD_REACTIONS | CONNECT_VOICE | SPEAK_VOICE
UPDATE roles SET permissions = 1635 WHERE id = 4 AND name = 'Member';
