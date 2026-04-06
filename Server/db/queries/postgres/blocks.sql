-- PostgreSQL variants of the sqlite user block queries.
-- `INSERT OR IGNORE` becomes `INSERT ... ON CONFLICT DO NOTHING`.

-- name: BlockUser :exec
INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

-- name: UnblockUser :exec
DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2;

-- name: IsBlocked :one
SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1;

-- name: IsEitherBlocked :one
SELECT 1 FROM user_blocks
WHERE (blocker_id = $1 AND blocked_id = $2)
   OR (blocker_id = $3 AND blocked_id = $4)
LIMIT 1;
