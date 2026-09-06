package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// acknowledgeNSFWIfLabelledSQL is hand-rolled rather than a sqlc query
// (P2-2): sqlc's SQLite engine mis-slices the generated query text for an
// INSERT ... SELECT ... FROM statement in this codebase's pinned version —
// it silently drops the final token of the statement (reproduced against
// v1.30.0; corrupts the NEXT query in the same file too), so the generated
// constant would run a truncated, syntactically invalid statement. This is
// plain database/sql, exactly like the ExecContext/QueryRowContext escape
// hatch db.go already exposes for hand-rolled SQL.
//
// The label check and the insert are ONE statement: a concurrent unlabel
// landing between a separate check and a separate insert can no longer make
// a stale "yes" land after the flag (and any acknowledgement rows a
// clearing update deleted) turns off. The SELECT only produces a row, and
// so the INSERT only fires, when channels.id = ? currently has nsfw = 1.
const acknowledgeNSFWIfLabelledSQL = `
INSERT OR IGNORE INTO nsfw_acknowledgements (user_id, channel_id)
SELECT ?, ? FROM channels WHERE channels.id = ? AND channels.nsfw = 1`

// AcknowledgeNSFW records that userID has consented to see channelID's
// labelled content (migration 047, B5-7), atomically gated on the channel
// being labelled at the moment the statement runs (see
// acknowledgeNSFWIfLabelledSQL). Reports whether a row was actually
// inserted; rows affected 0 means either "already acknowledged" (INSERT OR
// IGNORE, idempotent) or "not labelled" — the caller (service.NSFWService)
// tells the two apart with a HasNSFWAcknowledgement read.
func (d *DB) AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (bool, error) {
	res, err := d.ExecContext(ctx, acknowledgeNSFWIfLabelledSQL, userID, channelID, channelID)
	if err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("AcknowledgeNSFW rows affected: %w", err)
	}
	return n > 0, nil
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
