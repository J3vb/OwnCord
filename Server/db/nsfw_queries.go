package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AcknowledgeNSFW records that userID has consented to see channelID's
// labelled content (migration 047, B5-7). The label check and the insert run
// inside ONE writer transaction (Codex round 2, P3) — SQLite serializes
// writers, so a concurrent Revoke or relabel (both writes) cannot land
// between this transaction's read and its write, nor between the insert and
// answering whether there was anything to acknowledge. That closes the
// window a rows-affected-only answer couldn't: rows affected 0 means either
// "already acknowledged" (fine, idempotent) or "not labelled" (refuse), and
// resolving that with a SEPARATE post-insert read let a duplicate PUT racing
// a revoke of someone ELSE's row answer NOT_NSFW for a channel that is, at
// that very moment, still labelled.
//
// Hand-rolled rather than a sqlc query: sqlc's SQLite engine mis-slices the
// generated text for an INSERT ... SELECT ... FROM statement in this
// codebase's pinned version (v1.30.0) — it silently drops the final token of
// the statement and corrupts the NEXT query in the same file. Plain
// database/sql on the writer connection, like AdminUpdateChannelClearingNSFW
// below.
//
// labelled=false means channelID does not exist or is not labelled right
// now — ErrNotNSFW's case, whether or not a row already existed.
func (d *DB) AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (labelled bool, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var nsfw int64
	switch scanErr := tx.QueryRowContext(ctx, `SELECT nsfw FROM channels WHERE id = ?`, channelID).Scan(&nsfw); {
	case errors.Is(scanErr, sql.ErrNoRows):
		return false, nil
	case scanErr != nil:
		return false, fmt.Errorf("AcknowledgeNSFW label check: %w", scanErr)
	case nsfw == 0:
		return false, nil
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`,
		userID, channelID); err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW commit: %w", err)
	}
	committed = true
	return true, nil
}

// RevokeNSFW deletes userID's acknowledgement of channelID, taking effect on
// the caller's very next read — there is no cache to invalidate. Deleting a
// row that does not exist is a no-op, not an error — DELETE
// /nsfw-acknowledgement is idempotent.
func (d *DB) RevokeNSFW(ctx context.Context, userID, channelID int64) error {
	if err := d.q.RevokeNSFW(ctx, dbgen.RevokeNSFWParams{UserID: userID, ChannelID: channelID}); err != nil {
		return fmt.Errorf("RevokeNSFW: %w", err)
	}
	return nil
}

// HasNSFWAcknowledgement reports whether userID has acknowledged channelID.
// Every content path — REST reads, search, the socket, attachment bytes —
// asks this (or the batch form below) live, never from a cache, so a
// revocation takes effect on the very next call.
func (d *DB) HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error) {
	n, err := d.q.HasNSFWAcknowledgement(ctx, dbgen.HasNSFWAcknowledgementParams{UserID: userID, ChannelID: channelID})
	if err != nil {
		return false, fmt.Errorf("HasNSFWAcknowledgement: %w", err)
	}
	return n > 0, nil
}

// ListNSFWAcknowledgedUserIDs returns every user who has acknowledged
// channelID — the hub's one-batch-query-per-broadcast audience resolution
// for a labelled channel's content-bearing frames (ws/hub_visibility.go),
// taken only when the channel is labelled so an unlabelled one pays nothing.
func (d *DB) ListNSFWAcknowledgedUserIDs(ctx context.Context, channelID int64) ([]int64, error) {
	ids, err := d.q.ListNSFWAcknowledgedUserIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("ListNSFWAcknowledgedUserIDs: %w", err)
	}
	return ids, nil
}

// DeleteNSFWAcknowledgementsForChannel removes every acknowledgement of
// channelID — the label-lifecycle rule (service/channel_admin.go): clearing
// the nsfw flag deletes standing consent in the same transaction as the flag
// write, so a later re-label re-prompts everyone. Also used, indirectly via
// the FK cascade, when the channel itself is deleted.
func (d *DB) DeleteNSFWAcknowledgementsForChannel(ctx context.Context, channelID int64) error {
	if err := d.q.DeleteNSFWAcknowledgementsForChannel(ctx, channelID); err != nil {
		return fmt.Errorf("DeleteNSFWAcknowledgementsForChannel: %w", err)
	}
	return nil
}

// AdminUpdateChannelClearingNSFW is AdminUpdateChannel plus
// DeleteNSFWAcknowledgementsForChannel, both in one transaction: the flag
// write and the standing-consent clear must commit together, or a crash
// between them could leave the flag off with acknowledgements still on file
// (a later re-label would silently trust warnings issued for a DIFFERENT
// on/off cycle). Callers use this only when the update actually turns nsfw
// from 1 to 0 — turning it on writes nothing extra (decision 13's own
// comment: "flipping on writes nothing").
func (d *DB) AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u ChannelUpdate) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	q := d.q.WithTx(tx)
	if err := q.AdminUpdateChannel(ctx, dbgen.AdminUpdateChannelParams{
		Name:          u.Name,
		Topic:         strToNullPtr(u.Topic),
		Category:      strToNullPtr(u.Category),
		SlowMode:      int64(u.SlowMode),
		Position:      int64(u.Position),
		Archived:      b2i64(u.Archived),
		Nsfw:          b2i64(u.NSFW),
		VoiceMaxUsers: int64(u.VoiceMaxUsers),
		VoiceMaxVideo: int64(u.VoiceMaxVideo),
		ID:            id,
	}); err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW update: %w", err)
	}
	if err := q.DeleteNSFWAcknowledgementsForChannel(ctx, id); err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW clear acks: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("AdminUpdateChannelClearingNSFW commit: %w", err)
	}
	committed = true
	return nil
}
