package db

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// CreateGroupDMChannel creates a group DM channel with the given participants
// (creator included) and opens it for all of them; ownerID must be one of them.
// It always creates: unlike a 1:1 DM there is no canonical channel between
// these people, who may want two separate groups. The insert runs in one
// transaction so a crash cannot leave a participant-less, undeletable channel.
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

	// The service's reachability check ran earlier; re-read it on the transaction
	// so a setting changed since writes no channel and no rows.
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

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel fetch new: %w", err)
	}
	return ch, nil
}

// LeaveGroupResult is what a group leave did.
type LeaveGroupResult struct {
	// Deleted is true when the leaver was the last member and the channel went
	// with them. No row is written then.
	Deleted bool
	// Row is the group_leave row, nil when the channel was deleted.
	Row *GroupEventRow
	// MemberIDs is who is still in the group, lowest id first.
	MemberIDs []int64
}

// LeaveGroupDM removes userID from a group DM's participant list, open list
// and read state, and reports what that did. content is the fallback text of
// the group_leave row.
//
// A leaver who is not (or no longer) a member gets ErrNotFound and nothing is
// written, so a leave racing an owner's remove yields exactly one of "left" or
// "removed". With members left, the tx hands the group to the lowest remaining
// member when the leaver owned it, and writes the row.
//
// When the last participant leaves, the channel row is deleted, since a
// participant-less DM is reachable by nobody; its messages and attachments
// cascade. Leaving is destructive for the last leaver only.
func (d *DB) LeaveGroupDM(ctx context.Context, userID, channelID int64, content string) (*LeaveGroupResult, error) {
	var out LeaveGroupResult
	err := d.inGroupTx(ctx, "LeaveGroupDM", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := removeGroupMember(ctx, tx, channelID, userID); err != nil {
			return err
		}

		// Owner invariant: a group with members has an owner who is a member. When
		// the leaver owned it, hand off to the lowest remaining member id.
		if err := ensureGroupDMOwner(ctx, tx, channelID); err != nil {
			return err
		}

		members, err := groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if len(members) == 0 {
			// Unlink attachments before the channel delete: messages.channel_id and
			// attachments.message_id cascade, which would destroy the attachment rows, the
			// only handle the orphan sweep (DeleteOrphanedAttachments) has on the files,
			// stranding them on disk. Setting message_id to NULL makes them ordinary
			// orphans the sweep reclaims.
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

// lowestMemberSQL is the SQL expression for the member a group falls to when
// it has no owner: the lowest member id not banned from the server, else the
// lowest member id. A banned account cannot sign in, so handing it the group
// would leave nobody able to remove members or pass ownership on.
// channelExpr is the channel id as an SQL expression.
func lowestMemberSQL(channelExpr string) string {
	return `COALESCE(
		(SELECT MIN(dp.user_id) FROM dm_participants dp JOIN users ON users.id = dp.user_id
		  WHERE dp.channel_id = ` + channelExpr + ` AND ` + notBannedClause + `),
		(SELECT MIN(user_id) FROM dm_participants WHERE channel_id = ` + channelExpr + `))`
}

// ensureGroupDMOwner keeps the owner invariant inside the caller's
// transaction: a group with at least one member has dm_owner_id naming a
// member. A missing or departed owner becomes the lowest remaining non-banned
// member id (lowestMemberSQL). Every membership-changing transaction runs it
// last. A group with no member left keeps NULL.
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
