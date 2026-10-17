-- name: GetMessageGroupEventsByMessageIDs :many
-- The group_event block of group DM rows (messages.kind 2 to 6), for history.
SELECT message_id, target_user_id, name, icon_removed
FROM message_group_events
WHERE message_id IN (sqlc.slice('ids'));
