-- name: InsertPinEventMessage :one
-- A pin row is a messages row with kind = 7. reply_to names the pinned message;
-- content is the fallback text that only old clients show.
INSERT INTO messages (channel_id, user_id, content, reply_to, kind) VALUES (?, ?, ?, ?, 7)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone, pinned_at, kind;

-- name: RecentPinEventExists :one
-- True when a live pin row for the message was written at or after the cutoff
-- (a messages.timestamp-layout string).
SELECT EXISTS (SELECT 1 FROM messages WHERE reply_to = ? AND kind = 7 AND deleted = 0 AND timestamp >= ?);
