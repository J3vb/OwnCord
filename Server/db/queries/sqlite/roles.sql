-- name: GetRoleByID :one
SELECT id, name, color, permissions, position, is_default
FROM roles WHERE id = ?;

-- name: ListRoles :many
-- Highest rank first. Positions are only "unique enough": reorder normalizes
-- them, but creating a role inserts just below the actor and may tie with an
-- existing role, so id is a tiebreaker. Without it SQLite may return tied rows
-- in any order, and the admin panel derives its reorder payload from this
-- order, so a single move-up would silently shuffle the tied roles.
-- NOTE: keep comments in this file ASCII-only. sqlc mixes byte and rune
-- offsets when stripping them, so a non-ASCII character here truncates the
-- generated SQL of THIS and every following query by the byte/rune delta.
SELECT id, name, color, permissions, position, is_default
FROM roles ORDER BY position DESC, id ASC;

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

-- name: GetRoleByName :one
-- Case-insensitive by design: migration 023 enforces uniqueness under the same
-- collation, so this is the lookup that agrees with the constraint.
SELECT id, name, color, permissions, position, is_default
FROM roles WHERE name = ? COLLATE NOCASE;

-- name: GetDefaultRole :one
-- The fallback role every member lands on when their role is deleted. Highest
-- position wins if a database somehow carries more than one default.
SELECT id, name, color, permissions, position, is_default
FROM roles WHERE is_default = 1 ORDER BY position DESC, id ASC LIMIT 1;

-- name: CreateRole :one
INSERT INTO roles (name, color, permissions, position, is_default)
VALUES (?, ?, ?, ?, 0)
RETURNING id, name, color, permissions, position, is_default;

-- name: UpdateRole :exec
UPDATE roles SET name = ?, color = ?, permissions = ?, position = ? WHERE id = ?;

-- name: SetRolePosition :exec
UPDATE roles SET position = ? WHERE id = ?;

-- name: DeleteRole :exec
DELETE FROM roles WHERE id = ?;

-- name: CountRoleMembers :many
SELECT role_id, COUNT(*) AS member_count FROM users GROUP BY role_id;

-- name: ListUserIDsByRole :many
SELECT id FROM users WHERE role_id = ?;

