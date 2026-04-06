-- name: GetRoleByID :one
SELECT id, name, color, permissions, position, is_default
FROM roles WHERE id = ?;

-- name: ListRoles :many
SELECT id, name, color, permissions, position, is_default
FROM roles ORDER BY position DESC;

-- name: GetRoleForUser :one
SELECT r.id, r.name, r.color, r.permissions, r.position, r.is_default
FROM users u
JOIN roles r ON u.role_id = r.id
WHERE u.id = ?;

-- name: GetUserWithRole :one
SELECT u.id, u.username, u.password, u.avatar, u.role_id,
       u.totp_secret, u.status, u.created_at, u.last_seen,
       u.banned, u.ban_reason, u.ban_expires,
       r.id, r.name, r.color, r.permissions, r.position, r.is_default
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.id = ?;

-- name: GetDefaultRole :one
SELECT id, name, color, permissions, position, is_default
FROM roles WHERE is_default = 1 LIMIT 1;
