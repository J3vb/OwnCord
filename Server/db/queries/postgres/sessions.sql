-- PostgreSQL variants of the sqlite sessions queries.

-- name: InsertSession :one
INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;

-- Delete all but the N most recent sessions for a user. Postgres replaces
-- sqlite's `LIMIT -1 OFFSET ?` with `OFFSET $2`.
-- name: EvictOldestSessions :exec
DELETE FROM sessions WHERE id IN (
    SELECT s2.id FROM sessions AS s2 WHERE s2.user_id = $1
    ORDER BY s2.created_at DESC
    OFFSET $2
);

-- name: GetSessionByTokenHash :one
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
FROM sessions WHERE token = $1;

-- name: GetSessionWithBanStatus :one
SELECT s.id, s.user_id, s.token, s.device, s.ip_address,
       s.created_at, s.last_used, s.expires_at,
       u.banned, u.ban_reason, u.ban_expires
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.token = $1;

-- name: DeleteSessionByToken :exec
DELETE FROM sessions WHERE token = $1;

-- name: DeleteSessionByID :exec
DELETE FROM sessions WHERE id = $1 AND user_id = $2;

-- name: DeleteOtherSessions :execrows
DELETE FROM sessions WHERE user_id = $1 AND id != $2;

-- Use native timestamp comparison instead of sqlite's strftime trick.
-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at < NOW();

-- name: TouchSession :exec
UPDATE sessions SET last_used = NOW() WHERE token = $1;

-- name: ListUserSessions :many
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
FROM sessions
WHERE user_id = $1
ORDER BY created_at DESC;
