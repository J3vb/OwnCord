package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

type groupManagementStore interface {
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	AddGroupDMMembers(ctx context.Context, channelID, actorID int64, ids []int64, contentFor func(targetID int64) string) (*db.GroupChange, error)
	RemoveGroupDMMember(ctx context.Context, channelID, ownerID, targetID int64, content string) (*db.GroupChange, error)
	TransferGroupDMOwner(ctx context.Context, channelID, ownerID, targetID int64) ([]int64, error)
	SetGroupDMName(ctx context.Context, channelID, actorID int64, name, content string) (*db.GroupChange, error)
	SetGroupDMIcon(ctx context.Context, channelID, actorID int64, iconID *string, content string) (*db.GroupChange, error)
}

type groupManagement struct {
	st    groupManagementStore
	perms *PermissionService
}

// MaxGroupDMAddPerCall is how many users one add may name (the cap of 10 less the adder).
const MaxGroupDMAddPerCall = db.MaxGroupDMParticipants - 1

type groupDMFullError struct{}

func (groupDMFullError) Error() string { return "group DM is full" }
func (groupDMFullError) Unwrap() error { return ErrConflict }

// ErrGroupDMFull means an add would pass db.MaxGroupDMParticipants; it wraps ErrConflict, refined into the
// GROUP_DM_FULL wire code.
var ErrGroupDMFull error = groupDMFullError{}

// GroupEventRow is one group DM system row with its author resolved, ready for the hub's chat_message frame.
type GroupEventRow struct {
	MessageID int64
	// Kind is the wire name (group_add, group_remove, group_leave, group_rename, group_icon).
	Kind       string
	Author     *db.User
	AuthorRole string
	// Content is the English fallback sentence only old clients show.
	Content      string
	Timestamp    string
	TargetUserID int64
	Name         *string
	IconRemoved  bool
}

// GroupChangeResult is what a membership or rename mutation tells its caller: rows to fan out and who
// receives them.
type GroupChangeResult struct {
	Rows []GroupEventRow
	// Audience is the members after the change, lowest id first; rows and the refreshed dm_channel_open go to
	// them.
	Audience []int64
	Added    []int64
}

// dedupeGroupRecipients drops repeats and the caller and rejects a non-positive id. A
// duplicate is a client bug, not a refusal, but must not inflate the participant count or double-insert.
func dedupeGroupRecipients(ids []int64, callerID int64) ([]int64, error) {
	seen := map[int64]bool{callerID: true}
	unique := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, fmt.Errorf("%w: user ids must be positive", ErrBadRequest)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	return unique, nil
}

// groupReachabilityReader is the one extra read the reachability check needs; kept out of
// Store (the method ratchet), and a Store lacking it fails closed.
type groupReachabilityReader interface {
	GroupDMTargetsRefuse(ctx context.Context, actorID int64, targets []int64) (bool, error)
}

// validateGroupRecipients is the check create and add share. Every target must be
// dmReachableUser (missing, banned or non-active is "not found"); no pair involving a
// target may be blocked either way, against other targets or people already in the room;
// each target must be reachable by actorID (not DMs-off without trusting the actor, no
// unaccepted request from the actor), staff included. Every cause gives the one refusal,
// never naming the target. Pairs already in the room are not re-checked.
func (s *groupManagement) validateGroupRecipients(ctx context.Context, actorID int64, targets, others []int64) ([]*db.User, error) {
	users := make([]*db.User, 0, len(targets))
	for _, rid := range targets {
		user, err := s.st.GetUserByID(ctx, rid)
		if err != nil || user == nil {
			return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
		}
		if !dmReachableUser(user) {
			return nil, fmt.Errorf("%w: recipient not found", ErrNotFound)
		}
		users = append(users, user)
	}

	for i, t := range targets {
		peers := make([]int64, 0, len(others)+len(targets)-i-1)
		peers = append(peers, others...)
		peers = append(peers, targets[i+1:]...)
		for _, p := range peers {
			blocked, err := s.st.IsEitherBlocked(ctx, t, p)
			if err != nil {
				return nil, fmt.Errorf("%w: failed to check block status: %w", ErrInternal, err)
			}
			if blocked {
				return nil, fmt.Errorf("%w: cannot add this user to a group DM", ErrForbidden)
			}
		}
	}

	reader, ok := s.st.(groupReachabilityReader)
	if !ok {
		return nil, fmt.Errorf("%w: store has no group reachability read", ErrInternal)
	}
	refused, err := reader.GroupDMTargetsRefuse(ctx, actorID, targets)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check DM privacy: %w", ErrInternal, err)
	}
	if refused {
		return nil, fmt.Errorf("%w: cannot add this user to a group DM", ErrForbidden)
	}
	return users, nil
}

func groupActorName(u *db.User) string {
	if name := u.EffectiveDisplayName(); name != "" {
		return name
	}
	return "Someone"
}

func groupAddContent(actor, target *db.User) string {
	return fmt.Sprintf("%s added %s to the group.", groupActorName(actor), groupActorName(target))
}

func groupRemoveContent(actor, target *db.User) string {
	return fmt.Sprintf("%s removed %s from the group.", groupActorName(actor), groupActorName(target))
}

func groupLeaveContent(actor *db.User) string {
	return fmt.Sprintf("%s left the group.", groupActorName(actor))
}

func groupRenameContent(actor *db.User, name string) string {
	if name == "" {
		return fmt.Sprintf("%s removed the group name.", groupActorName(actor))
	}
	return fmt.Sprintf("%s changed the group name to %s.", groupActorName(actor), name)
}

func groupIconContent(actor *db.User, removed bool) string {
	if removed {
		return fmt.Sprintf("%s removed the group icon.", groupActorName(actor))
	}
	return fmt.Sprintf("%s changed the group icon.", groupActorName(actor))
}

func (s *groupManagement) groupRows(ctx context.Context, rows []db.GroupEventRow) []GroupEventRow {
	type authorInfo struct {
		user *db.User
		role string
	}
	authors := make(map[int64]authorInfo, 2)
	out := make([]GroupEventRow, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		a, ok := authors[r.AuthorID]
		if !ok {
			a = authorInfo{user: &db.User{ID: r.AuthorID}}
			if u, err := s.st.GetUserByID(ctx, r.AuthorID); err == nil && u != nil {
				a.user = u
				if role, rErr := s.st.GetRoleByID(ctx, u.RoleID); rErr == nil && role != nil {
					a.role = role.Name
				}
			} else {
				slog.Warn("group row: author lookup failed", "author_id", r.AuthorID, "err", err)
			}
			authors[r.AuthorID] = a
		}
		out = append(out, GroupEventRow{
			MessageID: r.MessageID, Kind: db.MessageKindName(r.Kind),
			Author: a.user, AuthorRole: a.role,
			Content: r.Content, Timestamp: r.Timestamp,
			TargetUserID: r.TargetUserID, Name: r.Name, IconRemoved: r.IconRemoved,
		})
	}
	return out
}

func mapGroupDBError(what string, err error) error {
	switch {
	case errors.Is(err, db.ErrGroupDMFull):
		return fmt.Errorf("%w: a group DM holds at most %d users", ErrGroupDMFull, db.MaxGroupDMParticipants)
	case errors.Is(err, db.ErrGroupDMBlockedPair):
		return fmt.Errorf("%w: cannot add this user to a group DM", ErrForbidden)
	case errors.Is(err, db.ErrNoNewGroupMembers):
		return fmt.Errorf("%w: every user is already in this group", ErrBadRequest)
	case errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("%w: not found in this group DM", ErrNotFound)
	case errors.Is(err, db.ErrForbidden):
		return fmt.Errorf("%w: only the group owner can do that", ErrForbidden)
	default:
		return fmt.Errorf("%w: %s: %w", ErrInternal, what, err)
	}
}

// requireGroupActor is the gate every group mutation starts with: a member (anyone else
// gets not found), not timed out, in a group channel (a 1:1 answers 400).
func (s *groupManagement) requireGroupActor(ctx context.Context, userID, channelID int64) error {
	if channelID <= 0 {
		return fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	// These publish to the other members: text of the caller's own.
	if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
		return err
	}
	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return fmt.Errorf("%w: failed to read DM kind: %w", ErrInternal, err)
	}
	if !isGroup {
		return fmt.Errorf("%w: only group DMs have members to manage", ErrBadRequest)
	}
	return nil
}

// AddGroupMembers adds users on behalf of any member: 1..MaxGroupDMAddPerCall ids; users
// already in are skipped (none left is a 400). The group may not pass
// db.MaxGroupDMParticipants (ErrGroupDMFull), counted inside the transaction. A target
// that blocks DMs from non-trusted members or holds an unaccepted request from the caller
// refuses the whole call (403).
func (s *groupManagement) AddGroupMembers(ctx context.Context, actorID, channelID int64, userIDs []int64) (*GroupChangeResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.AddGroupMembers",
		telemetry.Int64("user_id", actorID),
		telemetry.Int64("channel_id", channelID),
	)
	defer done()

	if len(userIDs) == 0 || len(userIDs) > MaxGroupDMAddPerCall {
		return nil, fmt.Errorf("%w: user_ids must name 1 to %d users", ErrBadRequest, MaxGroupDMAddPerCall)
	}
	ids, err := dedupeGroupRecipients(userIDs, 0)
	if err != nil {
		return nil, err
	}
	if err := s.requireGroupActor(ctx, actorID, channelID); err != nil {
		return nil, err
	}

	members, err := s.st.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM participants: %w", ErrInternal, err)
	}
	fresh := make([]int64, 0, len(ids))
	for _, id := range ids {
		if !slices.Contains(members, id) {
			fresh = append(fresh, id)
		}
	}
	if len(fresh) == 0 {
		return nil, fmt.Errorf("%w: every user is already in this group", ErrBadRequest)
	}

	users, err := s.validateGroupRecipients(ctx, actorID, fresh, members)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]*db.User, len(users))
	for _, u := range users {
		byID[u.ID] = u
	}
	actor, _ := s.st.GetUserByID(ctx, actorID) //nolint:errcheck // a failed lookup only changes the fallback text

	change, err := s.st.AddGroupDMMembers(ctx, channelID, actorID, fresh, func(targetID int64) string {
		return groupAddContent(actor, byID[targetID])
	})
	if err != nil {
		return nil, mapGroupDBError("failed to add group members", err)
	}
	// Committed: the reads below must not fail because the client hung up.
	ctx = context.WithoutCancel(ctx)
	added := make([]int64, 0, len(change.Rows))
	for i := range change.Rows {
		added = append(added, change.Rows[i].TargetUserID)
	}
	return &GroupChangeResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs, Added: added}, nil
}

// RemoveGroupMember removes targetID on behalf of the owner. Removing yourself is 400, a
// non-owner caller 403, a non-member caller or target 404. Rows go to the remaining members.
func (s *groupManagement) RemoveGroupMember(ctx context.Context, ownerID, channelID, targetID int64) (*GroupChangeResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.RemoveGroupMember",
		telemetry.Int64("user_id", ownerID),
		telemetry.Int64("channel_id", channelID),
	)
	defer done()

	if targetID <= 0 {
		return nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if err := s.requireGroupActor(ctx, ownerID, channelID); err != nil {
		return nil, err
	}
	if targetID == ownerID {
		return nil, fmt.Errorf("%w: use leave to remove yourself", ErrBadRequest)
	}
	owner, _ := s.st.GetUserByID(ctx, ownerID)   //nolint:errcheck // a failed lookup only changes the fallback text
	target, _ := s.st.GetUserByID(ctx, targetID) //nolint:errcheck // a failed lookup only changes the fallback text

	change, err := s.st.RemoveGroupDMMember(ctx, channelID, ownerID, targetID, groupRemoveContent(owner, target))
	if err != nil {
		return nil, mapGroupDBError("failed to remove group member", err)
	}
	// Committed: the reads below must not fail because the client hung up.
	ctx = context.WithoutCancel(ctx)
	return &GroupChangeResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs}, nil
}

// TransferGroupOwner makes targetID the owner on behalf of the current owner. Writes no
// row; Audience gets a refreshed dm_channel_open with the new owner_id.
func (s *groupManagement) TransferGroupOwner(ctx context.Context, ownerID, channelID, targetID int64) (*GroupChangeResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.TransferGroupOwner",
		telemetry.Int64("user_id", ownerID),
		telemetry.Int64("channel_id", channelID),
	)
	defer done()

	if targetID <= 0 {
		return nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if err := s.requireGroupActor(ctx, ownerID, channelID); err != nil {
		return nil, err
	}
	if targetID == ownerID {
		return nil, fmt.Errorf("%w: you already own this group", ErrBadRequest)
	}
	members, err := s.st.TransferGroupDMOwner(ctx, channelID, ownerID, targetID)
	if err != nil {
		return nil, mapGroupDBError("failed to transfer group ownership", err)
	}
	return &GroupChangeResult{Audience: members}, nil
}

// RenameGroupResult is what a rename did.
type RenameGroupResult struct {
	Rows     []GroupEventRow
	Audience []int64
}

// RenameGroupDM sets (or, with "", clears) a group DM's name. Any participant may rename.
// A changed name writes a group_rename row in the same transaction (in Rows); an equal
// name writes none. A 1:1 DM refuses: its name is who is in it.
func (s *groupManagement) RenameGroupDM(ctx context.Context, userID, channelID int64, name string) (*RenameGroupResult, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: not a participant in this DM", ErrNotFound)
	}
	// The new name is pushed to every participant, so it is the caller's own text.
	if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
		return nil, err
	}

	isGroup, err := s.st.IsGroupDM(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read DM kind: %w", ErrInternal, err)
	}
	if !isGroup {
		return nil, fmt.Errorf("%w: only group DMs can be named", ErrBadRequest)
	}

	// Bound the raw bytes before cleanText (see cleanTextBounded in user.go).
	cleanName, err := cleanVisibleBounded(name, MaxGroupDMNameLen, "name")
	if err != nil {
		return nil, err
	}

	actor, _ := s.st.GetUserByID(ctx, userID) //nolint:errcheck // a failed lookup only changes the fallback text
	change, err := s.st.SetGroupDMName(ctx, channelID, userID, cleanName, groupRenameContent(actor, cleanName))
	if err != nil {
		return nil, mapGroupDBError("failed to rename group DM", err)
	}

	// The rename committed: the reads below must not fail on a client hang-up or members never hear of it.
	ctx = context.WithoutCancel(ctx)
	return &RenameGroupResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs}, nil
}
