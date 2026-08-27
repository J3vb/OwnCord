package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// seedChannelUserOverride sets a per-user permission override on a channel.
func seedChannelUserOverride(t *testing.T, database *db.DB, userID, channelID, allow, deny int64) {
	t.Helper()
	if err := database.UpsertChannelUserOverride(context.Background(), channelID, userID, allow, deny); err != nil {
		t.Fatalf("seedChannelUserOverride(user=%d,chan=%d): %v", userID, channelID, err)
	}
}

func newOverrideFixture(t *testing.T) (*ChannelService, *PermissionService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice", Status: "online"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: "online"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "open", Type: "text"})
	seedChannel(t, database, &db.Channel{ID: 11, Name: "locked", Type: "text"})
	// The role cannot read #locked at all.
	seedChannelOverride(t, database, permissions.MemberRoleID, 11, 0, permissions.ReadMessages)

	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	return NewChannelService(database, permSvc), permSvc, database
}

func visibleIDs(t *testing.T, svc *ChannelService, userID int64) map[int64]bool {
	t.Helper()
	chans, err := svc.ListVisibleChannels(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListVisibleChannels(%d): %v", userID, err)
	}
	got := make(map[int64]bool, len(chans))
	for i := range chans {
		got[chans[i].ID] = true
	}
	return got
}

// Two members of the same role must be able to disagree about a channel: the
// per-user layer is the last one in the resolution order.
func TestListVisibleChannels_PerUserOverrideSplitsRoleMates(t *testing.T) {
	svc, _, database := newOverrideFixture(t)

	// alice is individually granted READ on the role-denied channel.
	seedChannelUserOverride(t, database, 1, 11, permissions.ReadMessages, 0)
	// bob is individually denied READ on the otherwise open channel.
	seedChannelUserOverride(t, database, 2, 10, 0, permissions.ReadMessages)

	alice := visibleIDs(t, svc, 1)
	if !alice[10] || !alice[11] {
		t.Errorf("alice sees %v, want both 10 and 11", alice)
	}
	bob := visibleIDs(t, svc, 2)
	if bob[10] || bob[11] {
		t.Errorf("bob sees %v, want neither", bob)
	}
}

// The cached PermissionService must answer the full order too — it is the path
// every REST/WS permission check actually takes.
func TestPermissionService_AppliesUserOverrideLayer(t *testing.T) {
	_, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()

	// alice: role denies READ on 11, user allow restores it.
	seedChannelUserOverride(t, database, 1, 11, permissions.ReadMessages, 0)
	// bob: role allows SEND on 10, user deny removes it (READ survives).
	seedChannelUserOverride(t, database, 2, 10, 0, permissions.SendMessages)

	if !permSvc.HasChannelPerm(ctx, 1, 11, permissions.ReadMessages) {
		t.Error("alice: user allow must beat the role deny")
	}
	if permSvc.HasChannelPerm(ctx, 2, 10, permissions.SendMessages) {
		t.Error("bob: user deny must beat the role grant")
	}
	if !permSvc.HasChannelPerm(ctx, 2, 10, permissions.ReadMessages) {
		t.Error("bob: an unrelated bit must be untouched")
	}
}

// A cache populated before the override was written must not answer from the
// stale snapshot once the owning user is invalidated — this is the contract the
// admin handler relies on when it calls InvalidateUser before the hub fan-out.
func TestPermissionService_InvalidateUserPicksUpNewOverride(t *testing.T) {
	_, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()

	if !permSvc.HasChannelPerm(ctx, 1, 10, permissions.ReadMessages) {
		t.Fatal("alice must start with READ on the open channel")
	}
	seedChannelUserOverride(t, database, 1, 10, 0, permissions.ReadMessages)
	permSvc.InvalidateUser(1)

	if permSvc.HasChannelPerm(ctx, 1, 10, permissions.ReadMessages) {
		t.Error("after InvalidateUser the new per-user deny must apply")
	}
}
