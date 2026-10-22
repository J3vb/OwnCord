-- name: GetMessageGroupEventsByMessageIDs :many
-- The group_event block of group DM rows (messages.kind 2 to 6), for history.
SELECT message_id, target_user_id, name, icon_removed
FROM message_group_events
WHERE message_id IN (sqlc.slice('ids'));

-- name: InsertGroupEventMessage :one
-- A group DM row is a messages row with kind 2 to 6. The author is the actor:
-- the member who added, removed, renamed or left. The caller passes the
-- fallback text that only old clients show.
INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, ?, ?)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone, pinned_at, kind;

-- name: InsertMessageGroupEvent :exec
INSERT INTO message_group_events (message_id, target_user_id, name, icon_removed)
VALUES (?, ?, ?, ?);
