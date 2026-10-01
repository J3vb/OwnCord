package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// MentionBatchEntry is one message's mention fan-out inside a multi-message
// writer transaction: the recipients to bump and the message id their
// read-state guard compares against. It is the batched form of
// IncrementMentionCounts' arguments — the mention worker coalesces a window's
// jobs into one entry per message, then one transaction per channel.
type MentionBatchEntry struct {
	MsgID   int64
	UserIDs []int64
}

// IncrementMentionCounts bumps read_states.mention_count by one for each user
// in a channel, creating the read-state row when the user has none yet.
// last_message_id stays 0 for a created row: the user has read nothing, and the
// mention they were just given is unread by definition.
//
// msgID is the id of the message that triggered this fan-out. The increment
// is skipped for a recipient whose read state already covers msgID
// (last_message_id >= msgID): a mark_read that lands between the message
// commit and this deferred call already zeroed their mention_count, and an
// unconditional increment would leave a permanent phantom badge on a channel
// with zero unread — nothing else ever zeroes it again. The guard is atomic
// with the increment itself (part of the same ON CONFLICT ... DO UPDATE ...
// WHERE), so there is no separate check-then-write race window.
//
// Batched into one multi-row INSERT per chunk of mentionCountChunkSize
// recipients instead of one exec per recipient: an @everyone mention fans out
// to every reader of a channel, and the writer txn used to pay one round trip
// per reader for that. The caller has already excluded the author, so
// semantics are unchanged — each listed user id still gets exactly one
// increment (or a fresh row seeded at 1), unless the guard above skips it.
func (d *DB) IncrementMentionCounts(ctx context.Context, channelID, msgID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	return d.IncrementMentionCountsBatch(ctx, channelID, []MentionBatchEntry{{MsgID: msgID, UserIDs: userIDs}})
}

// IncrementMentionCountsBatch applies every entry in one writer transaction, so
// a coalesced window of messages costs one commit instead of one per message
// (P5-O05). Each entry's semantics are exactly IncrementMentionCounts' (see its
// doc); batching only shares the transaction, and entries for distinct messages
// keep their own read-state guard (last_message_id < entry.MsgID).
func (d *DB) IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []MentionBatchEntry) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("IncrementMentionCountsBatch begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	for _, e := range entries {
		if err := insertMentionCountChunks(ctx, tx, channelID, e.MsgID, e.UserIDs); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("IncrementMentionCountsBatch commit: %w", err)
	}
	return nil
}

// insertMentionCountChunks writes one message's per-recipient upserts inside
// tx, chunked so the bound-parameter count (2 per row) stays well below
// SQLite's limit. msgID is a bound parameter of the WHERE clause, not a VALUES
// column: every conflicting row in a chunk shares the one message, so one
// trailing arg covers the whole batch.
func insertMentionCountChunks(ctx context.Context, tx *sql.Tx, channelID, msgID int64, userIDs []int64) error {
	for start := 0; start < len(userIDs); start += mentionCountChunkSize {
		chunk := userIDs[start:min(start+mentionCountChunkSize, len(userIDs))]

		rowPlaceholders := make([]string, len(chunk))
		args := make([]any, 0, len(chunk)*2)
		for i, uid := range chunk {
			rowPlaceholders[i] = "(?, ?, 0, 1)"
			args = append(args, uid, channelID)
		}
		args = append(args, msgID)

		query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
			 VALUES %s
			 ON CONFLICT(user_id, channel_id) DO UPDATE SET
			     mention_count = mention_count + 1
			 WHERE read_states.last_message_id < ?`,
			strings.Join(rowPlaceholders, ","),
		)
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("IncrementMentionCounts: %w", err)
		}
	}
	return nil
}
