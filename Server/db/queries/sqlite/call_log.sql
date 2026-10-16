-- name: InsertCallMessage :one
-- A call log row is a messages row with kind = 1. The caller passes the
-- fallback text that only old clients show.
INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, ?, 1)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone, pinned_at, kind;

-- name: InsertMessageCall :exec
INSERT INTO message_calls (message_id, channel_id, started_at, last_seen_at)
VALUES (?, ?, ?, ?);

-- name: InsertMessageCallParticipant :exec
INSERT OR IGNORE INTO message_call_participants (message_id, user_id) VALUES (?, ?);

-- name: EndMessageCall :execrows
-- A second end matches no row, so ending twice does nothing.
UPDATE message_calls SET ended_at = ? WHERE message_id = ? AND ended_at IS NULL;

-- name: UpdateCallMessageContent :exec
UPDATE messages SET content = ? WHERE id = ? AND kind = 1;

-- name: GetMessageCallsByMessageIDs :many
SELECT message_id, started_at, ended_at
FROM message_calls
WHERE message_id IN (sqlc.slice('ids'));

-- name: GetMessageCallParticipantsByMessageIDs :many
SELECT message_id, user_id
FROM message_call_participants
WHERE message_id IN (sqlc.slice('ids'))
ORDER BY message_id, user_id;
