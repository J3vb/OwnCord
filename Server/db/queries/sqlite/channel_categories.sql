-- name: ListChannelCategories :many
SELECT id, name, position, created_at
FROM channel_categories ORDER BY position ASC, id ASC;

-- name: GetChannelCategory :one
SELECT id, name, position, created_at
FROM channel_categories WHERE id = ?;

-- name: FindChannelCategoryByName :one
SELECT id, name, position, created_at
FROM channel_categories WHERE name = ? COLLATE NOCASE;

-- name: InsertChannelCategory :execresult
INSERT INTO channel_categories (name, position)
VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM channel_categories));

-- name: RenameChannelCategory :execrows
UPDATE channel_categories SET name = ? WHERE id = ?;

-- name: SetChannelCategoryPosition :execrows
UPDATE channel_categories SET position = ? WHERE id = ?;

-- name: DeleteChannelCategory :execrows
DELETE FROM channel_categories WHERE id = ?;
