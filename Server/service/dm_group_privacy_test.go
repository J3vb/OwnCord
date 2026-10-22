package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8d: a target that has turned "Allow DMs" off and does not trust the
// actor, or that the actor holds an unaccepted message request to, cannot be
// put in a group by that actor. Fixture: fixtureMember (owner) with
// fixtureMember2 and fixtureMod in the group; fixtureOwner and fixturePeerMod
// are outside it.

const groupRefusalText = "cannot add this user to a group DM"

func assertGroupRefused(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if got := err.Error(); got != ErrForbidden.Error()+": "+groupRefusalText {
		t.Errorf("refusal text = %q, want the one group refusal", got)
	}
}

// seedRequest writes a message request from sender to recipient in state, on a
// fresh 1:1 channel, with no trust row from the recipient.
func seedRequest(t *testing.T, database *db.DB, sender, recipient int64, state string) {
	t.Helper()
	ctx := context.Background()
	ch, _, err := database.GetOrCreateDMChannel(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if _, err = database.ExecContext(ctx,
		`INSERT INTO message_requests (sender_id, recipient_id, channel_id, state) VALUES (?, ?, ?, ?)`,
		sender, recipient, ch.ID, state); err != nil {
		t.Fatalf("insert message request: %v", err)
	}
}

func TestAddGroupMembers_TargetDMsOffUntrustedRefused(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	setAllowDMs(t, f.database, fixtureOwner, false)

	before := f.members(t)
	_, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner})
	assertGroupRefused(t, err)
	if got := f.members(t); !slices.Equal(got, before) {
		t.Errorf("members = %v, want unchanged %v", got, before)
	}
	if n := f.rowCount(t); n != 0 {
		t.Errorf("group rows = %d, want 0", n)
	}
}

func TestAddGroupMembers_TargetTrustsAdderAllowed(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	setAllowDMs(t, f.database, fixtureOwner, false)
	if err := f.database.TrustSender(ctx, fixtureOwner, fixtureMember2, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	// The owner of the group does not have the target's trust, the adder does.
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); err == nil {
		t.Fatal("add by an untrusted member succeeded")
	}
	res, err := f.dms.AddGroupMembers(ctx, fixtureMember2, f.dm, []int64{fixtureOwner})
	if err != nil {
		t.Fatalf("add by the trusted member: %v", err)
	}
	if !slices.Equal(res.Added, []int64{fixtureOwner}) {
		t.Errorf("Added = %v, want [%d]", res.Added, fixtureOwner)
	}
}

// Other members' trust does not help: only the actor's counts.
func TestAddGroupMembers_OtherMembersTrustDoesNotCount(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	setAllowDMs(t, f.database, fixtureOwner, false)
	for _, m := range []int64{fixtureMember2, fixtureMod} {
		if err := f.database.TrustSender(ctx, fixtureOwner, m, "accepted"); err != nil {
			t.Fatalf("TrustSender: %v", err)
		}
	}
	_, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner})
	assertGroupRefused(t, err)
}

func TestAddGroupMembers_StaffDoNotBypass(t *testing.T) {
	f := newGroupMembershipFixture(t)
	setAllowDMs(t, f.database, fixtureMember2, false)
	// fixtureOwner is an administrator; fixtureMod is a moderator in the group.
	_, err := f.dms.AddGroupMembers(context.Background(), fixtureMod, f.dm, []int64{fixturePeerMod})
	if err != nil {
		t.Fatalf("control add: %v", err)
	}
	setAllowDMs(t, f.database, fixtureOwner, false)
	_, err = f.dms.AddGroupMembers(context.Background(), fixtureMod, f.dm, []int64{fixtureOwner})
	assertGroupRefused(t, err)
}

func TestAddGroupMembers_RequestHolderRefusedIdenticallyForEveryState(t *testing.T) {
	var bodies []string
	for _, state := range []string{"pending", "ignored", "deleted"} {
		t.Run(state, func(t *testing.T) {
			f := newGroupMembershipFixture(t)
			seedRequest(t, f.database, fixtureMember, fixtureOwner, state)
			_, err := f.dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureOwner})
			assertGroupRefused(t, err)
			bodies = append(bodies, err.Error())
			// Another member, who holds no request, may add the same user.
			if _, err = f.dms.AddGroupMembers(context.Background(), fixtureMember2, f.dm, []int64{fixtureOwner}); err != nil {
				t.Errorf("add by a member with no request: %v", err)
			}
		})
	}
	for _, b := range bodies[1:] {
		if b != bodies[0] {
			t.Errorf("refusal bodies differ: %q vs %q", b, bodies[0])
		}
	}
}

func TestAddGroupMembers_AcceptedRequestAllowed(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	seedRequest(t, f.database, fixtureMember, fixtureOwner, "accepted")
	if err := f.database.TrustSender(ctx, fixtureOwner, fixtureMember, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if _, err := f.dms.AddGroupMembers(ctx, fixtureMember, f.dm, []int64{fixtureOwner}); err != nil {
		t.Fatalf("add after the request was accepted: %v", err)
	}
}

// One refused target in a multi-target add refuses the whole call.
func TestAddGroupMembers_OneRefusedTargetAddsNobody(t *testing.T) {
	f := newGroupMembershipFixture(t)
	setAllowDMs(t, f.database, fixturePeerMod, false)
	before := f.members(t)
	_, err := f.dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureOwner, fixturePeerMod})
	assertGroupRefused(t, err)
	if got := f.members(t); !slices.Equal(got, before) {
		t.Errorf("members = %v, want unchanged %v", got, before)
	}
	if n := f.rowCount(t); n != 0 {
		t.Errorf("group rows = %d, want 0", n)
	}
}

func TestCreateGroupDM_TargetDMsOffUntrustedRefused(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	dms := NewDMService(f.database, f.mod.perms)
	setAllowDMs(t, f.database, fixtureMod, false)

	_, err := dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	assertGroupRefused(t, err)
	if n := countRows(t, f.database, `SELECT COUNT(*) FROM channels WHERE is_group = 1`); n != 0 {
		t.Errorf("group channels = %d, want 0", n)
	}

	// Trust from another recipient does not help; the creator's own does.
	if err = f.database.TrustSender(ctx, fixtureMod, fixtureMember2, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	_, err = dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	assertGroupRefused(t, err)
	if err = f.database.TrustSender(ctx, fixtureMod, fixtureMember, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if _, err = dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew"); err != nil {
		t.Fatalf("create with a recipient that trusts the creator: %v", err)
	}
}

func TestCreateGroupDM_RequestHolderRefused(t *testing.T) {
	for _, state := range []string{"pending", "ignored", "deleted"} {
		t.Run(state, func(t *testing.T) {
			f := newModerationActionsFixture(t)
			dms := NewDMService(f.database, f.mod.perms)
			seedRequest(t, f.database, fixtureMember, fixtureMod, state)
			_, err := dms.CreateGroupDM(context.Background(), fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
			assertGroupRefused(t, err)
		})
	}
}

// A member who turns DMs off later stays in the group, keeps sending and can
// leave: the check is on create and add only.
func TestGroupDM_MemberTurnsDMsOffStaysSendsAndLeaves(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	setAllowDMs(t, f.database, fixtureMember2, false)

	svc := New(f.database, nil)
	if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: f.dm, UserID: fixtureMember, Username: "u", Content: "hello group",
	}); err != nil {
		t.Fatalf("owner send after a member turned DMs off: %v", err)
	}
	if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: f.dm, UserID: fixtureMember2, Username: "u", Content: "hi back",
	}); err != nil {
		t.Fatalf("send by the member who turned DMs off: %v", err)
	}
	if !slices.Contains(f.members(t), fixtureMember2) {
		t.Fatal("member was removed when they turned DMs off")
	}
	if _, err := f.dms.CloseDM(ctx, fixtureMember2, f.dm); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if slices.Contains(f.members(t), fixtureMember2) {
		t.Error("member is still in the group after leaving")
	}
}

// Between the service's check and the add transaction the target turns DMs
// off: the transaction refuses, with no participant and no group_add row.
func TestAddGroupMembers_TargetFlipsDMsOffBeforeTransaction(t *testing.T) {
	f := newGroupMembershipFixture(t)
	flip := &flipBeforeAddStore{DB: f.database, flipUser: fixtureOwner}
	dms := NewDMService(flip, f.mod.perms)

	before := f.members(t)
	_, err := dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureOwner})
	assertGroupRefused(t, err)
	if !flip.flipped {
		t.Fatal("the hook never ran, so the service check was not the one that passed")
	}
	if got := f.members(t); !slices.Equal(got, before) {
		t.Errorf("members = %v, want unchanged %v", got, before)
	}
	if n := f.rowCount(t); n != 0 {
		t.Errorf("group rows = %d, want 0", n)
	}
}

// flipBeforeAddStore turns DMs off for flipUser right before the add
// transaction, after the service's own reachability read passed.
type flipBeforeAddStore struct {
	*db.DB
	flipUser int64
	flipped  bool
}

func (s *flipBeforeAddStore) AddGroupDMMembers(ctx context.Context, channelID, actorID int64, ids []int64, contentFor func(int64) string) (*db.GroupChange, error) {
	if err := s.SetUserPrivacy(ctx, s.flipUser, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
		return nil, err
	}
	s.flipped = true
	return s.DB.AddGroupDMMembers(ctx, channelID, actorID, ids, contentFor)
}

// The refusal reads the same whether a block, DMs-off or an unaccepted request
// caused it, and never names the target.
func TestAddGroupMembers_RefusalBodyIdentical(t *testing.T) {
	causes := map[string]func(t *testing.T, f *groupMembershipFixture){
		"privacy": func(t *testing.T, f *groupMembershipFixture) { setAllowDMs(t, f.database, fixtureOwner, false) },
		"block": func(t *testing.T, f *groupMembershipFixture) {
			if err := f.database.BlockUser(context.Background(), fixtureOwner, fixtureMember2); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		},
		"request": func(t *testing.T, f *groupMembershipFixture) {
			seedRequest(t, f.database, fixtureMember, fixtureOwner, "pending")
		},
	}
	var first string
	for name, arrange := range causes {
		f := newGroupMembershipFixture(t)
		arrange(t, f)
		_, err := f.dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureOwner})
		assertGroupRefused(t, err)
		if first == "" {
			first = err.Error()
		} else if err.Error() != first {
			t.Errorf("%s refusal %q differs from %q", name, err.Error(), first)
		}
	}
}

// A failed reachability read refuses the add as an internal error and adds
// nobody.
func TestAddGroupMembers_ReachabilityReadErrorFailsClosed(t *testing.T) {
	f := newGroupMembershipFixture(t)
	dms := NewDMService(&failingReachabilityStore{DB: f.database}, f.mod.perms)

	before := f.members(t)
	_, err := dms.AddGroupMembers(context.Background(), fixtureMember, f.dm, []int64{fixtureOwner})
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("err = %v, want ErrInternal", err)
	}
	if got := f.members(t); !slices.Equal(got, before) {
		t.Errorf("members = %v, want unchanged %v", got, before)
	}
}

type failingReachabilityStore struct {
	*db.DB
}

func (s *failingReachabilityStore) GroupDMTargetsRefuse(context.Context, int64, []int64) (bool, error) {
	return false, errors.New("read failed")
}
