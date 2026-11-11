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

// Group DM membership mutations. Each is a single write transaction on the
// one-connection writer pool, so every check inside it (membership, ownership,
// member count) is race-free: two callers on the same group run in turn and the
// second sees the first's commit.

var (
	ErrGroupDMFull       = errors.New("group DM is full")
	ErrNoNewGroupMembers = errors.New("no new group members")
	// ErrGroupDMBlockedPair means a new member and another new or current member
	// blocked each other (either direction), or a new member refuses the actor (DMs
	// off without trusting them, or an unaccepted request from the actor).
	ErrGroupDMBlockedPair = errors.New("blocked pair in group DM")
)

// GroupEventRow is a group DM system row as written: the messages row plus the group_event detail.
type GroupEventRow struct {
	MessageID    int64
	Kind         int64
	AuthorID     int64
	Content      string
	Timestamp    string
	TargetUserID int64
	Name         *string
	IconRemoved  bool
}

// GroupChange is the outcome of a membership or rename mutation.
type GroupChange struct {
	Rows      []GroupEventRow
	MemberIDs []int64
}

type groupEventSpec struct {
	channelID, authorID int64
	kind                int64
	content             string
	targetUserID        int64
	name                *string
	iconRemoved         bool
}

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

// insertGroupEventRow writes one group row (messages plus message_group_events) inside
// the caller's transaction; the only writer of kinds 2 to 6.
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
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM read_states WHERE channel_id = ? AND user_id = ?`, channelID, userID); err != nil {
		return fmt.Errorf("delete read state: %w", err)
	}
	return nil
}

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

// AddGroupDMMembers adds ids on behalf of actorID, who must be a member,
// writing one group_add row per added user. Existing members are skipped; if
// that leaves nobody it fails with ErrNoNewGroupMembers. Exceeding
// MaxGroupDMParticipants fails with ErrGroupDMFull and writes nothing; the
// count is taken in the transaction, so two adds that together pass the cap
// cannot both succeed. contentFor gives each row's fallback text.
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
		// Re-check blocks inside the transaction: a block or another add may have landed since
		// the service's check.
		if err := requireNoBlockedPair(ctx, tx, fresh, slices.Concat(members, fresh)); err != nil {
			return err
		}
		// Likewise a target that turned DMs off or holds an unaccepted request from the actor;
		// only the actor's trust counts.
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

// RemoveGroupDMMember removes targetID on behalf of ownerID, who must be a member and
// the owner (ErrForbidden otherwise), writing one group_remove row. A non-member
// target is ErrNotFound with no row; the owner leaving is LeaveGroupDM.
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

// TransferGroupDMOwner makes targetID the owner on behalf of ownerID. A non-member
// caller is ErrNotFound, a non-owner ErrForbidden; a non-member target is ErrNotFound,
// so dm_owner_id always names a member. It writes no row and returns the members after
// the change.
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

// SetGroupDMName sets (or, empty, clears) a group DM's name on behalf of actorID, who
// must be a member (ErrNotFound otherwise). A changed name writes a group_rename row;
// an unchanged one writes nothing.
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
