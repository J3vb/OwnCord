-- name: BlockUser :exec
INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?);

-- name: UnblockUser :exec
DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?;

-- name: IsBlocked :one
SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ? LIMIT 1;

-- name: IsEitherBlocked :one
SELECT 1 FROM user_blocks
WHERE (blocker_id = ? AND blocked_id = ?)
   OR (blocker_id = ? AND blocked_id = ?)
LIMIT 1;

-- name: ListBlockedUsers :many
SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC;

-- name: ListBlockersOfUser :many
SELECT blocker_id FROM user_blocks WHERE blocked_id = ?;
