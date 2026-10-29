-- name: ListStickers :many
SELECT id, name, emoji, filename, mime_type, uploaded_by, created_at
FROM stickers ORDER BY name COLLATE NOCASE ASC, id ASC;

-- name: GetStickerByID :one
SELECT id, name, emoji, filename, mime_type, uploaded_by, created_at
FROM stickers WHERE id = ?;

-- name: GetStickerByName :one
-- The uniqueness check behind CreateSticker. The column is COLLATE NOCASE, so
-- the comparison ignores case.
SELECT id, name, emoji, filename, mime_type, uploaded_by, created_at
FROM stickers WHERE name = ?;

-- name: CountStickers :one
SELECT COUNT(*) FROM stickers;

-- name: CreateSticker :one
INSERT INTO stickers (name, emoji, filename, mime_type, uploaded_by)
VALUES (?, ?, ?, ?, ?)
RETURNING id, name, emoji, filename, mime_type, uploaded_by, created_at;

-- name: UpdateSticker :one
UPDATE stickers SET name = ?, emoji = ? WHERE id = ?
RETURNING id, name, emoji, filename, mime_type, uploaded_by, created_at;

-- name: DeleteSticker :execresult
DELETE FROM stickers WHERE id = ?;

-- name: InsertMessageSticker :execresult
-- The sticker row of a new sticker message (migration 083, WP 8.8a), written in
-- the same transaction as the message and its receipt. The row is selected
-- from stickers, so a sticker deleted after the service looked it up inserts
-- nothing and the caller sees zero rows affected. name is the label the
-- message keeps if the sticker is deleted later.
INSERT INTO message_stickers (message_id, sticker_id, name)
SELECT sqlc.arg(message_id), s.id, sqlc.arg(name)
FROM stickers s WHERE s.id = sqlc.arg(sticker_id);

-- name: GetMessageStickersByMessageIDs :many
SELECT message_id, sticker_id, name
FROM message_stickers WHERE message_id IN (sqlc.slice('ids'));
