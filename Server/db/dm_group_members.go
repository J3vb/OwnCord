package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Group DM membership mutations. Each one is a single write
// transaction on the one-connection writer pool, so every check made inside it
// (caller still a member, caller is the owner, target still a member, member
// count) is race-free: two callers on the same group run one after the other
// and the second sees the first's commit.

var (
	// ErrGroupDMFull means adding the users would take the group past
	// MaxGroupDMParticipants.
	ErrGroupDMFull = errors.New("group DM is full")
	// ErrNoNewGroupMembers means every user named by an add is already a member.
	ErrNoNewGroupMembers = errors.New("no new group members")
	// ErrGroupDMBlockedPair means a new member and another new member or a
	// current member have blocked each other (either direction), or a new
	// member refuses the actor (DMs off without trusting them, or an
	// unaccepted message request from the actor).
	ErrGroupDMBlockedPair = errors.New("blocked pair in group DM")
)

// GroupEventRow is a group DM system row as written: the messages row plus the
// detail the group_event block carries.
type GroupEventRow struct {
	MessageID int64
	// Kind is the stored messages.kind (MessageKindGroupAdd to MessageKindGroupIcon).
	Kind     int64
	AuthorID int64
	Content  string
	// Timestamp is messages.timestamp of the new row.
	Timestamp string
	// TargetUserID is the user an add or remove row names, else 0.
	TargetUserID int64
	// Name is the new group name of a rename row ("" = removed), else nil.
	Name *string
	// IconRemoved is true for an icon row that cleared the icon, false when it
	// set one (and for every other kind).
	IconRemoved bool
}

// GroupChange is the outcome of a membership or rename mutation.
type GroupChange struct {
	// Rows are the system rows the mutation wrote, in order. Empty when it
	// changed nothing observable (an unchanged rename).
	Rows []GroupEventRow
	// MemberIDs is who is in the group after the change, lowest id first.
	MemberIDs []int64
}

// groupEventSpec is the input of insertGroupEventRow.
type groupEventSpec struct {
	channelID, authorID int64
	kind                int64
	content             string
	targetUserID        int64
	name                *string
	iconRemoved         bool
}

// inGroupTx runs fn in one serializable write transaction and rolls back on
// any error. Errors keep their sentinel for errors.Is.
func (d *DB) inGroupTx(ctx context.Context, op string, fn func(tx *sql.Tx, q *dbgen.Queries) error) error {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("%s begin tx: %w", op, err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	if err = fn(tx, d.q.WithTx(tx)); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("%s commit: %w", op, err)
	}
	return nil
}

// insertGroupEventRow writes one group row (messages plus message_group_events)
// inside the caller's transaction. It is the only writer of kinds 2 to 6.
func insertGroupEventRow(ctx context.Context, q *dbgen.Queries, spec groupEventSpec) (*GroupEventRow, error) {
	m, err := q.InsertGroupEventMessage(ctx, dbgen.InsertGroupEventMessageParams{
		ChannelID: spec.channelID, UserID: spec.authorID, Content: spec.content, Kind: spec.kind,
	})
	if err != nil {
		return nil, fmt.Errorf("insert group row: %w", err)
	}
	var target *int64
	if spec.targetUserID != 0 {
		target = &spec.targetUserID
	}
	var iconRemoved int64
	if spec.iconRemoved {
		iconRemoved = 1
	}
	if err = q.InsertMessageGroupEvent(ctx, dbgen.InsertMessageGroupEventParams{
		MessageID: m.ID, TargetUserID: target, Name: spec.name, IconRemoved: iconRemoved,
	}); err != nil {
		return nil, fmt.Errorf("insert group event: %w", err)
	}
	return &GroupEventRow{
		MessageID: m.ID, Kind: spec.kind, AuthorID: spec.authorID, Content: spec.content,
		Timestamp: m.Timestamp, TargetUserID: spec.targetUserID, Name: spec.name,
		IconRemoved: spec.iconRemoved,
	}, nil
}

// groupMemberIDs lists a channel's members, lowest id first.
func groupMemberIDs(ctx context.Context, tx *sql.Tx, channelID int64) ([]int64, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT user_id FROM dm_participants WHERE channel_id = ? ORDER BY user_id`, channelID)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	defer func() { _ = rows.Close() }() //nolint:errcheck // read-only cursor

	var ids []int64
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan member: %w", err)
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	return ids, nil
}

// requireGroupMember returns ErrNotFound unless userID is a member of the group
// DM channelID. A 1:1 channel counts as "not found" too: these mutations
// concern groups only, and the service has already answered 400 for a 1:1.
func requireGroupMember(ctx context.Context, tx *sql.Tx, channelID, userID int64) error {
	var one int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM dm_participants dp JOIN channels c ON c.id = dp.channel_id
		  WHERE dp.channel_id = ? AND dp.user_id = ? AND c.type = 'dm' AND c.is_group = 1`,
		channelID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("user %d is not in group %d: %w", userID, channelID, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("check member: %w", err)
	}
	return nil
}

// removeGroupMember deletes userID's participant, open-state and read-state
// rows. No participant row to delete is ErrNotFound: the member already left
// or was removed, and the caller must write no system row for it.
func removeGroupMember(ctx context.Context, tx *sql.Tx, channelID, userID int64) error {
	res, err := tx.ExecContext(ctx,
		`DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?`, channelID, userID)
	if err != nil {
		return fmt.Errorf("remove participant: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("remove participant rows: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("user %d is not in group %d: %w", userID, channelID, ErrNotFound)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM dm_open_state WHERE channel_id = ? AND user_id = ?`, channelID, userID); err != nil {
		return fmt.Errorf("close dm: %w", err)
	}
	// The unread state of a room the user is no longer in is dead weight, and
	// a later re-add must start from a clean pointer.
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM read_states WHERE channel_id = ? AND user_id = ?`, channelID, userID); err != nil {
		return fmt.Errorf("delete read state: %w", err)
	}
	return nil
}

// requireNoBlockedPair returns ErrGroupDMBlockedPair when any of fresh has
// blocked, or is blocked by, anyone in all (one query on the transaction).
func requireNoBlockedPair(ctx context.Context, tx *sql.Tx, fresh, all []int64) error {
	marks := func(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }
	args := make([]any, 0, 2*(len(fresh)+len(all)))
	for _, set := range [][]int64{fresh, all, fresh, all} {
		for _, id := range set {
			args = append(args, id)
		}
	}
	//nolint:gosec // G202: only "?" placeholders are concatenated, ids are bound
	query := `SELECT EXISTS (SELECT 1 FROM user_blocks
	   WHERE (blocker_id IN (` + marks(len(fresh)) + `) AND blocked_id IN (` + marks(len(all)) + `))
	      OR (blocked_id IN (` + marks(len(fresh)) + `) AND blocker_id IN (` + marks(len(all)) + `)))`
	var blocked bool
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&blocked); err != nil {
		return fmt.Errorf("check blocks: %w", err)
	}
	if blocked {
		return ErrGroupDMBlockedPair
	}
	return nil
}

// AddGroupDMMembers adds ids to a group DM on behalf of actorID, who must be a
// member, and writes one group_add row per added user (author = actor,
// target = the added user). Users who are already members are skipped; if that
// leaves nobody the call fails with ErrNoNewGroupMembers. A group that would
// exceed MaxGroupDMParticipants fails with ErrGroupDMFull and writes nothing:
// the count is taken inside the transaction, so two adds that together pass
// the cap cannot both succeed. contentFor gives each row's fallback text.
func (d *DB) AddGroupDMMembers(ctx context.Context, channelID, actorID int64, ids []int64, contentFor func(targetID int64) string) (*GroupChange, error) {
	var out GroupChange
	err := d.inGroupTx(ctx, "AddGroupDMMembers", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := requireGroupMember(ctx, tx, channelID, actorID); err != nil {
			return err
		}
		members, err := groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		var fresh []int64
		for _, id := range ids {
			if !slices.Contains(members, id) && !slices.Contains(fresh, id) {
				fresh = append(fresh, id)
			}
		}
		if len(fresh) == 0 {
			return ErrNoNewGroupMembers
		}
		if len(members)+len(fresh) > MaxGroupDMParticipants {
			return ErrGroupDMFull
		}
		// Re-check blocks inside the transaction: the service's check ran
		// earlier, and a block or another add may have landed since.
		if err := requireNoBlockedPair(ctx, tx, fresh, slices.Concat(members, fresh)); err != nil {
			return err
		}
		// Likewise a target that has turned DMs off since, or that the actor
		// holds an unaccepted request to. Only the actor's trust counts.
		if err := requireReachableTargets(ctx, tx, actorID, fresh); err != nil {
			return err
		}

		var last *GroupEventRow
		for _, id := range fresh {
			if _, err = tx.ExecContext(ctx,
				`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, channelID, id); err != nil {
				return fmt.Errorf("insert participant: %w", err)
			}
			if _, err = tx.ExecContext(ctx,
				`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`, id, channelID); err != nil {
				return fmt.Errorf("open dm: %w", err)
			}
			last, err = insertGroupEventRow(ctx, q, groupEventSpec{
				channelID: channelID, authorID: actorID, kind: MessageKindGroupAdd,
				content: contentFor(id), targetUserID: id,
			})
			if err != nil {
				return err
			}
			out.Rows = append(out.Rows, *last)
		}
		if err := ensureGroupDMOwner(ctx, tx, channelID); err != nil {
			return err
		}
		// The actor's own rows are not unread to them.
		advanceAuthorReadState(ctx, q, actorID, channelID, last.MessageID)

		out.MemberIDs = slices.Concat(members, fresh)
		slices.Sort(out.MemberIDs)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveGroupDMMember removes targetID from a group DM on behalf of ownerID,
// who must be a member and the group's owner (ErrForbidden otherwise), and
// writes one group_remove row (author = owner, target = the removed user). A
// target who is not a member, including one who just left, is ErrNotFound and
// writes no row. The owner cannot remove themselves here: that is a leave.
func (d *DB) RemoveGroupDMMember(ctx context.Context, channelID, ownerID, targetID int64, content string) (*GroupChange, error) {
	var out GroupChange
	err := d.inGroupTx(ctx, "RemoveGroupDMMember", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := requireGroupOwner(ctx, tx, channelID, ownerID); err != nil {
			return err
		}
		if targetID == ownerID {
			return fmt.Errorf("the owner leaves instead of removing themselves: %w", ErrForbidden)
		}
		if err := removeGroupMember(ctx, tx, channelID, targetID); err != nil {
			return err
		}
		row, err := insertGroupEventRow(ctx, q, groupEventSpec{
			channelID: channelID, authorID: ownerID, kind: MessageKindGroupRemove,
			content: content, targetUserID: targetID,
		})
		if err != nil {
			return err
		}
		if err := ensureGroupDMOwner(ctx, tx, channelID); err != nil {
			return err
		}
		advanceAuthorReadState(ctx, q, ownerID, channelID, row.MessageID)

		out.Rows = []GroupEventRow{*row}
		out.MemberIDs, err = groupMemberIDs(ctx, tx, channelID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// requireGroupOwner checks, inside the caller's transaction, that userID is a
// member of the group and its owner: ErrNotFound for a non-member, ErrForbidden
// for a member who is not the owner.
func requireGroupOwner(ctx context.Context, tx *sql.Tx, channelID, userID int64) error {
	if err := requireGroupMember(ctx, tx, channelID, userID); err != nil {
		return err
	}
	var owner sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT dm_owner_id FROM channels WHERE id = ?`, channelID).Scan(&owner); err != nil {
		return fmt.Errorf("read owner: %w", err)
	}
	if !owner.Valid || owner.Int64 != userID {
		return fmt.Errorf("user %d does not own group %d: %w", userID, channelID, ErrForbidden)
	}
	return nil
}

// TransferGroupDMOwner makes targetID the owner of a group DM on behalf of the
// current owner ownerID. A caller who is not a member is ErrNotFound and a
// member who is not the owner is ErrForbidden. A target who is not a member is
// ErrNotFound and the owner is unchanged, so dm_owner_id always names a
// current member. It writes no row. It returns the members after the change.
func (d *DB) TransferGroupDMOwner(ctx context.Context, channelID, ownerID, targetID int64) ([]int64, error) {
	var members []int64
	err := d.inGroupTx(ctx, "TransferGroupDMOwner", func(tx *sql.Tx, _ *dbgen.Queries) error {
		if err := requireGroupOwner(ctx, tx, channelID, ownerID); err != nil {
			return err
		}
		if err := requireGroupMember(ctx, tx, channelID, targetID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE channels SET dm_owner_id = ? WHERE id = ? AND is_group = 1`, targetID, channelID); err != nil {
			return fmt.Errorf("set owner: %w", err)
		}
		var err error
		members, err = groupMemberIDs(ctx, tx, channelID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return members, nil
}

// SetGroupDMName sets (or, with an empty name, clears) a group DM's name on
// behalf of actorID, who must be a member (ErrNotFound otherwise). The name is
// compared inside the transaction: a changed name writes a group_rename row
// (author = actor, name = the new name, content = the fallback text) and an
// unchanged one writes nothing and returns no rows.
func (d *DB) SetGroupDMName(ctx context.Context, channelID, actorID int64, name, content string) (*GroupChange, error) {
	var out GroupChange
	err := d.inGroupTx(ctx, "SetGroupDMName", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := requireGroupMember(ctx, tx, channelID, actorID); err != nil {
			return err
		}
		var current string
		if err := tx.QueryRowContext(ctx, `SELECT name FROM channels WHERE id = ?`, channelID).Scan(&current); err != nil {
			return fmt.Errorf("read name: %w", err)
		}
		var err error
		out.MemberIDs, err = groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if current == name {
			return nil
		}
		if _, err = tx.ExecContext(ctx, `UPDATE channels SET name = ? WHERE id = ?`, name, channelID); err != nil {
			return fmt.Errorf("set name: %w", err)
		}
		row, err := insertGroupEventRow(ctx, q, groupEventSpec{
			channelID: channelID, authorID: actorID, kind: MessageKindGroupRename,
			content: content, name: &name,
		})
		if err != nil {
			return err
		}
		advanceAuthorReadState(ctx, q, actorID, channelID, row.MessageID)
		out.Rows = []GroupEventRow{*row}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}
