package db_test

import (
	"context"
	"testing"
)

// ─── GetRoleByID tests ────────────────────────────────────────────────────────

func TestGetRoleByID_Found(t *testing.T) {
	database := newTestDB(t)

	role, err := database.GetRoleByID(context.Background(), 4) // Member — inserted by migration
	if err != nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if role == nil {
		t.Fatal("GetRoleByID returned nil for Member role")
	}
	if role.Name != "Member" {
		t.Errorf("Name = %q, want %q", role.Name, "Member")
	}
	if role.Permissions == 0 {
		t.Error("Member permissions = 0, want non-zero")
	}
}

func TestGetRoleByID_NotFound(t *testing.T) {
	database := newTestDB(t)

	role, err := database.GetRoleByID(context.Background(), 9999)
	if err != nil {
		t.Fatalf("GetRoleByID(not found): %v", err)
	}
	if role != nil {
		t.Error("GetRoleByID returned non-nil for missing role")
	}
}

func TestGetRoleByID_OwnerHasAllPermissions(t *testing.T) {
	database := newTestDB(t)

	role, err := database.GetRoleByID(context.Background(), 1) // Owner
	if err != nil {
		t.Fatalf("GetRoleByID Owner: %v", err)
	}
	if role == nil {
		t.Fatal("GetRoleByID returned nil for Owner role")
	}
	// Owner has permissions = 0x7FFFFFFF = 2147483647
	if role.Permissions != 2147483647 {
		t.Errorf("Owner Permissions = %d, want 2147483647", role.Permissions)
	}
}

func TestGetRoleByID_IsDefaultField(t *testing.T) {
	database := newTestDB(t)

	owner, _ := database.GetRoleByID(context.Background(), 1)
	member, _ := database.GetRoleByID(context.Background(), 4)

	if owner.IsDefault {
		t.Error("Owner.IsDefault = true, want false")
	}
	// Member is the default role (is_default=1 in the migration).
	if !member.IsDefault {
		t.Error("Member.IsDefault = false, want true (Member is the default role for new users)")
	}
}

// ─── ListRoles tests ──────────────────────────────────────────────────────────

func TestListRoles_ReturnsFourDefaultRoles(t *testing.T) {
	database := newTestDB(t)

	roles, err := database.ListRoles(context.Background())
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	if len(roles) != 4 {
		t.Errorf("ListRoles count = %d, want 4", len(roles))
	}
}

func TestListRoles_OrderedByPositionDesc(t *testing.T) {
	database := newTestDB(t)

	roles, err := database.ListRoles(context.Background())
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}

	for i := 1; i < len(roles); i++ {
		if roles[i].Position > roles[i-1].Position {
			t.Errorf("ListRoles not ordered by position DESC: index %d (%d) > index %d (%d)",
				i, roles[i].Position, i-1, roles[i-1].Position)
		}
	}
}

// ─── GetUserWithRole tests ────────────────────────────────────────────────────

func TestGetUserWithRole_Found(t *testing.T) {
	database := newTestDB(t)
	uid, err := database.CreateUser(context.Background(), "joinuser", "hash", 4) // Member role
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	user, role, err := database.GetUserWithRole(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserWithRole: %v", err)
	}
	if user == nil || role == nil {
		t.Fatal("GetUserWithRole returned nil user or role")
	}
	if user.ID != uid {
		t.Errorf("user.ID = %d, want %d", user.ID, uid)
	}
	if user.Username != "joinuser" {
		t.Errorf("user.Username = %q, want %q", user.Username, "joinuser")
	}
	if role.ID != 4 {
		t.Errorf("role.ID = %d, want 4 (Member)", role.ID)
	}
	if role.Name != "Member" {
		t.Errorf("role.Name = %q, want %q", role.Name, "Member")
	}
	if role.Permissions == 0 {
		t.Error("role.Permissions = 0, want non-zero for Member")
	}
}

func TestGetUserWithRole_NotFound(t *testing.T) {
	database := newTestDB(t)

	user, role, err := database.GetUserWithRole(context.Background(), 9999)
	if err != nil {
		t.Fatalf("GetUserWithRole(not found): %v", err)
	}
	if user != nil || role != nil {
		t.Error("GetUserWithRole returned non-nil for missing user")
	}
}

func TestGetUserWithRole_BoolConversions(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "booluser", "hash", 4)

	user, role, err := database.GetUserWithRole(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserWithRole: %v", err)
	}
	// Fresh user should not be banned.
	if user.Banned {
		t.Error("user.Banned = true, want false for new user")
	}
	// Member role has is_default=1.
	if !role.IsDefault {
		t.Error("role.IsDefault = false, want true for Member")
	}
}

// ─── ListInvites tests ────────────────────────────────────────────────────────

func TestListInvites_Empty(t *testing.T) {
	database := newTestDB(t)

	invites, err := database.ListInvites(context.Background())
	if err != nil {
		t.Fatalf("ListInvites empty: %v", err)
	}
	if len(invites) != 0 {
		t.Errorf("ListInvites empty = %d items, want 0", len(invites))
	}
}

func TestListInvites_Multiple(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "listowner", "hash", 4)

	_, _ = database.CreateInvite(context.Background(), uid, 1, nil)
	_, _ = database.CreateInvite(context.Background(), uid, 5, nil)
	_, _ = database.CreateInvite(context.Background(), uid, 0, nil)

	invites, err := database.ListInvites(context.Background())
	if err != nil {
		t.Fatalf("ListInvites multiple: %v", err)
	}
	if len(invites) != 3 {
		t.Errorf("ListInvites count = %d, want 3", len(invites))
	}
}

func TestListInvites_IncludesRevokedInvites(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "revokelistowner", "hash", 4)

	code, _ := database.CreateInvite(context.Background(), uid, 1, nil)
	_ = database.RevokeInvite(context.Background(), code)
	_, _ = database.CreateInvite(context.Background(), uid, 0, nil) // active

	invites, err := database.ListInvites(context.Background())
	if err != nil {
		t.Fatalf("ListInvites with revoked: %v", err)
	}
	if len(invites) != 2 {
		t.Errorf("ListInvites count = %d, want 2", len(invites))
	}

	var revokedCount int
	for _, inv := range invites {
		if inv.Revoked {
			revokedCount++
		}
	}
	if revokedCount != 1 {
		t.Errorf("ListInvites revoked count = %d, want 1", revokedCount)
	}
}
