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

-- name: ListOpenMessageCalls :many
-- Every live call with its author, for the call log worker's start-up
-- recovery, its periodic pass and its stop.
SELECT c.message_id, c.channel_id, c.started_at, c.last_seen_at, m.user_id
FROM message_calls c
JOIN messages m ON m.id = c.message_id
WHERE c.ended_at IS NULL
ORDER BY c.message_id;

-- name: GetOpenMessageCallByChannel :one
SELECT c.message_id, c.channel_id, c.started_at, c.last_seen_at, m.user_id
FROM message_calls c
JOIN messages m ON m.id = c.message_id
WHERE c.channel_id = ? AND c.ended_at IS NULL;

-- name: TouchMessageCall :exec
-- last_seen_at only moves forward, and only while the call is live.
UPDATE message_calls SET last_seen_at = ?1
WHERE message_id = ?2 AND ended_at IS NULL AND last_seen_at < ?1;

-- name: InsertExistingMessageCallParticipant :exec
-- Records a participant only while the user still exists, so a vanished user
-- is skipped instead of failing the whole write.
INSERT OR IGNORE INTO message_call_participants (message_id, user_id)
SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2);
