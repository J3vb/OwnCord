-- Group DM icon (WP 3B-10c).
--
-- channels.dm_icon is the attachment id of a group DM's icon, NULL when the
-- group has none (and always NULL for a 1:1 DM). The icon is an ordinary
-- attachment with no message, kept alive and readable by group members while
-- this column names it, the same way a live avatar is. A replaced or cleared
-- icon stops being served and is reclaimed by the orphan sweep. Erasing the
-- user who uploaded it removes the attachment row, and the group then has no
-- icon.
ALTER TABLE channels ADD COLUMN dm_icon TEXT REFERENCES attachments(id) ON DELETE SET NULL;

CREATE INDEX idx_channels_dm_icon ON channels(dm_icon) WHERE dm_icon IS NOT NULL;
