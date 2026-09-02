-- name: InsertSession :execresult
INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
VALUES (?, ?, ?, ?, ?);

-- name: EvictOldestSessions :exec
DELETE FROM sessions WHERE id IN (
    SELECT s2.id FROM sessions AS s2 WHERE s2.user_id = ?
    ORDER BY s2.created_at DESC
    LIMIT -1 OFFSET ?
);

-- name: GetSessionByTokenHash :one
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
FROM sessions WHERE token = ?;

-- name: GetSessionWithBanStatus :one
SELECT s.id, s.user_id, s.token, s.device, s.ip_address,
       s.created_at, s.last_used, s.expires_at,
       u.banned, u.ban_reason, u.ban_expires
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.token = ?;

-- name: DeleteSessionByToken :exec
DELETE FROM sessions WHERE token = ?;

-- name: DeleteSessionByID :execresult
DELETE FROM sessions WHERE id = ? AND user_id = ?;

-- name: DeleteOtherSessions :execresult
DELETE FROM sessions WHERE user_id = ? AND id != ?;

-- name: DeleteUserSessions :execresult
DELETE FROM sessions WHERE user_id = ?;

-- name: DeleteExpiredSessions :exec
-- Sargable text comparison against idx_sessions_expires_at (migration 031).
-- expires_at is stored as RFC3339 UTC ("2006-01-02T15:04:05Z") and the
-- migration normalized legacy rows, so the caller must pass the cutoff in
-- exactly that layout -- a space-separated cutoff would compare wrong.
DELETE FROM sessions WHERE expires_at < ?;

-- name: TouchSession :exec
UPDATE sessions SET last_used = datetime('now') WHERE token = ?;

-- name: ListUserSessions :many
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
FROM sessions
WHERE user_id = ?
ORDER BY created_at DESC;
