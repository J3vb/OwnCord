-- PostgreSQL variants of the sqlite users queries.
-- Differences from sqlite:
--   - `?`                    -> `$1`, `$2`, …
--   - `COLLATE NOCASE`       -> removed; the `username` column is CITEXT.
--   - `datetime('now')`      -> `NOW()`
--   - `banned = 0/1`         -> `banned = FALSE/TRUE` (column is BOOLEAN)
--   - `:execresult INSERT`   -> `:one ... RETURNING id` (pgx has no LastInsertId)

-- name: GetUserByUsername :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires
FROM users WHERE username = $1;

-- name: GetUserByID :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires
FROM users WHERE id = $1;

-- name: CreateUser :one
INSERT INTO users (username, password, role_id)
VALUES ($1, $2, $3)
RETURNING id;

-- name: UpdateUserStatus :exec
UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2;

-- name: UpdateUserTOTPSecret :exec
UPDATE users SET totp_secret = $1 WHERE id = $2;

-- name: ResetAllUserStatuses :exec
UPDATE users SET status = 'offline' WHERE status != 'offline';

-- name: BanUser :exec
UPDATE users SET banned = TRUE, ban_reason = $1, ban_expires = $2 WHERE id = $3;

-- name: UnbanUser :exec
UPDATE users SET banned = FALSE, ban_reason = NULL, ban_expires = NULL WHERE id = $1;

-- name: ListMembers :many
SELECT u.id, u.username, u.avatar, u.status, LOWER(r.name)
FROM users u
JOIN roles r ON u.role_id = r.id
WHERE u.banned = FALSE
ORDER BY u.username ASC
LIMIT 1000;

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- name: CountUsersWithoutTOTP :one
SELECT COUNT(*) FROM users WHERE banned = FALSE AND totp_secret IS NULL;
