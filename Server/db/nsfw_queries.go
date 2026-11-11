package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AcknowledgeNSFWTxRaceHook runs once per AcknowledgeNSFW call when non-nil,
// in the writer transaction after the label check and before the insert.
// Test-only (exported for service tests). The writer is capped at one
// connection, so anything the hook needs the writer for can only block, which
// lets a test prove the race deterministically.
var AcknowledgeNSFWTxRaceHook func()

// AcknowledgeNSFW records that userID consented to channelID's labelled
// content. The label check and insert share ONE writer transaction, so a
// concurrent Revoke or relabel cannot land between read and write nor between
// insert and answer; 0 rows affected alone could not tell "already
// acknowledged" (idempotent) from "not labelled" (refuse), and a separate
// post-insert read let a duplicate PUT racing another row's revoke answer
// NOT_NSFW for a still-labelled channel. Hand-rolled because sqlc v1.30.0's
// SQLite engine mis-slices INSERT ... SELECT ... FROM. labelled=false means the
// channel does not exist or is not labelled now (ErrNotNSFW).
func (d *DB) AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (labelled bool, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var nsfw int64
	switch scanErr := tx.QueryRowContext(ctx, `SELECT nsfw FROM channels WHERE id = ?`, channelID).Scan(&nsfw); {
	case errors.Is(scanErr, sql.ErrNoRows):
		return false, nil
	case scanErr != nil:
		return false, fmt.Errorf("AcknowledgeNSFW label check: %w", scanErr)
	case nsfw == 0:
		return false, nil
	}

	if AcknowledgeNSFWTxRaceHook != nil {
		AcknowledgeNSFWTxRaceHook()
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`,
		userID, channelID); err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW commit: %w", err)
	}
	return true, nil
}

// RevokeNSFW deletes userID's acknowledgement, effective on the next read; a missing
// row is a no-op.
func (d *DB) RevokeNSFW(ctx context.Context, userID, channelID int64) error {
	if err := d.q.RevokeNSFW(ctx, dbgen.RevokeNSFWParams{UserID: userID, ChannelID: channelID}); err != nil {
		return fmt.Errorf("RevokeNSFW: %w", err)
	}
	return nil
}

// HasNSFWAcknowledgement reports whether userID acknowledged channelID; asked live on
// every content path so a revocation applies at once.
func (d *DB) HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error) {
	n, err := d.q.HasNSFWAcknowledgement(ctx, dbgen.HasNSFWAcknowledgementParams{UserID: userID, ChannelID: channelID})
	if err != nil {
		return false, fmt.Errorf("HasNSFWAcknowledgement: %w", err)
	}
	return n > 0, nil
}

// ListNSFWAcknowledgedUserIDs returns every user who acknowledged channelID, the hub's
// audience for a labelled channel.
func (d *DB) ListNSFWAcknowledgedUserIDs(ctx context.Context, channelID int64) ([]int64, error) {
	ids, err := d.q.ListNSFWAcknowledgedUserIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("ListNSFWAcknowledgedUserIDs: %w", err)
	}
	return ids, nil
}

// ChannelContentGate answers the NSFW content gate in one live point read: found is
// false when the channel does not exist (or is being imported), readable is true for
// an unlabelled channel or one userID acknowledged. A thread takes its parent's label.
func (d *DB) ChannelContentGate(ctx context.Context, userID, channelID int64) (found, readable bool, err error) {
	r, err := d.q.ChannelContentGate(ctx, dbgen.ChannelContentGateParams{UserID: userID, ChannelID: channelID})
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("ChannelContentGate: %w", err)
	}
	return true, r.Nsfw == 0 || r.Acknowledged != 0, nil
}

// ListNSFWAcknowledgedChannelIDs returns the channels userID acknowledged, keyed by
// parent channel, never a thread.
func (d *DB) ListNSFWAcknowledgedChannelIDs(ctx context.Context, userID int64) (map[int64]bool, error) {
	ids, err := d.q.ListNSFWAcknowledgedChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListNSFWAcknowledgedChannelIDs: %w", err)
	}
	acked := make(map[int64]bool, len(ids))
	for _, id := range ids {
		acked[id] = true
	}
	return acked, nil
}

// DeleteNSFWAcknowledgementsForChannel removes every acknowledgement of channelID.
// Clearing the nsfw flag does this in its transaction so a re-label re-prompts
// everyone; channel deletion cascades.
func (d *DB) DeleteNSFWAcknowledgementsForChannel(ctx context.Context, channelID int64) error {
	if err := d.q.DeleteNSFWAcknowledgementsForChannel(ctx, channelID); err != nil {
		return fmt.Errorf("DeleteNSFWAcknowledgementsForChannel: %w", err)
	}
	return nil
}

// AdminUpdateChannelClearingNSFW is AdminUpdateChannel plus
// DeleteNSFWAcknowledgementsForChannel in one transaction: a crash between them could
// leave the flag off with acknowledgements on file, and a re-label would trust old
// consent. Used only when nsfw goes from 1 to 0.
func (d *DB) AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u ChannelUpdate) error {
	if err := d.adminUpdateChannel(ctx, id, u, true); err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW: %w", err)
	}
	return nil
}
