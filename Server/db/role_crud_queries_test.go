package db_test

import (
	"context"
	"testing"
)

// These run against the real embedded migration set (newMigratedTestDB) rather
// than the inline subset: migration 023 adds the case-insensitive name index
// and the delete path touches channel_overrides, neither of which the inline
// schema carries. The migrations seed Owner(1)/Admin(2)/Moderator(3)/Member(4,
// default).

func TestGetRoleByName_IsCaseInsensitive(t *testing.T) {
	database := newMigratedTestDB(t)

	for _, name := range []string{"Member", "member", "MEMBER"} {
		role, err := database.GetRoleByName(context.Background(), name)
		if err != nil {
			t.Fatalf("GetRoleByName(%q): %v", name, err)
		}
		if role == nil || role.ID != 4 {
			t.Errorf("GetRoleByName(%q) = %v, want the Member role", name, role)
		}
	}
	role, err := database.GetRoleByName(context.Background(), "nobody")
	if err != nil {
		t.Fatalf("GetRoleByName(missing): %v", err)
	}
	if role != nil {
		t.Errorf("GetRoleByName(missing) = %v, want nil", role)
	}
}

func TestRoleNameUniquenessIsEnforcedCaseInsensitively(t *testing.T) {
	database := newMigratedTestDB(t)

	// Migration 023's index is what makes "moderator" and "Moderator" the same
	// name — without it the two roles would coexist and the client's
	// case-insensitive lookup would pick one arbitrarily.
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (name, permissions, position, is_default) VALUES ('moderator', 0, 5, 0)`)
	if err == nil {
		t.Fatal("inserting a case-colliding role name succeeded, want a UNIQUE violation")
	}
}

func TestGetDefaultRole(t *testing.T) {
	database := newMigratedTestDB(t)

	role, err := database.GetDefaultRole(context.Background())
	if err != nil {
		t.Fatalf("GetDefaultRole: %v", err)
	}
	if role == nil || role.ID != 4 || !role.IsDefault {
		t.Fatalf("GetDefaultRole = %v, want the seeded Member role", role)
	}
}

func TestCreateAndUpdateRole(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	color := "#ABCDEF"
	created, err := database.CreateRole(ctx, "Helper", &color, 0x3, 55)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if created.ID == 0 || created.Name != "Helper" || created.Position != 55 {
		t.Fatalf("created = %+v", created)
	}
	if created.IsDefault {
		t.Error("CreateRole must never produce a default role")
	}

	if err := database.UpdateRole(ctx, created.ID, "Helpers", nil, 0x7, 56); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	got, err := database.GetRoleByID(ctx, created.ID)
	if err != nil || got == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if got.Name != "Helpers" || got.Color != nil || got.Permissions != 0x7 || got.Position != 56 {
		t.Errorf("updated role = %+v", got)
	}
}

func TestSetRolePositions(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	if err := database.SetRolePositions(ctx, map[int64]int{2: 3, 3: 2, 4: 1}); err != nil {
		t.Fatalf("SetRolePositions: %v", err)
	}
	for id, want := range map[int64]int{1: 100, 2: 3, 3: 2, 4: 1} {
		role, err := database.GetRoleByID(ctx, id)
		if err != nil || role == nil {
			t.Fatalf("GetRoleByID(%d): %v", id, err)
		}
		if role.Position != want {
			t.Errorf("role %d position = %d, want %d", id, role.Position, want)
		}
	}
	// An empty map is a no-op rather than an empty transaction.
	if err := database.SetRolePositions(ctx, nil); err != nil {
		t.Errorf("SetRolePositions(nil): %v", err)
	}
}

func TestListRoles_OrdersByPositionThenIDDeterministically(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	// Positions are only "unique enough": reorder normalizes them, but creating
	// a role inserts just below the actor and may tie with an existing role. A
	// tie must still order deterministically — the admin panel derives its
	// reorder payload from this order, so an unstable one would make a single
	// move-up silently shuffle the tied roles among themselves.
	tied := []string{"Tie-A", "Tie-B", "Tie-C"}
	created := make([]int64, 0, len(tied))
	for _, name := range tied {
		role, err := database.CreateRole(ctx, name, nil, 0, 30)
		if err != nil {
			t.Fatalf("CreateRole %s: %v", name, err)
		}
		created = append(created, role.ID)
	}

	var lastOrder []int64
	for range 5 {
		roles, err := database.ListRoles(ctx)
		if err != nil {
			t.Fatalf("ListRoles: %v", err)
		}
		order := make([]int64, 0, len(roles))
		var prev = -1
		for _, r := range roles {
			if prev >= 0 && r.Position > prev {
				t.Fatalf("ListRoles is not position-descending: %d after %d", r.Position, prev)
			}
			prev = r.Position
			if r.Position == 30 {
				order = append(order, r.ID)
			}
		}
		// Ties come back in ascending id order, every time.
		if len(order) != len(created) {
			t.Fatalf("found %d roles at position 30, want %d", len(order), len(created))
		}
		for i, id := range created {
			if order[i] != id {
				t.Errorf("tied role %d = id %d, want %d (order %v)", i, order[i], id, order)
			}
		}
		if lastOrder != nil {
			for i := range order {
				if order[i] != lastOrder[i] {
					t.Fatalf("tied ordering is unstable across calls: %v then %v", lastOrder, order)
				}
			}
		}
		lastOrder = order
	}
}

func TestCountRoleMembersAndListUserIDsByRole(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	a, err := database.CreateUser(ctx, "counta", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := database.CreateUser(ctx, "countb", "hash", 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := database.CreateUser(ctx, "countc", "hash", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	counts, err := database.CountRoleMembers(ctx)
	if err != nil {
		t.Fatalf("CountRoleMembers: %v", err)
	}
	if counts[4] != 2 || counts[3] != 1 {
		t.Errorf("counts = %v, want 2 members on role 4 and 1 on role 3", counts)
	}
	// A role nobody holds is absent rather than present with a zero.
	if _, present := counts[1]; present {
		t.Errorf("counts carries an entry for the memberless owner role: %v", counts)
	}

	ids, err := database.ListUserIDsByRole(ctx, 4)
	if err != nil {
		t.Fatalf("ListUserIDsByRole: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ListUserIDsByRole = %v, want 2 ids", ids)
	}
	found := false
	for _, id := range ids {
		if id == a {
			found = true
		}
	}
	if !found {
		t.Errorf("ListUserIDsByRole = %v, missing user %d", ids, a)
	}
}

func TestDeleteRoleReassigning(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	role, err := database.CreateRole(ctx, "Temp", nil, 0x3, 50)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	moved, err := database.CreateUser(ctx, "tempuser", "hash", int(role.ID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	stayer, err := database.CreateUser(ctx, "stayer", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.UpsertChannelOverride(ctx, chID, role.ID, 0, 0x2); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	ids, err := database.DeleteRoleReassigning(ctx, role.ID, 4)
	if err != nil {
		t.Fatalf("DeleteRoleReassigning: %v", err)
	}
	if len(ids) != 1 || ids[0] != moved {
		t.Fatalf("reassigned ids = %v, want [%d]", ids, moved)
	}

	user, err := database.GetUserByID(ctx, moved)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.RoleID != 4 {
		t.Errorf("moved user role = %d, want the fallback 4", user.RoleID)
	}
	other, _ := database.GetUserByID(ctx, stayer)
	if other.RoleID != 3 {
		t.Errorf("unrelated user role = %d, want 3 — the UPDATE must be scoped", other.RoleID)
	}
	if gone, err := database.GetRoleByID(ctx, role.ID); err != nil || gone != nil {
		t.Errorf("role survived the delete: %v, %v", gone, err)
	}
	overrides, err := database.GetChannelOverrides(ctx, chID)
	if err != nil {
		t.Fatalf("GetChannelOverrides: %v", err)
	}
	if _, present := overrides[role.ID]; present {
		t.Error("the deleted role's channel_overrides row survived")
	}
}
