-- name: UserCount :one
SELECT COUNT(*) FROM users;

-- name: CountActiveMessages :one
SELECT COUNT(*) FROM messages WHERE deleted = 0;

-- name: CountChannels :one
SELECT COUNT(*) FROM channels;

-- name: CountActiveInvites :one
SELECT COUNT(*) FROM invites WHERE revoked = 0;

-- name: ListAllUsers :many
SELECT u.id, u.username, u.avatar, u.role_id,
       u.status, u.created_at, u.last_seen, u.banned, u.ban_reason, u.ban_expires,
       COALESCE(r.name, '') AS role_name
FROM users u
LEFT JOIN roles r ON r.id = u.role_id
WHERE u.registration_status = 'active'
ORDER BY u.id ASC
LIMIT ? OFFSET ?;

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
-- An empty action or query matches every row. action is an exact match;
-- query is a case-insensitive (ASCII) substring of the actor name, action,
-- target type or detail. instr, not LIKE, so the caller's text carries no
-- wildcards to escape.
SELECT a.id, a.actor_id, COALESCE(u.username, '') AS actor_name, a.action,
       a.target_type, a.target_id, a.detail, COALESCE(a.subject_token, '') AS subject_token,
       COALESCE(a.actor_token, '') AS actor_token, a.created_at
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor_id
WHERE (CAST(sqlc.arg(action) AS TEXT) = '' OR a.action = sqlc.arg(action))
  AND (CAST(sqlc.arg(query) AS TEXT) = ''
       OR instr(lower(COALESCE(u.username, '')), lower(sqlc.arg(query))) > 0
       OR instr(lower(a.action), lower(sqlc.arg(query))) > 0
       OR instr(lower(a.target_type), lower(sqlc.arg(query))) > 0
       OR instr(lower(a.detail), lower(sqlc.arg(query))) > 0)
ORDER BY a.id DESC
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: GetSetting :one
SELECT value FROM settings WHERE key = ?;

-- name: SetSetting :exec
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: GetAllSettings :many
SELECT key, value FROM settings;
