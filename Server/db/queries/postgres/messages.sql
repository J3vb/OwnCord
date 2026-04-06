-- PostgreSQL variants of the sqlite messages queries.
-- `deleted = 0/1` and `pinned = 0/1` become FALSE/TRUE (columns are BOOLEAN).
-- The FTS search queries are NOT included here: on postgres, messages.fts is
-- a tsvector column with a GIN index (see migrations/postgres/001_initial_schema.sql)
-- and FTS queries are hand-written in the postgres-specific store dispatch,
-- mirroring how sqlite's FTS5 queries live in message_queries.go.

-- name: CreateMessage :one
INSERT INTO messages (channel_id, user_id, content, reply_to)
VALUES ($1, $2, $3, $4)
RETURNING id;

-- name: GetMessage :one
SELECT id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp
FROM messages WHERE id = $1;

-- name: GetMessagesByChannelBeforeCursor :many
SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
       m.edited_at, m.deleted, m.pinned, m.timestamp,
       u.username, u.avatar
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = $1 AND m.id < $2 AND m.deleted = FALSE
ORDER BY m.id DESC LIMIT $3;

-- name: GetMessagesByChannel :many
SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
       m.edited_at, m.deleted, m.pinned, m.timestamp,
       u.username, u.avatar
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = $1 AND m.deleted = FALSE
ORDER BY m.id DESC LIMIT $2;

-- name: GetMessagesForAPIBeforeCursor :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = $1 AND m.id < $2 AND m.deleted = FALSE
ORDER BY m.id DESC LIMIT $3;

-- name: GetMessagesForAPI :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = $1 AND m.deleted = FALSE
ORDER BY m.id DESC LIMIT $2;

-- name: GetPinnedMessageRows :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = $1 AND m.pinned = TRUE AND m.deleted = FALSE
ORDER BY m.id DESC;

-- name: EditMessageContent :exec
UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2;

-- name: SoftDeleteMessage :exec
UPDATE messages SET deleted = TRUE WHERE id = $1;

-- name: SetMessagePinned :execrows
UPDATE messages SET pinned = $1 WHERE id = $2 AND deleted = FALSE;

-- name: GetLatestMessageID :one
SELECT COALESCE(MAX(id), 0)::BIGINT FROM messages WHERE channel_id = $1 AND deleted = FALSE;

-- name: UpdateReadState :exec
INSERT INTO read_states (user_id, channel_id, last_message_id)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, channel_id) DO UPDATE SET last_message_id = EXCLUDED.last_message_id;

-- name: GetChannelUnreadCounts :many
SELECT c.id,
       COALESCE(MAX(m.id), 0)::BIGINT AS last_msg_id,
       COUNT(CASE WHEN m.id > COALESCE(rs.last_message_id, 0) AND m.deleted = FALSE THEN 1 END) AS unread
FROM channels c
LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted = FALSE
LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
WHERE c.type = 'text'
GROUP BY c.id;
