package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// OC-0374: ReorderRoles used to compact the manageable roles into a gapless
// N…1 block. CreateRole's default placement only accepts a strictly-positive
// unoccupied slot below the actor, so after one reorder there was no such slot
// for any actor below the owner and role creation failed permanently — and the
// error told the admin to "reorder existing roles first", which re-compacted to
// the same dense block and could not help.
//
// The rule these tests pin: a reorder preserves the requested order and leaves
// the roles spread through the range below the actor, so every manager below
// still has somewhere to put a new role.

func TestReorderRoles_LeavesRoomToCreateBelow(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	ctx := context.Background()

	// The owner reorders every role below its own rank — the one click on the
	// admin panel's reorder arrow that used to be enough to wedge the server.
	if _, err := svc.ReorderRoles(ctx, 1, []int64{
		permissions.AdminRoleID, permissions.ModeratorRoleID, permissions.MemberRoleID,
	}); err != nil {
		t.Fatalf("ReorderRoles as the owner: %v", err)
	}

	// The Admin (user 2) holds MANAGE_ROLES and creates a role without naming a
	// position, which is what the panel's Create Role form sends.
	created, err := svc.CreateRole(ctx, 2, RoleInput{Name: new("Helper")})
	if err != nil {
		t.Fatalf("CreateRole after a reorder: %v", err)
	}

	admin := roleByID(t, ctx, svc, permissions.AdminRoleID)
	if created.Position <= 0 || created.Position >= admin.Position {
		t.Errorf("new role position = %d, want a free slot strictly between 0 and the actor's %d",
			created.Position, admin.Position)
	}
}

// The spacing has to survive repeated reorders: a manager who reorders their
// own subtree must not compact it out of room either.
func TestReorderRoles_SpacingSurvivesRepeatedReorders(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	ctx := context.Background()

	for i := range 3 {
		if _, err := svc.ReorderRoles(ctx, 1, []int64{
			permissions.AdminRoleID, permissions.ModeratorRoleID, permissions.MemberRoleID,
		}); err != nil {
			t.Fatalf("owner reorder %d: %v", i, err)
		}
		if _, err := svc.ReorderRoles(ctx, 2, []int64{
			permissions.ModeratorRoleID, permissions.MemberRoleID,
		}); err != nil {
			t.Fatalf("admin reorder %d: %v", i, err)
		}
	}

	// Both managers can still place a new role after all of that.
	if _, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("OwnerMade")}); err != nil {
		t.Errorf("owner CreateRole after repeated reorders: %v", err)
	}
	if _, err := svc.CreateRole(ctx, 2, RoleInput{Name: new("AdminMade")}); err != nil {
		t.Errorf("admin CreateRole after repeated reorders: %v", err)
	}
}

// roleByID reads one role back through the store the service uses.
func roleByID(t *testing.T, ctx context.Context, svc *RoleService, id int64) *db.Role {
	t.Helper()
	roles, err := svc.st.ListRoles(ctx)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	for _, r := range roles {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("role %d not found", id)
	return nil
}
