-- name: CreateMessage :one
INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone;

-- name: GetMessage :one
SELECT id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
       mentions_everyone
FROM messages WHERE id = ?;

-- name: GetMessagesForAPI :many
SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
       m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
FROM messages m JOIN users u ON m.user_id = u.id
WHERE m.channel_id = ? AND m.deleted = 0
ORDER BY m.id DESC LIMIT ?;

-- name: EditMessageContent :one
-- The deleted = 0 guard is the one SoftDeleteMessage and SetMessagePinned
-- already carry (OC-0284): an edit that races a delete must not rewrite a
-- tombstone. No row comes back when it loses, which the wrapper reports as
-- ErrNotFound rather than a silent success (OC-0358).
UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ? AND deleted = 0
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone;

-- name: SoftDeleteMessage :execresult
UPDATE messages SET deleted = 1 WHERE id = ? AND deleted = 0;

-- name: SetMessagePinned :execresult
UPDATE messages SET pinned = ? WHERE id = ? AND deleted = 0;

-- name: GetLatestMessageID :one
SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND deleted = 0;

-- name: UpdateReadState :exec
-- Marking a channel read also clears its mention badge: channel_focus is the
-- only caller, and a focused channel has no outstanding mentions by definition.
INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
VALUES (?, ?, ?, 0)
ON CONFLICT(user_id, channel_id) DO UPDATE SET
    last_message_id = excluded.last_message_id,
    mention_count = 0;

-- name: MarkChannelReadAtLatest :exec
-- Mark-read that computes its own watermark inside the writer statement.
-- Passing a snapshot read moments earlier is what destroyed a mention raised
-- during the round trip (OC-0323): the clear zeroed mention_count while
-- last_message_id still pointed behind the mentioning message, so the badge was
-- gone and nothing ever recomputed it. Computing MAX(id) here means every
-- message committed before this statement is covered by last_message_id, and
-- every message committed after it finds IncrementMentionCounts' own
-- `last_message_id < msgID` guard true, so its mention survives.
INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
VALUES (?, ?, (SELECT COALESCE(MAX(m.id), 0) FROM messages m WHERE m.channel_id = ? AND m.deleted = 0), 0)
ON CONFLICT(user_id, channel_id) DO UPDATE SET
    last_message_id = excluded.last_message_id,
    mention_count = 0;

-- name: GetReadState :one
-- Reader-pool lookup that lets the channel-focus path skip the UpdateReadState
-- UPSERT when the row is already correct, keeping no-op focus events off the
-- single writer connection.
SELECT last_message_id, mention_count FROM read_states
 WHERE user_id = ? AND channel_id = ?;

-- name: GetChannelUnreadCounts :many
SELECT c.id,
       (SELECT COALESCE(MAX(m.id), 0) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0) AS last_msg_id,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.deleted = 0
           AND m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
                                 WHERE rs.channel_id = c.id AND rs.user_id = ?), 0)) AS unread,
       COALESCE((SELECT rs.mention_count FROM read_states rs
                  WHERE rs.channel_id = c.id AND rs.user_id = ?), 0) AS mentions
FROM channels c
WHERE c.type IN ('text', 'announcement')
   OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp
                                  WHERE dp.channel_id = c.id AND dp.user_id = ?));

-- SearchMessages and SearchMessagesInChannel use the messages_fts FTS5 virtual
-- table which sqlc cannot introspect. Those queries remain as hand-written Go
-- in message_queries.go.
