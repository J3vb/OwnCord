-- name: AddReactionCapped :execresult
-- Inserts only when the emoji is already on the message or the message holds
-- fewer than max_distinct distinct emoji. The test and the insert are one
-- statement on the single writer, so two racing first-time emoji cannot both
-- pass at the cap. Zero rows affected means the cap refused it.
INSERT INTO reactions (message_id, user_id, emoji)
SELECT sqlc.arg(message_id), sqlc.arg(user_id), sqlc.arg(emoji)
WHERE EXISTS (SELECT 1 FROM reactions e WHERE e.message_id = sqlc.arg(message_id) AND e.emoji = sqlc.arg(emoji))
   OR (SELECT COUNT(DISTINCT c.emoji) FROM reactions c WHERE c.message_id = sqlc.arg(message_id)) < CAST(sqlc.arg(max_distinct) AS INTEGER);

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
