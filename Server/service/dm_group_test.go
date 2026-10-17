package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// groupMembershipFixture is a group DM created by fixtureMember (the owner)
// with fixtureMember2 and fixtureMod as the other members. fixtureOwner and
// fixturePeerMod are users outside it.
type groupMembershipFixture struct {
	*moderationActionsFixture
	dms *DMService
	dm  int64
}

func newGroupMembershipFixture(t *testing.T) *groupMembershipFixture {
	t.Helper()
	f := newModerationActionsFixture(t)
	dms := NewDMService(f.database, f.mod.perms)
	res, err := dms.CreateGroupDM(context.Background(), fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	return &groupMembershipFixture{moderationActionsFixture: f, dms: dms, dm: res.Channel.ID}
}

func (f *groupMembershipFixture) members(t *testing.T) []int64 {
	t.Helper()
	ids, err := f.database.GetDMParticipantIDs(context.Background(), f.dm)
	if err != nil {
		t.Fatalf("GetDMParticipantIDs: %v", err)
	}
	slices.Sort(ids)
	return ids
}

func (f *groupMembershipFixture) ownerID(t *testing.T) int64 {
	t.Helper()
	owner, _, err := f.database.GetGroupDMMeta(context.Background(), f.dm)
	if err != nil {
		t.Fatalf("GetGroupDMMeta: %v", err)
	}
	return owner
}

func (f *groupMembershipFixture) rowCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.dm).Scan(&n); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	return n
}

// ─── Item 2 of the 3B-10a review: the service check, not the db predicate ───

// groupRowStore answers GetMessage with a group row and fails the test if the
// service goes on to write. It embeds a nil Store, so any other store call
// panics: the refusal must come before the channel or access lookups.
type groupRowStore struct {
	Store
	t    *testing.T
	kind int64
}

func (s *groupRowStore) GetMessage(_ context.Context, id int64) (*db.Message, error) {
	return &db.Message{ID: id, ChannelID: 9, UserID: 3, Content: "group event", Kind: s.kind}, nil
}

func (s *groupRowStore) EditMessage(_ context.Context, _, _ int64, _ string) (*db.Message, error) {
	s.t.Error("EditMessage reached the store for a group row")
	return nil, nil
}

func TestEditMessage_GroupRowRefusedByServiceCheck(t *testing.T) {
	for _, kind := range groupKinds {
		svc := NewMessageService(&groupRowStore{t: t, kind: kind}, nil, nil)
		_, err := svc.EditMessage(context.Background(), 3, 1, "rewritten")
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("kind %d: author edit = %v, want ErrForbidden from the service check", kind, err)
		}
	}
}

// ─── Add ────────────────────────────────────────────────────────────────────

func TestAddGroupMembers_AnyMemberAddsAndRowsNameTheTarget(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	// fixtureMember2 is not the owner: any member may add.
	res, err := f.dms.AddGroupMembers(ctx, fixtureMember2, f.dm, []int64{fixtureOwner, fixturePeerMod})
	if err != nil {
		t.Fatalf("AddGroupMembers: %v", err)
	}
	if want := []int64{fixtureOwner, fixtureMod, fixtureMember, fixtureMember2, fixturePeerMod}; !slices.Equal(res.Audience, want) {
		t.Errorf("Audience = %v, want %v", res.Audience, want)
	}
	if !slices.Equal(res.Added, []int64{fixtureOwner, fixturePeerMod}) {
		t.Errorf("Added = %v", res.Added)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(res.Rows))
	}
	r := res.Rows[0]
	if r.Kind != "group_add" || r.Author == nil || r.Author.ID != fixtureMember2 || r.TargetUserID != fixtureOwner ||
		r.AuthorRole != "member" || !strings.Contains(r.Content, "added") || r.Timestamp == "" {
		t.Errorf("row 0 = %+v", r)
	}
	if got := f.ownerID(t); got != fixtureMember {
		t.Errorf("owner = %d, an add must not move ownership", got)
	}
}

func TestAddGroupMembers_Validation(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	cases := []struct {
		name string
		ids  []int64
	}{
		{"empty", nil},
		{"zero id", []int64{0}},
		{"negative id", []int64{-4}},
		{"ten ids", []int64{1, 5, 6, 7, 8, 9, 10, 11, 12, 13}},
		{"every id already a member", []int64{fixtureMember2, fixtureMod, fixtureMember}},
	}
	for _, tc := range cases {
		if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, tc.ids); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", tc.name, err)
		}
	}
	if got := f.rowCount(t); got != 0 {
		t.Errorf("refused adds wrote %d rows", got)
	}
}

func TestAddGroupMembers_ExistingMembersAreSkipped(t *testing.T) {
	f := newGroupMembershipFixture(t)
	res, err := f.dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureMember2, fixtureOwner})
	if err != nil {
		t.Fatalf("AddGroupMembers: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0].TargetUserID != fixtureOwner {
		t.Errorf("rows = %+v, want a single row for the new member", res.Rows)
	}
}

func TestAddGroupMembers_RefusalsForCallerAndChannel(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if _, err := f.dms.AddGroupMembers(ctx, fixtureOwner, f.dm, []int64{fixturePeerMod}); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-member add = %v, want ErrNotFound", err)
	}
	oneToOne, err := f.dms.CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, oneToOne.Channel.ID, []int64{fixtureOwner}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("add to a 1:1 DM = %v, want ErrBadRequest", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{9999}); !errors.Is(err, ErrNotFound) {
		t.Errorf("add of a missing user = %v, want ErrNotFound", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); !errors.Is(err, ErrTimedOut) {
		t.Errorf("add while timed out = %v, want ErrTimedOut", err)
	}
}

func TestAddGroupMembers_BannedTargetNotFound(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if err := f.database.BanUser(ctx, fixtureOwner, "x", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestAddGroupMembers_BlockedPairForbidden(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	// A non-actor member blocked the target.
	if err := f.database.BlockUser(ctx, fixtureMod, fixtureOwner); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("add of a user a member blocked = %v, want ErrForbidden", err)
	}
	// Two targets that block each other.
	if err := f.database.BlockUser(ctx, fixturePeerMod, fixtureOwner); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := f.database.UnblockUser(ctx, fixtureMod, fixtureOwner); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner, fixturePeerMod}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("add of two mutually blocked users = %v, want ErrForbidden", err)
	}
	if got := f.members(t); len(got) != 3 {
		t.Errorf("members = %v after refused adds, want the original 3", got)
	}
}

// Members who blocked each other after the group formed do not stop a third
// person being added.
func TestAddGroupMembers_BlockBetweenExistingMembersDoesNotRefuse(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if err := f.database.BlockUser(ctx, fixtureMember2, fixtureMod); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); err != nil {
		t.Fatalf("AddGroupMembers: %v", err)
	}
}

func TestAddGroupMembers_NoTrustGate(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	// fixtureOwner has never accepted fixtureMember: a 1:1 send would be a
	// message request. A group add is exempt, as at create.
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); err != nil {
		t.Fatalf("AddGroupMembers without a trust relationship: %v", err)
	}
}

func TestAddGroupMembers_FullGroupIsGroupDMFull(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	extra := make([]int64, 0, 8)
	for i := range 8 {
		id := int64(200 + i)
		seedUser(t, f.database, &db.User{ID: id, Username: fmt.Sprintf("extra%d", i), Status: "offline"})
		seedUserRole(t, f.database, id, 3)
		extra = append(extra, id)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, extra[:7]); err != nil {
		t.Fatalf("filling the group: %v", err)
	}
	_, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{extra[7]})
	if !errors.Is(err, ErrGroupDMFull) {
		t.Fatalf("err = %v, want ErrGroupDMFull", err)
	}
	if !errors.Is(err, ErrConflict) {
		t.Errorf("ErrGroupDMFull must wrap ErrConflict, got %v", err)
	}
	if got := len(f.members(t)); got != db.MaxGroupDMParticipants {
		t.Errorf("members = %d, want %d", got, db.MaxGroupDMParticipants)
	}
}

// ─── Remove ─────────────────────────────────────────────────────────────────

func TestRemoveGroupMember_OwnerOnlyAndRules(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()

	if _, err := f.dms.RemoveGroupMember(ctx, fixtureMember2, f.dm, fixtureMod); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-owner remove = %v, want ErrForbidden", err)
	}
	if _, err := f.dms.RemoveGroupMember(ctx, fixtureMember, f.dm, fixtureMember); !errors.Is(err, ErrBadRequest) {
		t.Errorf("remove yourself = %v, want ErrBadRequest (use leave)", err)
	}
	if _, err := f.dms.RemoveGroupMember(ctx, fixtureMember, f.dm, fixtureOwner); !errors.Is(err, ErrNotFound) {
		t.Errorf("remove a non-member = %v, want ErrNotFound", err)
	}
	if _, err := f.dms.RemoveGroupMember(ctx, fixtureOwner, f.dm, fixtureMod); !errors.Is(err, ErrNotFound) {
		t.Errorf("remove by a non-member = %v, want ErrNotFound", err)
	}
	oneToOne, err := f.dms.CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	if _, err := f.dms.RemoveGroupMember(ctx, fixtureMember, oneToOne.Channel.ID, fixtureMember2); !errors.Is(err, ErrBadRequest) {
		t.Errorf("remove in a 1:1 DM = %v, want ErrBadRequest", err)
	}
	if got := f.rowCount(t); got != 0 {
		t.Fatalf("refused removes wrote %d rows", got)
	}

	res, err := f.dms.RemoveGroupMember(ctx, fixtureMember, f.dm, fixtureMod)
	if err != nil {
		t.Fatalf("owner remove: %v", err)
	}
	if want := []int64{fixtureMember, fixtureMember2}; !slices.Equal(res.Audience, want) {
		t.Errorf("Audience = %v, want the remaining %v", res.Audience, want)
	}
	if len(res.Rows) != 1 || res.Rows[0].Kind != "group_remove" || res.Rows[0].TargetUserID != fixtureMod || res.Rows[0].Author.ID != fixtureMember {
		t.Errorf("rows = %+v", res.Rows)
	}
}

func TestRemoveGroupMember_TimedOutRefused(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if _, err := f.dms.RemoveGroupMember(ctx, fixtureMember, f.dm, fixtureMod); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("err = %v, want ErrTimedOut", err)
	}
}

// ─── Transfer ───────────────────────────────────────────────────────────────

func TestTransferGroupOwner_OwnerOnlyAndTargetMustBeMember(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()

	if _, err := f.dms.TransferGroupOwner(ctx, fixtureMember2, f.dm, fixtureMod); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-owner transfer = %v, want ErrForbidden", err)
	}
	if _, err := f.dms.TransferGroupOwner(ctx, fixtureMember, f.dm, fixtureMember); !errors.Is(err, ErrBadRequest) {
		t.Errorf("transfer to yourself = %v, want ErrBadRequest", err)
	}
	if _, err := f.dms.TransferGroupOwner(ctx, fixtureMember, f.dm, fixtureOwner); !errors.Is(err, ErrNotFound) {
		t.Errorf("transfer to a non-member = %v, want ErrNotFound", err)
	}
	if got := f.ownerID(t); got != fixtureMember {
		t.Fatalf("owner = %d after refused transfers", got)
	}
	res, err := f.dms.TransferGroupOwner(ctx, fixtureMember, f.dm, fixtureMember2)
	if err != nil {
		t.Fatalf("TransferGroupOwner: %v", err)
	}
	if len(res.Rows) != 0 {
		t.Errorf("a transfer wrote rows: %+v", res.Rows)
	}
	if got := f.ownerID(t); got != fixtureMember2 {
		t.Errorf("owner = %d, want %d", got, fixtureMember2)
	}
	sum, err := f.dms.DMSummaryFor(ctx, fixtureMod, f.dm)
	if err != nil || sum.OwnerID != fixtureMember2 {
		t.Errorf("summary owner = %d (%v), want %d", sum.OwnerID, err, fixtureMember2)
	}
}

// ─── Rename and leave rows ──────────────────────────────────────────────────

func TestRenameGroupDM_WritesRowAndUnchangedWritesNone(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()

	res, err := f.dms.RenameGroupDM(ctx, fixtureMember2, f.dm, "Raid night")
	if err != nil {
		t.Fatalf("RenameGroupDM: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0].Kind != "group_rename" || res.Rows[0].Name == nil || *res.Rows[0].Name != "Raid night" ||
		!strings.Contains(res.Rows[0].Content, "Raid night") {
		t.Fatalf("rows = %+v", res.Rows)
	}
	if want := []int64{fixtureMod, fixtureMember, fixtureMember2}; !slices.Equal(res.Audience, want) {
		t.Errorf("Audience = %v, want %v", res.Audience, want)
	}

	again, err := f.dms.RenameGroupDM(ctx, fixtureMember, f.dm, "Raid night")
	if err != nil {
		t.Fatalf("RenameGroupDM (same name): %v", err)
	}
	if len(again.Rows) != 0 {
		t.Errorf("an unchanged name wrote rows: %+v", again.Rows)
	}

	cleared, err := f.dms.RenameGroupDM(ctx, fixtureMember, f.dm, "")
	if err != nil || len(cleared.Rows) != 1 || cleared.Rows[0].Name == nil || *cleared.Rows[0].Name != "" {
		t.Fatalf("clearing the name = %+v, %v, want one row with an empty name", cleared, err)
	}
	if !strings.Contains(cleared.Rows[0].Content, "removed the group name") {
		t.Errorf("fallback = %q", cleared.Rows[0].Content)
	}
}

func TestCloseDM_GroupLeaveWritesRowForSurvivors(t *testing.T) {
	f := newGroupMembershipFixture(t)
	res, err := f.dms.CloseDM(context.Background(), fixtureMember2, f.dm)
	if err != nil {
		t.Fatalf("CloseDM: %v", err)
	}
	if !res.Left || res.ChannelDeleted {
		t.Fatalf("result = %+v", res)
	}
	if len(res.Rows) != 1 || res.Rows[0].Kind != "group_leave" || res.Rows[0].Author.ID != fixtureMember2 || !strings.Contains(res.Rows[0].Content, "left the group") {
		t.Errorf("rows = %+v", res.Rows)
	}
	if want := []int64{fixtureMod, fixtureMember}; !slices.Equal(res.RemainingParticipantIDs, want) {
		t.Errorf("survivors = %v, want %v", res.RemainingParticipantIDs, want)
	}
}

func TestCreateAndAdd_ShareRecipientValidation(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if err := f.database.BanUser(ctx, fixtureOwner, "x", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	if err := f.database.BlockUser(ctx, fixturePeerMod, fixtureMember2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	// A banned recipient: not found on both paths.
	if _, err := f.dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMod, fixtureOwner}, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("create with a banned recipient = %v, want ErrNotFound", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); !errors.Is(err, ErrNotFound) {
		t.Errorf("add of a banned user = %v, want ErrNotFound", err)
	}
	// A blocked pair: forbidden on both paths.
	if _, err := f.dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixturePeerMod}, ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("create with a blocked pair = %v, want ErrForbidden", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixturePeerMod}); !errors.Is(err, ErrForbidden) {
		t.Errorf("add of a user blocked by a member = %v, want ErrForbidden", err)
	}
}
