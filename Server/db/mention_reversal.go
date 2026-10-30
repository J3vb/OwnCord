package db

import (
	"context"
	"fmt"
)

// countedReceipt is the SQL predicate, over mention_receipts r joined to its
// message m, for a receipt that records a badge the message really raised.
// Receipts written with an increment are exact. The migration 063 backfill
// could not tell @here from @everyone and included mentions an edit added, so
// a receipt on a message older than that migration counts only when a direct
// mention of the reader backs it.
const countedReceipt = `(m.timestamp >= COALESCE(
	(SELECT applied_at FROM schema_versions WHERE version = '063_mention_receipts.sql'), '')
	OR EXISTS (SELECT 1 FROM message_mentions mm
	            WHERE mm.message_id = m.id AND mm.mentioned_user_id = r.user_id))`

// DecrementMentionCounts reverses the read_states.mention_count increments
// IncrementMentionCounts made for msgIDs, when those messages are deleted or
// purged. Otherwise a deleted mentioning message would leave a badge pointing
// at nothing, since the delete path soft-deletes the row and leaves read_states
// untouched while the unread count is computed live.
//
// The readers come from mention_receipts, the ledger of whose badge each
// message raised, not from message_mentions: an edit rewrites message_mentions
// but never moves a badge, so reversing the current set would wipe an
// unrelated badge for an edit-added mention and leave one for an edit-removed
// mention. Receipts also cover @everyone and @here. Receipts from the
// migration 063 backfill can overcount (see countedReceipt), so they count only
// where a direct mention backs them.
//
// Each message is decremented separately, guarded like the increment
// (last_message_id < msgID), since a reader who has read past it had the badge
// settled by that read; mention_count > 0 keeps each step monotonic. A receipt
// from an author the reader has since blocked is skipped, matching the
// read-pointer recompute (receiptsAfter): once a read recomputed the badge
// without it, reversing again would take a second badge (until that read the
// badge stays one too high). The message's receipts are deleted in the same
// transaction, so a repeated call lowers nothing.
//
// The returned map is userID to mention_count after the reversal, holding
// exactly the readers the guards admitted (the RETURNING rows), the same
// live-badge signal IncrementMentionCountsBatch returns.
func (d *DB) DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) (map[int64]int64, error) {
	if len(msgIDs) == 0 {
		return nil, nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("DecrementMentionCounts begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	lowered := make(map[int64]int64)
	for _, msgID := range msgIDs {
		rows, err := tx.QueryContext(ctx,
			`UPDATE read_states
			 SET mention_count = mention_count - 1
			 WHERE channel_id = ?
			   AND mention_count > 0
			   AND last_message_id < ?
			   AND user_id IN (SELECT r.user_id FROM mention_receipts r
			                    JOIN messages m ON m.id = r.message_id
			                    WHERE r.message_id = ? AND r.channel_id = ?
			                      AND `+countedReceipt+`)
			   AND NOT EXISTS (
			       SELECT 1 FROM user_blocks b
			       WHERE b.blocker_id = read_states.user_id
			         AND b.blocked_id = (SELECT user_id FROM messages WHERE id = ?)
			   )
			 RETURNING user_id, mention_count`,
			channelID, msgID, msgID, channelID, msgID,
		)
		if err != nil {
			return nil, fmt.Errorf("DecrementMentionCounts: %w", err)
		}
		for rows.Next() {
			var uid, count int64
			if scanErr := rows.Scan(&uid, &count); scanErr != nil {
				rows.Close() //nolint:errcheck // read path; the scan error is the one that matters
				return nil, fmt.Errorf("DecrementMentionCounts scan: %w", scanErr)
			}
			lowered[uid] = count
		}
		if err := rows.Err(); err != nil {
			rows.Close() //nolint:errcheck // read path; the rows error is the one that matters
			return nil, fmt.Errorf("DecrementMentionCounts rows: %w", err)
		}
		rows.Close() //nolint:errcheck // read path; a close error adds nothing over the committed txn
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM mention_receipts WHERE message_id = ? AND channel_id = ?`,
			msgID, channelID); err != nil {
			return nil, fmt.Errorf("DecrementMentionCounts receipts: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("DecrementMentionCounts commit: %w", err)
	}
	return lowered, nil
}
