-- Mention ledger: one row for each recipient whose read_states.mention_count was
-- actually raised by a message. It is written in the same transaction as the
-- increment (db/mention_batch.go), so a message after any read pointer can be
-- counted exactly, with @here and blocks already accounted for. Nothing reads it
-- yet. A later change uses it to recompute the badge when the pointer moves.
--
-- No channel foreign key: deleting a channel cascades its messages, and a
-- message cascades its receipts. The message index is required, or every
-- cascade from a message hard delete would scan the whole table.
CREATE TABLE mention_receipts (
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, channel_id, message_id)
) WITHOUT ROWID;

CREATE INDEX idx_mention_receipts_message ON mention_receipts(message_id);

-- Backfill only the rows that show a badge today (mention_count > 0): live
-- messages after the read pointer, written by someone else, from an author the
-- reader has not blocked, that name the reader or use @everyone. The backfill
-- can overcount: @here cannot be told apart from @everyone, mentions added by
-- an edit never raised a badge, channel access is not checked, and a row whose
-- pointer is 0 collects every @everyone in the channel. The recompute that
-- reads this table never lets an overcount raise a badge on a forward read.
-- Mentions read before this migration get no receipt.
INSERT OR IGNORE INTO mention_receipts (user_id, channel_id, message_id)
SELECT rs.user_id, rs.channel_id, m.id
FROM read_states rs
JOIN messages m
  ON m.channel_id = rs.channel_id
 AND m.id > rs.last_message_id
 AND m.deleted = 0
 AND m.user_id <> rs.user_id
WHERE rs.mention_count > 0
  AND NOT EXISTS (
        SELECT 1 FROM user_blocks b
        WHERE b.blocker_id = rs.user_id AND b.blocked_id = m.user_id)
  AND (m.mentions_everyone = 1
       OR EXISTS (
            SELECT 1 FROM message_mentions mm
            WHERE mm.message_id = m.id AND mm.mentioned_user_id = rs.user_id));
