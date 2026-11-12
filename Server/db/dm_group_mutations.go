package db

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// groupDMReadBackTimeout bounds the read of a just-committed group, which no longer follows the
// caller's context.
const groupDMReadBackTimeout = 5 * time.Second

// groupDMPostCommitHookForTest runs right after a group create commits.
var groupDMPostCommitHookForTest func()

// CreateGroupDMChannel creates a group DM with the given participants (creator
// included) and opens it for all; ownerID must be one of them. It always creates, in
// one transaction, so a crash cannot leave a participant-less channel.
func (d *DB) CreateGroupDMChannel(ctx context.Context, name string, ownerID int64, participantIDs []int64) (*Channel, error) {
	if len(participantIDs) < 3 {
		return nil, fmt.Errorf("CreateGroupDMChannel: need at least 3 participants, got %d", len(participantIDs))
	}
	if !slices.Contains(participantIDs, ownerID) {
		return nil, fmt.Errorf("CreateGroupDMChannel: owner %d is not a participant", ownerID)
	}
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	// Re-read reachability on the transaction so a setting changed since the service's
	// check writes nothing.
	if err := requireReachableTargets(ctx, tx, ownerID, slices.DeleteFunc(slices.Clone(participantIDs), func(id int64) bool { return id == ownerID })); err != nil {
		return nil, err
	}

	res, err := tx.ExecContext(ctx, `INSERT INTO channels (name, type, is_group, dm_owner_id) VALUES (?, 'dm', 1, ?)`, name, ownerID)
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

	if hook := groupDMPostCommitHookForTest; hook != nil {
		hook()
	}

	// Committed: a caller cancelled from here on must still get the channel, since reporting
	// failure for a persisted group invites a retry that creates a second one.
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), groupDMReadBackTimeout)
	defer cancel()
	ch, err := d.GetChannel(readCtx, channelID)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel fetch new: %w", err)
	}
	return ch, nil
}

// LeaveGroupResult is what a group leave did.
type LeaveGroupResult struct {
	// Deleted is true when the leaver was the last member and the channel went with them;
	// no row is written.
	Deleted   bool
	Row       *GroupEventRow
	MemberIDs []int64
}

// LeaveGroupDM removes userID from a group DM's participant list, open list and read
// state; content is the fallback text of the group_leave row. A non-member gets
// ErrNotFound and nothing is written, so a leave racing an owner's remove yields
// exactly one of "left" or "removed". The group passes to the lowest remaining member
// when the leaver owned it. When the last participant leaves the channel row is
// deleted and its messages and attachments cascade.
func (d *DB) LeaveGroupDM(ctx context.Context, userID, channelID int64, content string) (*LeaveGroupResult, error) {
	var out LeaveGroupResult
	err := d.inGroupTx(ctx, "LeaveGroupDM", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := removeGroupMember(ctx, tx, channelID, userID); err != nil {
			return err
		}

		if err := ensureGroupDMOwner(ctx, tx, channelID); err != nil {
			return err
		}

		members, err := groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if len(members) == 0 {
			// Unlink attachments before the channel delete: the cascade would destroy the
			// attachment rows, the only handle the orphan sweep has on the files, stranding
			// them on disk; NULL message_id makes them ordinary orphans.
			if _, err = tx.ExecContext(ctx,
				`UPDATE attachments SET message_id = NULL
				   WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)`,
				channelID,
			); err != nil {
				return fmt.Errorf("unlink attachments: %w", err)
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, channelID); err != nil {
				return fmt.Errorf("delete channel: %w", err)
			}
			out = LeaveGroupResult{Deleted: true}
			return nil
		}

		row, err := insertGroupEventRow(ctx, q, groupEventSpec{
			channelID: channelID, authorID: userID, kind: MessageKindGroupLeave, content: content,
		})
		if err != nil {
			return err
		}
		out = LeaveGroupResult{Row: row, MemberIDs: members}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// lowestMemberSQL is the member a group falls to without an owner: the lowest
// id not banned, else the lowest id (a banned account cannot sign in to manage the group).
func lowestMemberSQL(channelExpr string) string {
	return `COALESCE(
		(SELECT MIN(dp.user_id) FROM dm_participants dp JOIN users ON users.id = dp.user_id
		  WHERE dp.channel_id = ` + channelExpr + ` AND ` + notBannedClause + `),
		(SELECT MIN(user_id) FROM dm_participants WHERE channel_id = ` + channelExpr + `))`
}

// ensureGroupDMOwner keeps dm_owner_id naming a member in the caller's transaction,
// falling to the lowest non-banned member; every membership change runs it last.
func ensureGroupDMOwner(ctx context.Context, tx *sql.Tx, channelID int64) error {
	//nolint:gosec // G202: lowestMemberSQL joins constant fragments, no caller input reaches the text
	if _, err := tx.ExecContext(ctx,
		`UPDATE channels SET dm_owner_id = `+lowestMemberSQL("?1")+`
		  WHERE id = ?1 AND is_group = 1
		    AND (dm_owner_id IS NULL OR dm_owner_id NOT IN (SELECT user_id FROM dm_participants WHERE channel_id = ?1))`,
		channelID,
	); err != nil {
		return fmt.Errorf("ensureGroupDMOwner: %w", err)
	}
	return nil
}
