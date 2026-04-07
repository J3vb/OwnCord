-- name: UpsertLockout :exec
INSERT OR REPLACE INTO rate_lockouts (key, expires_at) VALUES (?, ?);

-- name: LoadActiveLockouts :many
SELECT key, expires_at FROM rate_lockouts WHERE expires_at > ?;

-- name: CleanupExpiredLockouts :exec
DELETE FROM rate_lockouts WHERE expires_at <= ?;

-- name: DeleteLockout :exec
DELETE FROM rate_lockouts WHERE key = ?;
