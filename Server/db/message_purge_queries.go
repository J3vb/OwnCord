package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// PurgeChannelMessages soft-deletes the newest limit non-deleted messages in a
// channel and returns their IDs, newest first; before > 0 restricts to id <
// before. Rows keep their data (only deleted=1) so tombstones and reply_to
// targets survive as with a single delete. Selection and update share one
// writer transaction so a concurrent delete cannot make the id set diverge
// from what was written.
func (d *DB) PurgeChannelMessages(ctx context.Context, channelID, before int64, limit int) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	ids, err := purgeChannelMessagesTx(ctx, tx, channelID, before, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages commit: %w", err)
	}
	return ids, nil
}

// PurgeChannelMessagesWithAction is PurgeChannelMessages plus one removal ledger row
// per purge in the same transaction, so a failure recording it rolls the purge back.
// reportID links a report-linked removal.
func (d *DB) PurgeChannelMessagesWithAction(ctx context.Context, channelID, before int64, limit int, actorID int64, reportID *int64) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessagesWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	ids, err := purgeChannelMessagesTx(ctx, tx, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		// The ledger row's target is the acting moderator: a purge can span many
		// authors, and moderation_actions.target_id must reference exactly one user.
		reason := fmt.Sprintf("%d messages purged", len(ids))
		if err := recordLedgerRow(ctx, tx, "removal", actorID, actorID, reportID, reason); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessagesWithAction commit: %w", err)
	}
	return ids, nil
}

func purgeChannelMessagesTx(ctx context.Context, tx *sql.Tx, channelID, before int64, limit int) ([]int64, error) {
	sel := `SELECT id FROM messages WHERE channel_id = ? AND deleted = 0 AND kind IN (0, 7, 8) ORDER BY id DESC LIMIT ?`
	args := []any{channelID, limit}
	if before > 0 {
		sel = `SELECT id FROM messages WHERE channel_id = ? AND id < ? AND deleted = 0 AND kind IN (0, 7, 8) ORDER BY id DESC LIMIT ?`
		args = []any{channelID, before, limit}
	}

	rows, err := tx.QueryContext(ctx, sel, args...)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages select: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			rows.Close() //nolint:errcheck
			return nil, fmt.Errorf("PurgeChannelMessages scan: %w", scanErr)
		}
		ids = append(ids, id)
	}
	rows.Close() //nolint:errcheck
	if rows.Err() != nil {
		return nil, fmt.Errorf("PurgeChannelMessages rows: %w", rows.Err())
	}
	if len(ids) == 0 {
		return []int64{}, nil
	}

	placeholders := make([]string, len(ids))
	updateArgs := make([]any, 0, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		updateArgs = append(updateArgs, id)
	}
	if _, err := tx.ExecContext(ctx,
		fmt.Sprintf(`UPDATE messages SET deleted = 1 WHERE id IN (%s)`, //nolint:gosec // G201: placeholder interpolation, not user input
			strings.Join(placeholders, ",")),
		updateArgs...,
	); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages update: %w", err)
	}
	return ids, nil
}

// DeleteMessageWithRemoval is DeleteMessage plus a removal ledger row in one
// transaction when the deleter is not the author; a self-delete or
// non-moderator delete writes no row. authorID is resolved by the caller.
// reportID links a report-linked removal. An empty reason falls back to
// "message removed".
func (d *DB) DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error {
	if !isMod || deleterID == authorID {
		return d.DeleteMessage(ctx, msgID, deleterID, isMod)
	}
	if reason == "" {
		reason = "message removed"
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := dbgen.New(tx)
	res, err := q.SoftDeleteMessage(ctx, msgID)
	if err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("DeleteMessageWithRemoval: message %d: %w", msgID, ErrNotFound)
	}
	if err := recordLedgerRow(ctx, tx, "removal", authorID, deleterID, reportID, reason); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval commit: %w", err)
	}
	return nil
}
