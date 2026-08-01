-- name: ListEmoji :many
SELECT id, shortcode, filename, mime_type, uploaded_by, created_at
FROM emoji ORDER BY shortcode ASC;

-- name: GetEmojiByID :one
SELECT id, shortcode, filename, mime_type, uploaded_by, created_at
FROM emoji WHERE id = ?;

-- name: GetEmojiByShortcode :one
SELECT id, shortcode, filename, mime_type, uploaded_by, created_at
FROM emoji WHERE shortcode = ?;

-- name: CreateEmoji :one
INSERT INTO emoji (shortcode, filename, mime_type, uploaded_by)
VALUES (?, ?, ?, ?)
RETURNING id, shortcode, filename, mime_type, uploaded_by, created_at;

-- name: DeleteEmoji :execresult
DELETE FROM emoji WHERE id = ?;
