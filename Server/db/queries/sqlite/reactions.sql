-- name: AddReaction :exec
INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?);

-- name: RemoveReaction :execresult
DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?;

-- name: GetReactionCounts :many
SELECT emoji, COUNT(*) AS count
FROM reactions WHERE message_id = ?
GROUP BY emoji;

-- name: GetReactionUsers :many
-- Reactors for one (message, emoji) pair, oldest reaction first. The reactions
-- table has no timestamp column, so the autoincrement id carries the order.
SELECT u.id, u.username, COALESCE(u.avatar, '') AS avatar
FROM reactions r
JOIN users u ON u.id = r.user_id
WHERE r.message_id = ? AND r.emoji = ?
ORDER BY r.id
LIMIT ?;
