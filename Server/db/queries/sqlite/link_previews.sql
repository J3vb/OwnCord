-- name: GetLinkPreview :one
SELECT url_hash, url, title, description, site_name, image_hash, fetched_at, failure, last_used_at
FROM link_previews WHERE url_hash = ?;

-- name: UpsertLinkPreview :exec
-- A refetch replaces the card and its failure state. The image row, if any,
-- must already exist.
INSERT INTO link_previews (url_hash, url, title, description, site_name, image_hash, fetched_at, failure, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url_hash) DO UPDATE SET
    url          = excluded.url,
    title        = excluded.title,
    description  = excluded.description,
    site_name    = excluded.site_name,
    image_hash   = excluded.image_hash,
    fetched_at   = excluded.fetched_at,
    failure      = excluded.failure,
    last_used_at = excluded.last_used_at;

-- name: TouchLinkPreview :exec
UPDATE link_previews SET last_used_at = ? WHERE url_hash = ?;

-- name: GetLinkPreviewImage :one
SELECT hash, mime_type, size, width, height, created_at, last_used_at
FROM link_preview_images WHERE hash = ?;

-- name: InsertLinkPreviewImage :exec
-- The same bytes twice are one row: a repeat only refreshes last_used_at.
INSERT INTO link_preview_images (hash, mime_type, size, width, height, created_at, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(hash) DO UPDATE SET last_used_at = excluded.last_used_at;

-- name: TouchLinkPreviewImage :exec
UPDATE link_preview_images SET last_used_at = ? WHERE hash = ?;

-- name: ListMessageLinkPreviews :many
SELECT mlp.message_id, mlp.position,
       p.url_hash, p.url, p.title, p.description, p.site_name, p.image_hash, p.fetched_at, p.failure,
       i.mime_type AS image_mime_type, i.size AS image_size, i.width AS image_width, i.height AS image_height
FROM message_link_previews mlp
JOIN link_previews p ON p.url_hash = mlp.url_hash
LEFT JOIN link_preview_images i ON i.hash = p.image_hash
WHERE mlp.message_id = ?
ORDER BY mlp.position ASC;

-- name: ListLinkPreviewsForMessages :many
-- The batch form of ListMessageLinkPreviews, for a page of history.
SELECT mlp.message_id, mlp.position,
       p.url_hash, p.url, p.title, p.description, p.site_name, p.image_hash, p.fetched_at, p.failure,
       i.mime_type AS image_mime_type, i.size AS image_size, i.width AS image_width, i.height AS image_height
FROM message_link_previews mlp
JOIN link_previews p ON p.url_hash = mlp.url_hash
LEFT JOIN link_preview_images i ON i.hash = p.image_hash
WHERE mlp.message_id IN (sqlc.slice('message_ids'))
ORDER BY mlp.message_id ASC, mlp.position ASC;

-- name: UpsertMessageUnfurlIfCurrent :execrows
-- Writes the unfurl marker only while the message exists, is not deleted and
-- still carries the version the caller saw (edited_at, else timestamp). Zero
-- rows means the result is stale and the caller writes nothing more.
INSERT INTO message_unfurls (message_id, unfurled_at, content_version)
SELECT m.id, sqlc.arg(unfurled_at), sqlc.arg(content_version)
FROM messages m
WHERE m.id = sqlc.arg(message_id) AND m.deleted = 0 AND COALESCE(m.edited_at, m.timestamp) = sqlc.arg(content_version)
ON CONFLICT(message_id) DO UPDATE SET
    unfurled_at     = excluded.unfurled_at,
    content_version = excluded.content_version;

-- name: GetMessageUnfurl :one
SELECT message_id, unfurled_at, content_version FROM message_unfurls WHERE message_id = ?;

-- name: DeleteMessageLinkPreviews :exec
DELETE FROM message_link_previews WHERE message_id = ?;

-- name: InsertMessageLinkPreview :exec
INSERT INTO message_link_previews (message_id, position, url_hash) VALUES (?, ?, ?);

-- name: SumLinkPreviewImageBytes :one
SELECT CAST(COALESCE(SUM(size), 0) AS INTEGER) AS total FROM link_preview_images;

-- name: ListOldestLinkPreviewImages :many
SELECT hash, size FROM link_preview_images ORDER BY last_used_at ASC, hash ASC LIMIT ?;

-- name: ListLinkPreviewImagesUnusedBefore :many
SELECT hash, size FROM link_preview_images WHERE last_used_at < ? ORDER BY last_used_at ASC, hash ASC LIMIT ?;

-- name: ListUnreferencedLinkPreviewImages :many
-- Images no preview names, made before the cutoff so one stored a moment ago
-- (its preview row not written yet) is left alone.
SELECT i.hash, i.size FROM link_preview_images i
WHERE i.created_at < ?
  AND NOT EXISTS (SELECT 1 FROM link_previews p WHERE p.image_hash = i.hash)
ORDER BY i.created_at ASC, i.hash ASC LIMIT ?;

-- name: DeleteLinkPreviewImage :execrows
-- A preview that named the image keeps its text and loses its image_hash.
DELETE FROM link_preview_images WHERE hash = ?;
