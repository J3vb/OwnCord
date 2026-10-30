package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// MentionBatchEntry is one message's mention fan-out inside a multi-message
// writer transaction: the recipients to bump and the message id their
// read-state guard compares against. The mention worker coalesces a window's
// jobs into one entry per message, then one transaction per channel.
type MentionBatchEntry struct {
	MsgID   int64
	UserIDs []int64
}

// IncrementMentionCounts bumps read_states.mention_count by one for each user
// in a channel, creating the read-state row when missing. A created row has
// last_message_id 0: the user has read nothing, so the mention is unread.
//
// msgID is the message that triggered the fan-out. A recipient whose read state
// already covers it (last_message_id >= msgID) is skipped: a mark_read landing
// between the message commit and this deferred call already zeroed their count,
// and an unconditional increment would leave a permanent phantom badge. The
// guard is part of the same ON CONFLICT ... DO UPDATE ... WHERE, so there is
// no check-then-write window.
//
// Recipients go in one multi-row INSERT per mentionCountChunkSize chunk, since
// an @everyone mention fans out to every reader of a channel. The caller has
// already excluded the author; each listed user gets exactly one increment (or
// a fresh row seeded at 1) unless the guard skips it.
func (d *DB) IncrementMentionCounts(ctx context.Context, channelID, msgID int64, userIDs []int64) error {
	_, err := d.IncrementMentionCountsBatch(ctx, channelID, []MentionBatchEntry{{MsgID: msgID, UserIDs: userIDs}})
	return err
}

// IncrementMentionCountsBatch applies every entry in one writer transaction,
// so a coalesced window costs one commit instead of one per message. Each
// entry behaves as IncrementMentionCounts, with its own read-state guard
// (last_message_id < entry.MsgID).
//
// An entry whose message is no longer live (soft-deleted by a delete/purge
// during the coalesce window, or hard-deleted by an erasure) is skipped: the
// reversal paths run synchronously and can only reverse a bump that already
// landed, so a deferred increment for a removed message would raise a badge
// nothing takes back. The liveness check runs in the writer transaction, which
// is serialized against every removal, so it sees stable state.
//
// The returned map is userID to mention_count after the bump, holding exactly
// the recipients the guard admitted (the RETURNING rows). It is the live-badge
// signal the mention worker pushes per user; skipped readers and removed
// messages' recipients are absent, so no frame resurrects a dropped badge.
func (d *DB) IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []MentionBatchEntry) (map[int64]int64, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("IncrementMentionCountsBatch begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	bumped := make(map[int64]int64)
	for _, e := range entries {
		live, err := messageLiveForMention(ctx, tx, e.MsgID)
		if err != nil {
			return nil, err
		}
		if !live {
			continue
		}
		if err := insertMentionCountChunks(ctx, tx, channelID, e.MsgID, e.UserIDs, bumped); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("IncrementMentionCountsBatch commit: %w", err)
	}
	return bumped, nil
}

// messageLiveForMention reports whether msgID is a live message; a missing
// (erased) or tombstoned (deleted = 1) row is not, and the increment is skipped.
func messageLiveForMention(ctx context.Context, tx *sql.Tx, msgID int64) (bool, error) {
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM messages WHERE id = ? AND deleted = 0`, msgID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IncrementMentionCounts liveness: %w", err)
	}
	return true, nil
}

// insertMentionCountChunks writes one message's per-recipient upserts inside
// tx, chunked to keep bound parameters (2 per row) well below SQLite's limit.
// msgID is a bound parameter of the WHERE clause, not a VALUES column, since
// every conflicting row in a chunk shares the one message.
//
// RETURNING tells the caller whose bump the read-state guard admitted and their
// new total, folded into bumped. A conflicting row the WHERE rejects updates
// nothing and returns no row (SQLite's upsert RETURNING), so a skipped reader
// never appears.
func insertMentionCountChunks(ctx context.Context, tx *sql.Tx, channelID, msgID int64, userIDs []int64, bumped map[int64]int64) error {
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
			 WHERE read_states.last_message_id < ?
			 RETURNING user_id, mention_count`,
			strings.Join(rowPlaceholders, ","),
		)
		rows, err := tx.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("IncrementMentionCounts: %w", err)
		}
		admitted := make([]int64, 0, len(chunk))
		for rows.Next() {
			var uid, count int64
			if err := rows.Scan(&uid, &count); err != nil {
				rows.Close() //nolint:errcheck // read path; the scan error is the one that matters
				return fmt.Errorf("IncrementMentionCounts scan: %w", err)
			}
			bumped[uid] = count
			admitted = append(admitted, uid)
		}
		if err := rows.Err(); err != nil {
			rows.Close() //nolint:errcheck // read path; the rows error is the one that matters
			return fmt.Errorf("IncrementMentionCounts rows: %w", err)
		}
		rows.Close() //nolint:errcheck // read path; a close error adds nothing over the committed txn
		// The writer is one connection, so no statement may run while rows are open:
		// receipts go in only after the RETURNING set is drained.
		if err := insertMentionReceipts(ctx, tx, channelID, msgID, admitted); err != nil {
			return err
		}
	}
	return nil
}

// insertMentionReceipts records, in the increment's transaction, one
// mention_receipts row per recipient whose badge the guard admitted for msgID.
// A skipped reader gets no receipt, matching the counter. OR IGNORE keeps a
// repeated entry idempotent.
func insertMentionReceipts(ctx context.Context, tx *sql.Tx, channelID, msgID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	rowPlaceholders := make([]string, len(userIDs))
	args := make([]any, 0, len(userIDs)*3)
	for i, uid := range userIDs {
		rowPlaceholders[i] = "(?, ?, ?)"
		args = append(args, uid, channelID, msgID)
	}
	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`INSERT OR IGNORE INTO mention_receipts (user_id, channel_id, message_id) VALUES %s`,
		strings.Join(rowPlaceholders, ","),
	)
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("IncrementMentionCounts receipts: %w", err)
	}
	return nil
}
