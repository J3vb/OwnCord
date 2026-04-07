-- PostgreSQL variants of the sqlite admin queries.

-- name: UserCount :one
SELECT COUNT(*) FROM users;

-- name: CountActiveMessages :one
SELECT COUNT(*) FROM messages WHERE deleted = FALSE;

-- name: CountChannels :one
SELECT COUNT(*) FROM channels;

-- name: CountActiveInvites :one
SELECT COUNT(*) FROM invites WHERE revoked = FALSE;

-- name: ListAllUsers :many
SELECT u.id, u.username, u.avatar, u.role_id,
       u.status, u.created_at, u.last_seen, u.banned, u.ban_reason, u.ban_expires,
       COALESCE(r.name, '') AS role_name
FROM users u
LEFT JOIN roles r ON r.id = u.role_id
ORDER BY u.id ASC
LIMIT $1 OFFSET $2;

-- name: UpdateUserRole :exec
UPDATE users SET role_id = $1 WHERE id = $2;

-- name: ForceLogoutUser :exec
DELETE FROM sessions WHERE user_id = $1;

-- name: GetUserSessions :many
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
FROM sessions WHERE user_id = $1
ORDER BY created_at DESC;

-- name: LogAudit :exec
INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
VALUES ($1, $2, $3, $4, $5);

-- name: GetAuditLog :many
SELECT a.id, a.actor_id, COALESCE(u.username, '') AS actor_name, a.action,
       a.target_type, a.target_id, a.detail, a.created_at
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor_id
ORDER BY a.id DESC
LIMIT $1 OFFSET $2;

-- name: GetSetting :one
SELECT value FROM settings WHERE key = $1;

-- name: SetSetting :exec
INSERT INTO settings (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- name: GetAllSettings :many
SELECT key, value FROM settings;
