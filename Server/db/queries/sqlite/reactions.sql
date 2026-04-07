-- name: AddReaction :exec
INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?);

-- name: RemoveReaction :execresult
DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?;

-- name: GetReactionCounts :many
SELECT emoji, COUNT(*) AS count
FROM reactions WHERE message_id = ?
GROUP BY emoji;
