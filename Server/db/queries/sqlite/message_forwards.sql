-- name: InsertMessageForward :exec
-- The side row that marks a message as a forward (migration 071, WP 6.9a). It
-- is written in the same transaction as the message and its receipt.
INSERT INTO message_forwards (message_id, source_message_id, source_channel_id, source_timestamp)
VALUES (?, ?, ?, ?);

-- name: GetMessageForward :one
SELECT message_id, source_message_id, source_channel_id, source_timestamp
FROM message_forwards WHERE message_id = ?;

-- name: GetMessageForwardsByMessageIDs :many
-- The forward block of history rows. source_deleted is NULL when the link is
-- already cleared (the original was purged) and 1 when the original is soft
-- deleted, so the reader can report source_message_id null in both cases.
SELECT f.message_id, f.source_message_id, f.source_channel_id, f.source_timestamp,
       s.deleted AS source_deleted
FROM message_forwards f
LEFT JOIN messages s ON s.id = f.source_message_id
WHERE f.message_id IN (sqlc.slice('ids'));

-- name: GetForwardSourceState :one
-- The in-transaction re-read of the message being forwarded. A forward is
-- refused when the row is gone, soft deleted, or not an ordinary message.
SELECT id, channel_id, kind, deleted FROM messages WHERE id = ?;

-- name: ListAttachmentsForForward :many
-- The files a forward clones, in upload order. stored_as names the bytes on
-- disk, which the clone links or copies; nothing here is sent to a client.
SELECT id, filename, stored_as, mime_type, size, width, height, duration_ms, waveform
FROM attachments WHERE message_id = ? ORDER BY rowid;
