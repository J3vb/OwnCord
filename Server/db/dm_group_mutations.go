package db

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ─── Group DM mutation ──────────────────────────────────────────────────────

// CreateGroupDMChannel creates a new group DM channel with the given
// participants (creator included in participantIDs) and opens it for all of
// them. ownerID names the group's owner and must be one of them. It always
// creates: unlike a 1:1 DM there is no canonical "the DM
// between these people", because the same set of people may reasonably want
// two separate groups.
//
// The whole insert runs in one transaction so a crash cannot leave a channel
// with no participants — which would be an unreachable, undeletable row.
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

// LeaveGroupDM removes userID from a group DM's participant list, from their
// open list and from their read state, and reports what that did. content is
// the fallback text of the group_leave row.
//
// A leaver who is not (or no longer) a member gets ErrNotFound and nothing is
// written, so a leave that races an owner's remove yields exactly one of
// "left" or "removed". With members left the tx also hands the group to the
// lowest remaining member when the leaver owned it, and writes the row.
//
// When the last participant leaves, the channel row is deleted: a DM channel
// with no participants is reachable by nobody and would sit in the database
// forever, and its messages/attachments cascade off the channels row. Leaving
// is therefore destructive for the last leaver only. Everyone else's leave is
// a removal plus a row.
func (d *DB) LeaveGroupDM(ctx context.Context, userID, channelID int64, content string) (*LeaveGroupResult, error) {
	var out LeaveGroupResult
	err := d.inGroupTx(ctx, "LeaveGroupDM", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := removeGroupMember(ctx, tx, channelID, userID); err != nil {
			return err
		}

		// The owner invariant: a group with members has an owner who is a member.
		// When the leaver was the owner this is the hand-off to the lowest
		// remaining member id; for anyone else it changes nothing.
		if err := ensureGroupDMOwner(ctx, tx, channelID); err != nil {
			return err
		}

		members, err := groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if len(members) == 0 {
			// Unlink attachments before the channel delete below: messages.channel_id
			// and attachments.message_id both cascade ON DELETE (migrations/001), so
			// without this the cascade destroys the attachment rows along with the
			// channel, the only handle the orphan sweep (main.go's maintenance
			// tick, DeleteOrphanedAttachments) has on the uploaded files, stranding
			// them on disk forever. Setting message_id to NULL first turns them
			// into ordinary orphaned attachments the sweep already reclaims.
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
// it has no owner: the lowest member id that is not banned from the server,
// else the lowest member id. A banned account cannot sign in, so handing the
// group to one would leave nobody able to remove members or pass ownership on.
// channelExpr is the channel id as an SQL expression.
func lowestMemberSQL(channelExpr string) string {
	return `COALESCE(
		(SELECT MIN(dp.user_id) FROM dm_participants dp JOIN users ON users.id = dp.user_id
		  WHERE dp.channel_id = ` + channelExpr + ` AND ` + notBannedClause + `),
		(SELECT MIN(user_id) FROM dm_participants WHERE channel_id = ` + channelExpr + `))`
}

// ensureGroupDMOwner keeps the group owner invariant inside the caller's
// transaction: a group with at least one member has dm_owner_id naming a
// member. A missing or departed owner becomes the lowest remaining member id
// that is not banned (lowestMemberSQL), which is deterministic and needs no
// input. Every transaction that changes a group's membership runs it last. A
// group with no member left keeps NULL.
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
