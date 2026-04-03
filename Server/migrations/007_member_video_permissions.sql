-- Migration 006: Add video and screenshare permissions to Member role
-- Member was missing USE_VIDEO (0x800) and SHARE_SCREEN (0x1000).
-- New value: 0x1E63 = SEND_MESSAGES | READ_MESSAGES | ATTACH_FILES |
--                      ADD_REACTIONS | CONNECT_VOICE | SPEAK_VOICE |
--                      USE_VIDEO | SHARE_SCREEN
UPDATE roles SET permissions = 7779 WHERE id = 4 AND name = 'Member';
