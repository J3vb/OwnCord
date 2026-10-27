-- name: InsertWelcomeMessage :one
-- A welcome row is a messages row with kind = 8 whose author is the new member.
-- content is the fallback text that only old clients show.
INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, ?, 8)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp,
          mentions_everyone, pinned_at, kind;
