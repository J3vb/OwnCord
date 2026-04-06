-- PostgreSQL variants of the sqlite rate-lockout queries.
-- `INSERT OR REPLACE` becomes `INSERT ... ON CONFLICT (key) DO UPDATE`.

-- name: UpsertLockout :exec
INSERT INTO rate_lockouts (key, expires_at) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at;

-- name: LoadActiveLockouts :many
SELECT key, expires_at FROM rate_lockouts WHERE expires_at > $1;

-- name: CleanupExpiredLockouts :exec
DELETE FROM rate_lockouts WHERE expires_at <= $1;

-- name: DeleteLockout :exec
DELETE FROM rate_lockouts WHERE key = $1;
