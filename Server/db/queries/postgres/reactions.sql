-- PostgreSQL variants of the sqlite reactions queries.

-- name: AddReaction :exec
INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3);

-- name: RemoveReaction :execrows
DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3;

-- name: GetReactionCounts :many
SELECT emoji, COUNT(*) AS count
FROM reactions WHERE message_id = $1
GROUP BY emoji;
