-- name: CreateAttachment :exec
INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size, width, height)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetAttachmentByID :one
SELECT id, message_id, filename, stored_as, mime_type, size, uploaded_at, uploader_id
FROM attachments WHERE id = ?;

-- name: GetAttachmentWithChannel :one
SELECT a.id, a.message_id, a.filename, a.stored_as, a.mime_type, a.size,
       a.uploaded_at, a.uploader_id, m.channel_id, c.type
FROM attachments a
LEFT JOIN messages m ON m.id = a.message_id
LEFT JOIN channels c ON c.id = m.channel_id
WHERE a.id = ?;

-- name: LinkAttachmentToMessage :execresult
UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL;

-- name: DeleteOrphanedAttachments :many
DELETE FROM attachments WHERE message_id IS NULL AND uploaded_at < ? RETURNING stored_as;

-- name: DeleteAttachment :exec
DELETE FROM attachments WHERE id = ?;
