-- name: CreateMessage :execresult
INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?);

-- name: GetMessage :one
SELECT id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp
FROM messages WHERE id = ?;

-- name: GetMessagesByChannelBeforeCursor :many
SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
       m.edited_at, m.deleted, m.pinned, m.timestamp,
       u.username, u.avatar
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
ORDER BY m.id DESC LIMIT ?;

-- name: GetMessagesByChannel :many
SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
       m.edited_at, m.deleted, m.pinned, m.timestamp,
       u.username, u.avatar
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.deleted = 0
ORDER BY m.id DESC LIMIT ?;

-- name: GetMessagesForAPIBeforeCursor :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
ORDER BY m.id DESC LIMIT ?;

-- name: GetMessagesForAPI :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.deleted = 0
ORDER BY m.id DESC LIMIT ?;

-- name: GetPinnedMessageRows :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0
ORDER BY m.id DESC;

-- name: EditMessageContent :exec
UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?;

-- name: SoftDeleteMessage :exec
UPDATE messages SET deleted = 1 WHERE id = ?;

-- name: SetMessagePinned :execresult
UPDATE messages SET pinned = ? WHERE id = ? AND deleted = 0;

-- name: GetLatestMessageID :one
SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND deleted = 0;

-- name: UpdateReadState :exec
INSERT INTO read_states (user_id, channel_id, last_message_id)
VALUES (?, ?, ?)
ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id;

-- name: GetChannelUnreadCounts :many
SELECT c.id,
       COALESCE(MAX(m.id), 0) AS last_msg_id,
       COUNT(CASE WHEN m.id > COALESCE(rs.last_message_id, 0) AND m.deleted = 0 THEN 1 END) AS unread
FROM channels c
LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted = 0
LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
WHERE c.type = 'text'
GROUP BY c.id;

-- SearchMessages and SearchMessagesInChannel use the messages_fts FTS5 virtual
-- table which sqlc cannot introspect. Those queries remain as hand-written Go
-- in message_queries.go.
