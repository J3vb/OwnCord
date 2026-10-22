-- Group DM owner and group event rows (WP 3B-10a).
--
-- channels.dm_owner_id names the owner of a group DM. It is NULL for a 1:1 DM
-- and for a group with no members left. The server keeps it pointing at a
-- current member: create sets it, a leave or an erasure hands it to the lowest
-- remaining member id.
--
-- The creator of an existing group was never recorded, so the backfill picks
-- the author of the oldest surviving message who is still a member (most often
-- the creator), or else the lowest member id. It needs no client input.
ALTER TABLE channels ADD COLUMN dm_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

UPDATE channels SET dm_owner_id = COALESCE(
    (SELECT m.user_id FROM messages m
       JOIN dm_participants dp ON dp.channel_id = m.channel_id AND dp.user_id = m.user_id
      WHERE m.channel_id = channels.id
      ORDER BY m.id LIMIT 1),
    (SELECT MIN(user_id) FROM dm_participants WHERE channel_id = channels.id))
 WHERE type = 'dm' AND is_group = 1;

-- Group event rows are messages with kind 2 to 6 (group_add, group_remove,
-- group_leave, group_rename, group_icon). This table holds what a row
-- names. target_user_id is set for add and remove, name for rename (an empty
-- string means the name was removed) and icon_removed for icon. Nothing writes
-- it yet. It cascades with the message and with the targeted user.
CREATE TABLE message_group_events (
    message_id     INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT,
    icon_removed   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_message_group_events_target ON message_group_events(target_user_id) WHERE target_user_id IS NOT NULL;
