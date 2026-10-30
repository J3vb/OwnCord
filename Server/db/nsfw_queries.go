package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AcknowledgeNSFWTxRaceHook runs once per AcknowledgeNSFW call when non-nil,
// inside the writer transaction after the label check and before the insert.
// Test-only (exported because service's tests exercise the race through
// NSFWService.Acknowledge). The writer connection is capped at one, so
// anything the hook does that needs the writer, like a concurrent RevokeNSFW,
// can only block, never interleave, which lets a test prove that
// deterministically.
var AcknowledgeNSFWTxRaceHook func()

// AcknowledgeNSFW records that userID consented to channelID's labelled
// content. The label check and insert share ONE writer transaction, so a
// concurrent Revoke or relabel cannot land between the read and the write nor
// between the insert and the answer. That closes a window a rows-affected-only
// answer could not: 0 rows means "already acknowledged" (idempotent) or "not
// labelled" (refuse), and a separate post-insert read let a duplicate PUT
// racing a revoke of someone else's row answer NOT_NSFW for a channel still
// labelled.
//
// Hand-rolled because sqlc v1.30.0's SQLite engine mis-slices an INSERT ...
// SELECT ... FROM, dropping the final token and corrupting the next query in
// the file. labelled=false means channelID does not exist or is not labelled
// now (ErrNotNSFW), whether or not a row existed.
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

// RevokeNSFW deletes userID's acknowledgement of channelID, effective on the
// very next read (no cache). Deleting a missing row is a no-op, so DELETE
// /nsfw-acknowledgement is idempotent.
func (d *DB) RevokeNSFW(ctx context.Context, userID, channelID int64) error {
	if err := d.q.RevokeNSFW(ctx, dbgen.RevokeNSFWParams{UserID: userID, ChannelID: channelID}); err != nil {
		return fmt.Errorf("RevokeNSFW: %w", err)
	}
	return nil
}

// HasNSFWAcknowledgement reports whether userID acknowledged channelID. Every
// content path (REST, search, socket, attachment bytes) asks this live, never
// from a cache, so a revocation applies at once.
func (d *DB) HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error) {
	n, err := d.q.HasNSFWAcknowledgement(ctx, dbgen.HasNSFWAcknowledgementParams{UserID: userID, ChannelID: channelID})
	if err != nil {
		return false, fmt.Errorf("HasNSFWAcknowledgement: %w", err)
	}
	return n > 0, nil
}

// ListNSFWAcknowledgedUserIDs returns every user who acknowledged channelID,
// the hub's one-query-per-broadcast audience for a labelled channel's frames
// (ws/hub_visibility.go); unlabelled channels pay nothing.
func (d *DB) ListNSFWAcknowledgedUserIDs(ctx context.Context, channelID int64) ([]int64, error) {
	ids, err := d.q.ListNSFWAcknowledgedUserIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("ListNSFWAcknowledgedUserIDs: %w", err)
	}
	return ids, nil
}

// DeleteNSFWAcknowledgementsForChannel removes every acknowledgement of
// channelID. Clearing the nsfw flag deletes standing consent in the flag's
// transaction so a later re-label re-prompts everyone; deleting the channel
// does it via the FK cascade.
func (d *DB) DeleteNSFWAcknowledgementsForChannel(ctx context.Context, channelID int64) error {
	if err := d.q.DeleteNSFWAcknowledgementsForChannel(ctx, channelID); err != nil {
		return fmt.Errorf("DeleteNSFWAcknowledgementsForChannel: %w", err)
	}
	return nil
}

// AdminUpdateChannelClearingNSFW is AdminUpdateChannel plus
// DeleteNSFWAcknowledgementsForChannel in one transaction: a crash between
// them could leave the flag off with acknowledgements on file, and a later
// re-label would trust warnings from a different on/off cycle. Callers use it
// only when the update turns nsfw from 1 to 0.
func (d *DB) AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u ChannelUpdate) error {
	if err := d.adminUpdateChannel(ctx, id, u, true); err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW: %w", err)
	}
	return nil
}
