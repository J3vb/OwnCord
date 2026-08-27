package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── channel_user_overrides ──────────────────────────────────────────────────

func TestChannelUserOverride_UpsertGetDelete(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	chID, err := database.CreateChannel(ctx, "secret", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	uid, err := database.CreateUser(ctx, "alice", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// No row yet — a missing override is (0, 0), not an error.
	allow, deny, err := database.GetUserChannelPermissions(ctx, chID, uid)
	if err != nil {
		t.Fatalf("GetUserChannelPermissions (absent): %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("absent override = (%#x, %#x), want (0, 0)", allow, deny)
	}

	if err := database.UpsertChannelUserOverride(ctx, chID, uid, permissions.ReadMessages, permissions.SendMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	allow, deny, err = database.GetUserChannelPermissions(ctx, chID, uid)
	if err != nil {
		t.Fatalf("GetUserChannelPermissions: %v", err)
	}
	if allow != permissions.ReadMessages || deny != permissions.SendMessages {
		t.Errorf("override = (%#x, %#x)", allow, deny)
	}

	// Upsert replaces rather than duplicating.
	if err := database.UpsertChannelUserOverride(ctx, chID, uid, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride (update): %v", err)
	}
	rows, err := database.ListChannelUserOverrides(ctx, chID)
	if err != nil {
		t.Fatalf("ListChannelUserOverrides: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].Username != "alice" || rows[0].Allow != 0 || rows[0].Deny != permissions.ReadMessages {
		t.Errorf("listed row = %+v", rows[0])
	}

	if err := database.DeleteChannelUserOverride(ctx, chID, uid); err != nil {
		t.Fatalf("DeleteChannelUserOverride: %v", err)
	}
	rows, err = database.ListChannelUserOverrides(ctx, chID)
	if err != nil {
		t.Fatalf("ListChannelUserOverrides after delete: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("rows after delete = %d, want 0", len(rows))
	}
	// Deleting again is a no-op.
	if err := database.DeleteChannelUserOverride(ctx, chID, uid); err != nil {
		t.Fatalf("second DeleteChannelUserOverride: %v", err)
	}
}

// GetChannelOverridesFor is the single merged fetch every visibility site uses.
// It must carry BOTH layers, and a channel with only one layer set must keep
// the other at zero.
func TestGetChannelOverridesFor_MergesBothLayers(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	roleOnly, err := database.CreateChannel(ctx, "role-only", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	userOnly, err := database.CreateChannel(ctx, "user-only", "text", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	both, err := database.CreateChannel(ctx, "both", "text", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	uid, err := database.CreateUser(ctx, "bob", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if err := database.UpsertChannelOverride(ctx, roleOnly, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, userOnly, uid, permissions.SendMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	if err := database.UpsertChannelOverride(ctx, both, permissions.MemberRoleID, permissions.AttachFiles, 0); err != nil {
		t.Fatalf("UpsertChannelOverride both: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, both, uid, 0, permissions.AttachFiles); err != nil {
		t.Fatalf("UpsertChannelUserOverride both: %v", err)
	}

	merged, err := database.GetChannelOverridesFor(ctx, permissions.MemberRoleID, uid)
	if err != nil {
		t.Fatalf("GetChannelOverridesFor: %v", err)
	}
	if got := merged[roleOnly]; got.Deny != permissions.ReadMessages || got.UserDeny != 0 {
		t.Errorf("role-only channel = %+v", got)
	}
	if got := merged[userOnly]; got.Allow != 0 || got.UserAllow != permissions.SendMessages {
		t.Errorf("user-only channel = %+v", got)
	}
	if got := merged[both]; got.Allow != permissions.AttachFiles || got.UserDeny != permissions.AttachFiles {
		t.Errorf("both-layers channel = %+v", got)
	}

	// A different member of the same role sees the role layer only.
	other, err := database.CreateUser(ctx, "carol", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser carol: %v", err)
	}
	otherMerged, err := database.GetChannelOverridesFor(ctx, permissions.MemberRoleID, other)
	if err != nil {
		t.Fatalf("GetChannelOverridesFor carol: %v", err)
	}
	if got := otherMerged[userOnly]; got.UserAllow != 0 {
		t.Errorf("carol picked up bob's user override: %+v", got)
	}
	if got := otherMerged[both]; got.UserDeny != 0 {
		t.Errorf("carol picked up bob's user deny: %+v", got)
	}
}

// Deleting a channel or a user must take its override rows with it — the FKs
// carry ON DELETE CASCADE precisely so a stale row cannot grant access to a
// channel id that has been reused.
func TestChannelUserOverride_CascadesOnChannelDelete(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	chID, err := database.CreateChannel(ctx, "doomed", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	uid, err := database.CreateUser(ctx, "dave", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, uid, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	if err := database.DeleteChannel(ctx, chID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	byUser, err := database.GetAllChannelPermissionsForUser(ctx, uid)
	if err != nil {
		t.Fatalf("GetAllChannelPermissionsForUser: %v", err)
	}
	if len(byUser) != 0 {
		t.Errorf("override survived channel delete: %+v", byUser)
	}
}

func TestGetChannelUserOverrides_ByChannel(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	chID, err := database.CreateChannel(ctx, "listing", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	a, err := database.CreateUser(ctx, "aaa", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser aaa: %v", err)
	}
	b, err := database.CreateUser(ctx, "bbb", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser bbb: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, a, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride a: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, b, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride b: %v", err)
	}

	byUser, err := database.GetChannelUserOverrides(ctx, chID)
	if err != nil {
		t.Fatalf("GetChannelUserOverrides: %v", err)
	}
	if len(byUser) != 2 {
		t.Fatalf("entries = %d, want 2", len(byUser))
	}
	if byUser[a].UserAllow != permissions.ReadMessages {
		t.Errorf("user a = %+v", byUser[a])
	}
	if byUser[b].UserDeny != permissions.ReadMessages {
		t.Errorf("user b = %+v", byUser[b])
	}
}
