package db_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func turnDMsOff(t *testing.T, database *db.DB, userID int64) {
	t.Helper()
	if err := database.SetUserPrivacy(context.Background(), userID, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
		t.Fatalf("SetUserPrivacy: %v", err)
	}
}

// The target turns DMs off after the service's check and before the add
// transaction: the transaction refuses and writes no participant row and no
// group_add row.
func TestAddGroupDMMembers_ReachabilityRecheckedInTx(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	erin := seedUser(t, f.database, "erin")
	turnDMsOff(t, f.database, dave)

	_, err := f.database.AddGroupDMMembers(ctx, f.group, f.alice, []int64{erin, dave}, contentOf)
	if !errors.Is(err, db.ErrGroupDMBlockedPair) {
		t.Fatalf("add with a target that has DMs off = %v, want ErrGroupDMBlockedPair", err)
	}
	if got := memberIDs(t, f.database, f.group); !slices.Equal(got, []int64{f.alice, f.bob, f.carol}) {
		t.Errorf("members = %v, want only the original three (nobody is added)", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind = 2`, f.group); got != 0 {
		t.Errorf("group_add rows = %d, want 0", got)
	}

	// Only the actor's trust counts: a current member's trust does not help,
	// the actor's does.
	if err = f.database.TrustSender(ctx, dave, f.bob, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if _, err = f.database.AddGroupDMMembers(ctx, f.group, f.alice, []int64{dave}, contentOf); !errors.Is(err, db.ErrGroupDMBlockedPair) {
		t.Fatalf("add with only another member trusted = %v, want ErrGroupDMBlockedPair", err)
	}
	if err = f.database.TrustSender(ctx, dave, f.alice, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if _, err = f.database.AddGroupDMMembers(ctx, f.group, f.alice, []int64{dave}, contentOf); err != nil {
		t.Fatalf("add with the actor trusted: %v", err)
	}
}

func TestAddGroupDMMembers_UnacceptedRequestRefusedInTx(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, f.alice, dave)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if _, err = f.database.ExecContext(ctx,
		`INSERT INTO message_requests (sender_id, recipient_id, channel_id, state) VALUES (?, ?, ?, 'ignored')`,
		f.alice, dave, dm.ID); err != nil {
		t.Fatalf("insert request: %v", err)
	}
	if _, err = f.database.AddGroupDMMembers(ctx, f.group, f.alice, []int64{dave}, contentOf); !errors.Is(err, db.ErrGroupDMBlockedPair) {
		t.Fatalf("add by the request holder = %v, want ErrGroupDMBlockedPair", err)
	}
	// A member who holds no request may add the same user.
	if _, err = f.database.AddGroupDMMembers(ctx, f.group, f.bob, []int64{dave}, contentOf); err != nil {
		t.Fatalf("add by a member with no request: %v", err)
	}
}

func TestCreateGroupDMChannel_RefusesUnreachableRecipientInTx(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	carol := seedUser(t, database, "carol")
	turnDMsOff(t, database, carol)

	if _, err := database.CreateGroupDMChannel(ctx, "Crew", alice, []int64{alice, bob, carol}); !errors.Is(err, db.ErrGroupDMBlockedPair) {
		t.Fatalf("create with a recipient that has DMs off = %v, want ErrGroupDMBlockedPair", err)
	}
	if got := count(t, database, `SELECT COUNT(*) FROM channels WHERE is_group = 1`); got != 0 {
		t.Errorf("group channels = %d, want 0", got)
	}
	if got := count(t, database, `SELECT COUNT(*) FROM dm_participants`); got != 0 {
		t.Errorf("dm_participants rows = %d, want 0", got)
	}
	// The creator's own setting never counts against them.
	turnDMsOff(t, database, alice)
	if err := database.TrustSender(ctx, carol, alice, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	if _, err := database.CreateGroupDMChannel(ctx, "Crew", alice, []int64{alice, bob, carol}); err != nil {
		t.Fatalf("create with a recipient that trusts the creator: %v", err)
	}
}
