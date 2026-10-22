-- name: GetRoleByID :one
SELECT id, name, color, permissions, position, is_default, hoist, mentionable
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
SELECT id, name, color, permissions, position, is_default, hoist, mentionable
FROM roles ORDER BY position DESC, id ASC;

-- name: GetRoleForUser :one
-- The member's TOP role (highest position, lowest id on a tie), which is the
-- role users.role_id mirrors. Never a source of permission bits: those are the
-- OR over every held role (ListUserRoles).
SELECT r.id, r.name, r.color, r.permissions, r.position, r.is_default, r.hoist, r.mentionable
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
WHERE ur.user_id = ?
ORDER BY r.position DESC, r.id ASC
LIMIT 1;

-- name: GetRoleByName :one
-- Case-insensitive by design: migration 023 enforces uniqueness under the same
-- collation, so this is the lookup that agrees with the constraint.
SELECT id, name, color, permissions, position, is_default, hoist, mentionable
FROM roles WHERE name = ? COLLATE NOCASE;

-- name: GetDefaultRole :one
-- The fallback role every member lands on when their role is deleted. Highest
-- position wins if a database somehow carries more than one default.
SELECT id, name, color, permissions, position, is_default, hoist, mentionable
FROM roles WHERE is_default = 1 ORDER BY position DESC, id ASC LIMIT 1;

-- name: CreateRole :one
INSERT INTO roles (name, color, permissions, position, is_default, hoist, mentionable)
VALUES (?, ?, ?, ?, 0, ?, ?)
RETURNING id, name, color, permissions, position, is_default, hoist, mentionable;

-- name: UpdateRole :exec
UPDATE roles SET name = ?, color = ?, permissions = ?, position = ?, hoist = ?, mentionable = ? WHERE id = ?;

-- name: GetRolePosition :one
SELECT position FROM roles WHERE id = ?;

-- name: ListMultiRoleHoldersOfRole :many
-- Holders of the role who hold at least one other role: the only members whose
-- top role (and role order) a position change can move.
SELECT ur.user_id FROM user_roles ur
WHERE ur.role_id = ?
  AND (SELECT COUNT(*) FROM user_roles x WHERE x.user_id = ur.user_id) > 1
ORDER BY ur.user_id ASC;

-- name: ListAllUserRoleIDs :many
-- Every held role id of every member, top role first within a member.
SELECT ur.user_id, ur.role_id
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
ORDER BY ur.user_id ASC, r.position DESC, r.id ASC;

-- name: ListUserRoleIDsForUsers :many
-- Held role ids of the given members, top role first within a member.
SELECT ur.user_id, ur.role_id
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
WHERE ur.user_id IN (sqlc.slice('user_ids'))
ORDER BY ur.user_id ASC, r.position DESC, r.id ASC;

-- name: SetRolePosition :exec
UPDATE roles SET position = ? WHERE id = ?;

-- name: DeleteRole :exec
DELETE FROM roles WHERE id = ?;

-- name: CountRoleMembers :many
SELECT role_id, COUNT(*) AS member_count FROM user_roles GROUP BY role_id;

-- name: ListUserIDsByRole :many
-- Every holder of the role, not only the members whose top role it is.
SELECT user_id FROM user_roles WHERE role_id = ? ORDER BY user_id ASC;


-- name: ListUserRoles :many
-- Every role a member holds, top role first (highest position, lowest id).
SELECT r.id, r.name, r.color, r.permissions, r.position, r.is_default, r.hoist, r.mentionable
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
WHERE ur.user_id = ?
ORDER BY r.position DESC, r.id ASC;

-- name: ListRoleIDsByUser :many
-- Held role ids, top role first.
SELECT r.id
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
WHERE ur.user_id = ?
ORDER BY r.position DESC, r.id ASC;

-- name: AddUserRole :exec
INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?);

-- name: RemoveUserRole :exec
DELETE FROM user_roles WHERE user_id = ? AND role_id = ?;

-- name: CountUserRoles :one
SELECT COUNT(*) FROM user_roles WHERE user_id = ?;

-- name: SyncTopRole :exec
-- Mirrors the top held role into users.role_id. A member holding no role is
-- left untouched so role_id never goes NULL.
UPDATE users
SET role_id = (
    SELECT r.id FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = users.id
    ORDER BY r.position DESC, r.id ASC
    LIMIT 1
)
WHERE users.id = sqlc.arg(user_id)
  AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = sqlc.arg(user_id));


-- name: ClearUserRoles :exec
DELETE FROM user_roles WHERE user_id = ?;

-- name: AddUserRoleForExistingUser :exec
-- Grants the role only when the user row exists, so replacing the roles of an
-- unknown user is a no-op instead of a foreign key error.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, sqlc.arg(role_id) FROM users u WHERE u.id = sqlc.arg(user_id);
