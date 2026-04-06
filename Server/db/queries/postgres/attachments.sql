-- PostgreSQL variants of the sqlite attachments queries.

-- name: CreateAttachment :exec
INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size, width, height)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: GetAttachmentByID :one
SELECT id, message_id, filename, stored_as, mime_type, size, uploaded_at, uploader_id
FROM attachments WHERE id = $1;

-- name: GetAttachmentWithChannel :one
SELECT a.id, a.message_id, a.filename, a.stored_as, a.mime_type, a.size,
       a.uploaded_at, a.uploader_id, m.channel_id, c.type
FROM attachments a
LEFT JOIN messages m ON m.id = a.message_id
LEFT JOIN channels c ON c.id = m.channel_id
WHERE a.id = $1;

-- name: LinkAttachmentToMessage :execrows
UPDATE attachments SET message_id = $1 WHERE id = $2 AND message_id IS NULL;

-- Postgres timestamptz comparison — the caller passes a wall-clock time.
-- name: DeleteOrphanedAttachments :many
DELETE FROM attachments WHERE message_id IS NULL AND uploaded_at < $1 RETURNING stored_as;

-- name: DeleteAttachment :exec
DELETE FROM attachments WHERE id = $1;
