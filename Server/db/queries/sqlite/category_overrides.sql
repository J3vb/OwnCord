-- name: GetCategoryRoleOverride :one
SELECT allow, deny FROM category_overrides WHERE category_id = ? AND role_id = ?;

-- name: ListCategoryRoleOverrideRows :many
SELECT role_id, allow, deny FROM category_overrides WHERE category_id = ? ORDER BY role_id ASC;

-- name: UpsertCategoryRoleOverride :exec
INSERT INTO category_overrides (category_id, role_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT(category_id, role_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: DeleteCategoryRoleOverride :exec
DELETE FROM category_overrides WHERE category_id = ? AND role_id = ?;

-- name: GetCategoryUserOverride :one
SELECT allow, deny FROM category_user_overrides WHERE category_id = ? AND user_id = ?;

-- name: ListCategoryUserOverrideRows :many
SELECT user_id, allow, deny FROM category_user_overrides WHERE category_id = ? ORDER BY user_id ASC;

-- name: UpsertCategoryUserOverride :exec
INSERT INTO category_user_overrides (category_id, user_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT(category_id, user_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: DeleteCategoryUserOverride :exec
DELETE FROM category_user_overrides WHERE category_id = ? AND user_id = ?;

-- name: ListSyncedChannelIDsInCategory :many
SELECT id FROM channels WHERE category_id = ? AND permissions_synced = 1 ORDER BY id ASC;

-- name: ListSyncedChannelIDs :many
SELECT id FROM channels WHERE permissions_synced = 1 ORDER BY id ASC;

-- name: GetChannelPermissionsSynced :one
SELECT permissions_synced FROM channels WHERE id = ?;

-- name: SetChannelPermissionsSynced :exec
UPDATE channels SET permissions_synced = ? WHERE id = ?;

-- name: UnsyncChannelPermissions :exec
UPDATE channels SET permissions_synced = 0 WHERE id = ? AND permissions_synced = 1;

-- name: UnsyncCategoryChannels :exec
UPDATE channels SET permissions_synced = 0 WHERE category_id = ? AND permissions_synced = 1;

-- name: GetChannelCategoryID :one
SELECT category_id FROM channels WHERE id = ?;

-- name: DeleteChannelRoleOverrides :exec
DELETE FROM channel_overrides WHERE channel_id = ?;

-- name: DeleteChannelUserOverrides :exec
DELETE FROM channel_user_overrides WHERE channel_id = ?;

-- name: CopyCategoryRoleOverridesToChannel :exec
INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
SELECT sqlc.arg(channel_id), co.role_id, co.allow, co.deny
FROM category_overrides co WHERE co.category_id = sqlc.arg(category_id);

-- name: CopyCategoryUserOverridesToChannel :exec
INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny)
SELECT sqlc.arg(channel_id), cu.user_id, cu.allow, cu.deny
FROM category_user_overrides cu WHERE cu.category_id = sqlc.arg(category_id);
