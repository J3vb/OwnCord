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

-- name: DeleteOrphanedAttachments :many
-- Avatars are attachments that are never linked to a message on purpose: the
-- users.avatar URL is what keeps them alive and authorizes serving them
-- (migration 027). Excluding them here is what stops the sweep from destroying
-- every avatar in the instance. idx_users_avatar makes the lookup cheap.
DELETE FROM attachments
WHERE message_id IS NULL
  AND uploaded_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.avatar = '/api/v1/files/' || attachments.id
  )
RETURNING stored_as;

