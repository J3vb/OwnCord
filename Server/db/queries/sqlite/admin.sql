-- name: UserCount :one
SELECT COUNT(*) FROM users;

-- name: CountActiveMessages :one
SELECT COUNT(*) FROM messages WHERE deleted = 0;

-- name: CountChannels :one
SELECT COUNT(*) FROM channels;

-- name: CountActiveInvites :one
SELECT COUNT(*) FROM invites WHERE revoked = 0;

-- name: ListAllUsers :many
-- The admin Members page. query is a case-insensitive username substring
-- (instr, so no wildcard escaping; empty matches everyone). role_id 0 means any
-- role. banned_only 1 keeps only effective bans: the negation of
-- db.notBannedClause, so a lapsed temporary ban is not listed as banned.
SELECT u.id, u.username, u.avatar, u.role_id,
       u.status, u.created_at, u.last_seen, u.banned, u.ban_reason, u.ban_expires,
       COALESCE(r.name, '') AS role_name, COALESCE(r.position, 0) AS role_position
FROM users u
LEFT JOIN roles r ON r.id = u.role_id
WHERE u.registration_status = 'active'
  AND instr(lower(u.username), lower(sqlc.arg(query))) > 0
  AND (CAST(sqlc.arg(role_id) AS INTEGER) = 0 OR u.role_id = sqlc.arg(role_id))
  AND (CAST(sqlc.arg(banned_only) AS INTEGER) = 0
       OR (u.banned != 0 AND (u.ban_expires IS NULL
           OR replace(u.ban_expires, ' ', 'T') > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))))
ORDER BY u.id ASC
LIMIT sqlc.arg(limit) OFFSET sqlc.arg(offset);

-- name: UpdateUserRole :exec
UPDATE users SET role_id = ? WHERE id = ?;

-- name: ForceLogoutUser :exec
DELETE FROM sessions WHERE user_id = ?;

-- name: GetUserSessions :many
SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at, unseen
FROM sessions WHERE user_id = ?
ORDER BY created_at DESC;

-- name: LogAudit :exec
INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
VALUES (?, ?, ?, ?, ?);

-- name: LogAuditEntry :exec
INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, subject_token, actor_token)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetAuditLog :many
SELECT a.id, a.actor_id, COALESCE(u.username, '') AS actor_name, a.action,
       a.target_type, a.target_id, a.detail, COALESCE(a.subject_token, '') AS subject_token,
       COALESCE(a.actor_token, '') AS actor_token, a.created_at
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor_id
ORDER BY a.id DESC
LIMIT ? OFFSET ?;

-- name: GetSetting :one
SELECT value FROM settings WHERE key = ?;

-- name: SetSetting :exec
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: GetAllSettings :many
SELECT key, value FROM settings;
