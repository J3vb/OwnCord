-- name: CreateAttachment :exec
INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size, width, height)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetAttachmentByID :one
SELECT id, message_id, filename, stored_as, mime_type, size, uploaded_at, uploader_id
FROM attachments WHERE id = ?;

-- name: GetAttachmentWithChannel :one
-- c.nsfw is the channel's label (B5-7's read gate, UploadService.Authorize):
-- NULL when the attachment is unlinked or its message/channel is gone, same
-- as c.type, so both are read through the caller's nil-safe mapping.
SELECT a.id, a.message_id, a.filename, a.stored_as, a.mime_type, a.size,
       a.uploaded_at, a.uploader_id, m.channel_id, c.type, c.nsfw
FROM attachments a
LEFT JOIN messages m ON m.id = a.message_id
LEFT JOIN channels c ON c.id = m.channel_id
WHERE a.id = ?;

-- name: DeleteOrphanedAttachments :many
-- Avatars are attachments that are never linked to a message on purpose: the
-- users.avatar URL is what keeps them alive and authorizes serving them
-- (migration 027). Excluding them here is what stops the sweep from destroying
-- every avatar in the instance. idx_users_avatar makes the lookup cheap.
--
-- OC-0279: a message delete is a soft delete (messages.deleted=1, the row
-- survives), so an attachment linked to a deleted message keeps a non-NULL
-- message_id forever -- message_id IS NULL alone never matches it, so its
-- file was permanently unreclaimable even though serveFileResolve already
-- 404s it once the owning message is deleted. The second EXISTS below
-- catches that case by joining back to messages.deleted instead. Matching on
-- messages.deleted=1 here (rather than unlinking message_id in the delete
-- path) is deliberate: unlinking would move the row onto the "unlinked
-- attachment" access branch in serveFileAuthorize and make it downloadable
-- again by the uploader.
DELETE FROM attachments
WHERE uploaded_at < ?
  AND (
    message_id IS NULL
    OR EXISTS (
      SELECT 1 FROM messages m WHERE m.id = attachments.message_id AND m.deleted = 1
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.avatar = '/api/v1/files/' || attachments.id
  )
RETURNING stored_as;

