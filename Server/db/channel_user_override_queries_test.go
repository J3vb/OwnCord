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

	chID := mustCreateChannel(t, database, "secret", "text", "", "", 0)
	uid := mustCreateUser(t, database, "alice", "hash", int(permissions.MemberRoleID))

	// No row yet — a missing override is (0, 0), not an error.
	allow, deny, err := database.GetUserChannelPermissions(ctx, chID, uid)
	mustDo(t, "GetUserChannelPermissions (absent)", err)
	if allow != 0 || deny != 0 {
		t.Errorf("absent override = (%#x, %#x), want (0, 0)", allow, deny)
	}

	mustDo(t, "UpsertChannelUserOverride", database.UpsertChannelUserOverride(ctx, chID, uid, permissions.ReadMessages, permissions.SendMessages))
	allow, deny, err = database.GetUserChannelPermissions(ctx, chID, uid)
	mustDo(t, "GetUserChannelPermissions", err)
	if allow != permissions.ReadMessages || deny != permissions.SendMessages {
		t.Errorf("override = (%#x, %#x)", allow, deny)
	}

	// Upsert replaces rather than duplicating.
	mustDo(t, "UpsertChannelUserOverride (update)", database.UpsertChannelUserOverride(ctx, chID, uid, 0, permissions.ReadMessages))
	rows, err := database.ListChannelUserOverrides(ctx, chID)
	mustDo(t, "ListChannelUserOverrides", err)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].Username != "alice" || rows[0].Allow != 0 || rows[0].Deny != permissions.ReadMessages {
		t.Errorf("listed row = %+v", rows[0])
	}

	mustDo(t, "DeleteChannelUserOverride", database.DeleteChannelUserOverride(ctx, chID, uid))
	rows, err = database.ListChannelUserOverrides(ctx, chID)
	mustDo(t, "ListChannelUserOverrides after delete", err)
	if len(rows) != 0 {
		t.Errorf("rows after delete = %d, want 0", len(rows))
	}
	// Deleting again is a no-op.
	mustDo(t, "second DeleteChannelUserOverride", database.DeleteChannelUserOverride(ctx, chID, uid))
}

// GetMemberGrants is the single merged fetch every visibility site uses.
// It must carry BOTH layers, and a channel with only one layer set must keep
// the other at zero.
func TestGetMemberGrants_MergesBothLayers(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	roleOnly := mustCreateChannel(t, database, "role-only", "text", "", "", 0)
	userOnly := mustCreateChannel(t, database, "user-only", "text", "", "", 1)
	both := mustCreateChannel(t, database, "both", "text", "", "", 2)
	uid := mustCreateUser(t, database, "bob", "hash", int(permissions.MemberRoleID))

	mustDo(t, "UpsertChannelOverride", database.UpsertChannelOverride(ctx, roleOnly, permissions.MemberRoleID, 0, permissions.ReadMessages))
	mustDo(t, "UpsertChannelUserOverride", database.UpsertChannelUserOverride(ctx, userOnly, uid, permissions.SendMessages, 0))
	mustDo(t, "UpsertChannelOverride both", database.UpsertChannelOverride(ctx, both, permissions.MemberRoleID, permissions.AttachFiles, 0))
	mustDo(t, "UpsertChannelUserOverride both", database.UpsertChannelUserOverride(ctx, both, uid, 0, permissions.AttachFiles))

	grants, err := database.GetMemberGrants(ctx, uid)
	mustDo(t, "GetMemberGrants", err)
	merged := grants.Overrides
	if grants.Layers != nil {
		t.Errorf("a one-role member carries no per-role layers, got %+v", grants.Layers)
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
	other := mustCreateUser(t, database, "carol", "hash", int(permissions.MemberRoleID))
	otherGrants, err := database.GetMemberGrants(ctx, other)
	mustDo(t, "GetMemberGrants carol", err)
	otherMerged := otherGrants.Overrides
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

	chID := mustCreateChannel(t, database, "doomed", "text", "", "", 0)
	uid := mustCreateUser(t, database, "dave", "hash", int(permissions.MemberRoleID))
	mustDo(t, "UpsertChannelUserOverride", database.UpsertChannelUserOverride(ctx, chID, uid, permissions.ReadMessages, 0))
	mustDo(t, "DeleteChannel", database.DeleteChannel(ctx, chID))

	byUser, err := database.GetAllChannelPermissionsForUser(ctx, uid)
	mustDo(t, "GetAllChannelPermissionsForUser", err)
	if len(byUser) != 0 {
		t.Errorf("override survived channel delete: %+v", byUser)
	}
}

func TestGetChannelUserOverrides_ByChannel(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	chID := mustCreateChannel(t, database, "listing", "text", "", "", 0)
	a := mustCreateUser(t, database, "aaa", "hash", int(permissions.MemberRoleID))
	b := mustCreateUser(t, database, "bbb", "hash", int(permissions.MemberRoleID))
	mustDo(t, "UpsertChannelUserOverride a", database.UpsertChannelUserOverride(ctx, chID, a, permissions.ReadMessages, 0))
	mustDo(t, "UpsertChannelUserOverride b", database.UpsertChannelUserOverride(ctx, chID, b, 0, permissions.ReadMessages))

	byUser, err := database.GetChannelUserOverrides(ctx, chID)
	mustDo(t, "GetChannelUserOverrides", err)
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
