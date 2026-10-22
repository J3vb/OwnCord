package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 6.3c: ListMembers carries every held role, top first, and the role flags
// and position moves written through the db layer keep the mirror coherent.
func TestListMembers_CarriesRoleIDsTopFirst(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	multi, err := database.CreateUser(ctx, "multi", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	single, err := database.CreateUser(ctx, "single", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, multi, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	members, err := database.ListMembers(ctx)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	byID := map[int64]db.MemberSummary{}
	for _, m := range members {
		byID[m.ID] = m
	}
	if got := byID[multi].RoleIDs; !slices.Equal(got, []int64{permissions.ModeratorRoleID, permissions.MemberRoleID}) {
		t.Errorf("multi-role RoleIDs = %v, want [moderator member]", got)
	}
	if byID[multi].Role != "moderator" {
		t.Errorf("multi-role Role = %q, want the top role's name", byID[multi].Role)
	}
	if got := byID[single].RoleIDs; !slices.Equal(got, []int64{permissions.MemberRoleID}) {
		t.Errorf("single-role RoleIDs = %v, want [member]", got)
	}
}

func TestRoleFlags_RoundTripAndPositionResync(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	helper, err := database.CreateRole(ctx, "Helper", nil, permissions.ReadMessages, 50, true, false)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if !helper.Hoist || helper.Mentionable {
		t.Fatalf("created = %+v, want hoist and not mentionable", helper)
	}
	uid, err := database.CreateUser(ctx, "holder", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, helper.ID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := mirrorRoleID(t, database, uid); got != helper.ID {
		t.Fatalf("mirror = %d, want helper on top", got)
	}

	// Moving the role below Member (40) re-ranks the holder in the same write.
	resynced, err := database.UpdateRole(ctx, helper.ID, "Helper", nil, permissions.ReadMessages, 30, false, true)
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if !slices.Equal(resynced, []int64{uid}) {
		t.Errorf("resynced = %v, want [%d]", resynced, uid)
	}
	if got := mirrorRoleID(t, database, uid); got != permissions.MemberRoleID {
		t.Errorf("mirror after the move = %d, want member", got)
	}
	got, err := database.GetRoleByID(ctx, helper.ID)
	if err != nil || got == nil || got.Hoist || !got.Mentionable {
		t.Fatalf("stored = %+v, %v, want hoist cleared and mentionable set", got, err)
	}

	// A write that leaves the position alone resyncs nobody.
	if resynced, err = database.UpdateRole(ctx, helper.ID, "Helper2", nil, permissions.ReadMessages, 30, false, true); err != nil || len(resynced) != 0 {
		t.Errorf("rename: resynced = %v, %v, want none", resynced, err)
	}

	// SetRolePositions re-ranks multi-role holders too, and only them.
	other, err := database.CreateUser(ctx, "single", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	resynced, err = database.SetRolePositions(ctx, map[int64]int{helper.ID: 55})
	if err != nil {
		t.Fatalf("SetRolePositions: %v", err)
	}
	if !slices.Equal(resynced, []int64{uid}) || slices.Contains(resynced, other) {
		t.Errorf("SetRolePositions resynced = %v, want just the multi-role holder [%d]", resynced, uid)
	}
	if got := mirrorRoleID(t, database, uid); got != helper.ID {
		t.Errorf("mirror after reorder = %d, want helper on top again", got)
	}
}
