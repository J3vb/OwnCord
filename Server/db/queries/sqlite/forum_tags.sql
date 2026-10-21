-- name: ListForumTags :many
SELECT id, forum_id, name, emoji, position, created_at
FROM forum_tags ORDER BY forum_id ASC, position ASC, id ASC;

-- name: ListForumTagsByForum :many
SELECT id, forum_id, name, emoji, position, created_at
FROM forum_tags WHERE forum_id = ? ORDER BY position ASC, id ASC;

-- name: InsertForumTag :execresult
INSERT INTO forum_tags (forum_id, name, emoji, position) VALUES (?, ?, ?, ?);

-- name: UpdateForumTag :execrows
UPDATE forum_tags SET name = ?, emoji = ?, position = ? WHERE id = ? AND forum_id = ?;

-- name: DeleteForumTag :execrows
DELETE FROM forum_tags WHERE id = ? AND forum_id = ?;

-- name: UpdateForumSettings :execrows
UPDATE channels SET forum_require_tag = ?, forum_default_auto_archive_minutes = ?
WHERE id = ? AND type = 'forum';
