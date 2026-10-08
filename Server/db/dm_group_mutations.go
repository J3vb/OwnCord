package db

import (
	"context"
	"database/sql"
	"fmt"
)

// ─── Group DM mutation ──────────────────────────────────────────────────────

// CreateGroupDMChannel creates a new group DM channel with the given
// participants (creator included in participantIDs) and opens it for all of
// them. It always creates: unlike a 1:1 DM there is no canonical "the DM
// between these people", because the same set of people may reasonably want
// two separate groups.
//
// The whole insert runs in one transaction so a crash cannot leave a channel
// with no participants — which would be an unreachable, undeletable row.
func (d *DB) CreateGroupDMChannel(ctx context.Context, name string, participantIDs []int64) (*Channel, error) {
	if len(participantIDs) < 3 {
		return nil, fmt.Errorf("CreateGroupDMChannel: need at least 3 participants, got %d", len(participantIDs))
	}
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	res, err := tx.ExecContext(ctx, `INSERT INTO channels (name, type, is_group) VALUES (?, 'dm', 1)`, name)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel last insert id: %w", err)
	}

	for _, pid := range participantIDs {
		if _, err = tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO dm_participants (channel_id, user_id) VALUES (?, ?)`,
			channelID, pid,
		); err != nil {
			return nil, fmt.Errorf("CreateGroupDMChannel insert participant: %w", err)
		}
		if _, err = tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			pid, channelID,
		); err != nil {
			return nil, fmt.Errorf("CreateGroupDMChannel open dm: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel fetch new: %w", err)
	}
	return ch, nil
}

// LeaveGroupDM removes userID from a group DM's participant list and from
// their open list, and reports whether that emptied the channel.
//
// When the last participant leaves, the channel row is deleted: a DM channel
// with no participants is reachable by nobody and would sit in the database
// forever, and its messages/attachments cascade off the channels row. Leaving
// is therefore destructive for the last leaver only — everyone else's leave is
// just a removal.
func (d *DB) LeaveGroupDM(ctx context.Context, userID, channelID int64) (deleted bool, err error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return false, fmt.Errorf("LeaveGroupDM begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	if _, err = tx.ExecContext(ctx,
		`DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?`, channelID, userID,
	); err != nil {
		return false, fmt.Errorf("LeaveGroupDM remove participant: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM dm_open_state WHERE channel_id = ? AND user_id = ?`, channelID, userID,
	); err != nil {
		return false, fmt.Errorf("LeaveGroupDM close dm: %w", err)
	}

	var remaining int
	if err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?`, channelID,
	).Scan(&remaining); err != nil {
		return false, fmt.Errorf("LeaveGroupDM count: %w", err)
	}
	if remaining == 0 {
		// Unlink attachments before the channel delete below: messages.channel_id
		// and attachments.message_id both cascade ON DELETE (migrations/001), so
		// without this the cascade destroys the attachment rows along with the
		// channel — the only handle the orphan sweep (main.go's maintenance
		// tick, DeleteOrphanedAttachments) has on the uploaded files, stranding
		// them on disk forever. Setting message_id to NULL first turns them
		// into ordinary orphaned attachments the sweep already reclaims.
		if _, err = tx.ExecContext(ctx,
			`UPDATE attachments SET message_id = NULL
			   WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)`,
			channelID,
		); err != nil {
			return false, fmt.Errorf("LeaveGroupDM unlink attachments: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, channelID); err != nil {
			return false, fmt.Errorf("LeaveGroupDM delete channel: %w", err)
		}
		deleted = true
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("LeaveGroupDM commit: %w", err)
	}
	return deleted, nil
}
