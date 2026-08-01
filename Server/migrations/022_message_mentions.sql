-- Phase 3 (mentions): resolved mention storage and the MENTION_EVERYONE bit.
--
-- message_mentions holds user-id mentions only. @everyone/@here is a per-message
-- boolean rather than a sentinel row, so the mention list never carries an id
-- that is not a real user. Both are rewritten wholesale when a message is edited.
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
);

-- The primary key already covers the per-message direction. This index backs
-- the per-user "which messages mention me" direction.
CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(mentioned_user_id);

ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0;

-- MENTION_EVERYONE (bit 21, 0x200000) for the seeded privileged roles. Owner
-- (0x7FFFFFFF) and Admin (0x3FFFFFFF) already hold every bit below 30. The
-- Moderator mask (0x000FFFFF) stops at bit 19, so this is the bit it gains.
UPDATE roles SET permissions = permissions | 0x200000 WHERE id IN (1, 2, 3);
