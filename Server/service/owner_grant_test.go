package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.4a (G1): bits in permissions.OwnerGrantOnly (MOVE_MEMBERS) are changed
// on a role, or handed out by assigning a role that carries them, only by the
// owner or an Administrator. MANAGE_ROLES alone, even with the bit held, is
// not enough.

const (
	ownerGrantVoiceRoleID  = int64(8) // carries MOVE_MEMBERS, position 50
	ownerGrantSuperRoleID  = int64(9) // ADMINISTRATOR but not the owner, position 70
	ownerGrantSuperUserID  = int64(7)
	ownerGrantPlainRoleID  = int64(10) // no owner-grant bits, position 45
	ownerGrantMoverBits    = permissions.ReadMessages | permissions.MoveMembers
	ownerGrantNonMoverBits = permissions.ReadMessages | permissions.SendMessages
)

func newOwnerGrantRoleService(t *testing.T) (*RoleService, *db.DB) {
	t.Helper()
	svc, database := newRoleCRUDService(t)
	seedRole(t, database, &db.Role{ID: ownerGrantVoiceRoleID, Name: "Voice Movers", Permissions: ownerGrantMoverBits, Position: 50})
	seedRole(t, database, &db.Role{ID: ownerGrantPlainRoleID, Name: "Plain", Permissions: ownerGrantNonMoverBits, Position: 45})
	seedRole(t, database, &db.Role{ID: ownerGrantSuperRoleID, Name: "Super", Position: 70,
		Permissions: permissions.Administrator | permissions.ManageRoles})
	seedUser(t, database, &db.User{ID: ownerGrantSuperUserID})
	seedUserRole(t, database, ownerGrantSuperUserID, ownerGrantSuperRoleID)
	return svc, database
}

func TestCreateRole_OwnerGrantOnlyBit(t *testing.T) {
	cases := []struct {
		name    string
		actor   int64
		wantErr bool
	}{
		{"manage-roles admin holding the bit is refused", 2, true},
		{"manage-roles moderator is refused", 3, true},
		{"owner allowed", 1, false},
		{"non-owner administrator allowed", ownerGrantSuperUserID, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := newOwnerGrantRoleService(t)
			_, err := svc.CreateRole(context.Background(), tc.actor, RoleInput{
				Name:        new("Movers"),
				Permissions: new(ownerGrantMoverBits),
				Position:    new(30),
			})
			if tc.wantErr {
				if !errors.Is(err, ErrForbidden) {
					t.Fatalf("CreateRole err = %v, want ErrForbidden", err)
				}
				if !strings.Contains(err.Error(), "only the owner can change MOVE_MEMBERS") {
					t.Errorf("err = %q, want it to name MOVE_MEMBERS", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("CreateRole: %v", err)
			}
		})
	}
}

func TestUpdateRole_OwnerGrantOnlyBit_AddRefusedForManageRoles(t *testing.T) {
	svc, database := newOwnerGrantRoleService(t)
	_, _, err := svc.UpdateRole(context.Background(), 2, ownerGrantPlainRoleID,
		RoleInput{Permissions: new(ownerGrantNonMoverBits | permissions.MoveMembers)})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("add err = %v, want ErrForbidden", err)
	}
	stored, _ := database.GetRoleByID(context.Background(), ownerGrantPlainRoleID)
	if stored.Permissions != ownerGrantNonMoverBits {
		t.Errorf("refused add changed the mask to %#x", stored.Permissions)
	}
}

func TestUpdateRole_OwnerGrantOnlyBit_RemoveRefusedForManageRoles(t *testing.T) {
	svc, database := newOwnerGrantRoleService(t)
	_, _, err := svc.UpdateRole(context.Background(), 2, ownerGrantVoiceRoleID,
		RoleInput{Permissions: new(permissions.ReadMessages)})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("remove err = %v, want ErrForbidden", err)
	}
	stored, _ := database.GetRoleByID(context.Background(), ownerGrantVoiceRoleID)
	if stored.Permissions != ownerGrantMoverBits {
		t.Errorf("refused removal changed the mask to %#x", stored.Permissions)
	}
}

func TestUpdateRole_OwnerGrantOnlyBit_UnrelatedEditOfCarrierAllowed(t *testing.T) {
	svc, _ := newOwnerGrantRoleService(t)
	// Same bits re-sent, a different bit added the actor holds: the owner-grant
	// bit does not change, so MANAGE_ROLES is enough.
	if _, _, err := svc.UpdateRole(context.Background(), 2, ownerGrantVoiceRoleID,
		RoleInput{Permissions: new(ownerGrantMoverBits | permissions.SendMessages)}); err != nil {
		t.Fatalf("edit that leaves MOVE_MEMBERS unchanged: %v", err)
	}
}

func TestUpdateRole_OwnerGrantOnlyBit_OwnerAndAdministratorAllowed(t *testing.T) {
	for name, actor := range map[string]int64{"owner": 1, "administrator": ownerGrantSuperUserID} {
		t.Run(name, func(t *testing.T) {
			svc, database := newOwnerGrantRoleService(t)
			if _, _, err := svc.UpdateRole(context.Background(), actor, ownerGrantPlainRoleID,
				RoleInput{Permissions: new(ownerGrantNonMoverBits | permissions.MoveMembers)}); err != nil {
				t.Fatalf("add: %v", err)
			}
			if _, _, err := svc.UpdateRole(context.Background(), actor, ownerGrantVoiceRoleID,
				RoleInput{Permissions: new(permissions.ReadMessages)}); err != nil {
				t.Fatalf("remove: %v", err)
			}
			plain, _ := database.GetRoleByID(context.Background(), ownerGrantPlainRoleID)
			if plain.Permissions&permissions.MoveMembers == 0 {
				t.Error("add did not persist MOVE_MEMBERS")
			}
			voice, _ := database.GetRoleByID(context.Background(), ownerGrantVoiceRoleID)
			if voice.Permissions&permissions.MoveMembers != 0 {
				t.Error("remove did not clear MOVE_MEMBERS")
			}
		})
	}
}

func newOwnerGrantModerationFixture(t *testing.T) (*ModerationService, *db.DB) {
	t.Helper()
	svc, database := newMemberRolesFixture(t)
	seedRole(t, database, &db.Role{ID: ownerGrantVoiceRoleID, Name: "voice", Permissions: ownerGrantMoverBits, Position: 50})
	// A non-owner, non-Administrator who holds MANAGE_ROLES and the bit.
	seedRole(t, database, &db.Role{ID: 11, Name: "lead", Permissions: permissions.ManageRoles | permissions.MoveMembers, Position: 65})
	seedUser(t, database, &db.User{ID: 6, Username: "u6", Status: "offline"})
	seedUserRole(t, database, 6, 11)
	return svc, database
}

func TestAddUserRole_RoleCarryingOwnerGrantOnlyBit(t *testing.T) {
	cases := []struct {
		name    string
		actor   int64
		wantErr bool
	}{
		{"manage-roles moderator without the bit refused", 3, true},
		{"manage-roles holder of the bit allowed", 6, false},
		{"owner allowed", 1, false},
		{"non-owner administrator allowed", 2, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, database := newOwnerGrantModerationFixture(t)
			_, err := svc.AddUserRole(context.Background(), tc.actor, 5, ownerGrantVoiceRoleID)
			if tc.wantErr {
				if !errors.Is(err, ErrForbidden) {
					t.Fatalf("AddUserRole err = %v, want ErrForbidden", err)
				}
				for _, id := range heldIDs(t, database, 5) {
					if id == ownerGrantVoiceRoleID {
						t.Error("refused add granted the role")
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("AddUserRole: %v", err)
			}
		})
	}
}

func TestRemoveUserRole_RoleCarryingOwnerGrantOnlyBit(t *testing.T) {
	svc, database := newOwnerGrantModerationFixture(t)
	ctx := context.Background()
	if _, err := svc.AddUserRole(ctx, 1, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("owner setup add: %v", err)
	}
	if _, err := svc.RemoveUserRole(ctx, 3, 5, ownerGrantVoiceRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator remove err = %v, want ErrForbidden", err)
	}
	if _, err := svc.RemoveUserRole(ctx, 6, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("holder of the bit remove: %v", err)
	}
	if _, err := svc.AddUserRole(ctx, 1, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("owner re-add: %v", err)
	}
	found := false
	for _, id := range heldIDs(t, database, 5) {
		found = found || id == ownerGrantVoiceRoleID
	}
	if !found {
		t.Fatal("refused removal revoked the role")
	}
	if _, err := svc.RemoveUserRole(ctx, 1, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("owner remove: %v", err)
	}
}

func TestChangeUserRole_RoleCarryingOwnerGrantOnlyBit_NeedsTheBit(t *testing.T) {
	svc, _ := newOwnerGrantModerationFixture(t)
	if _, err := svc.ChangeUserRole(context.Background(), 3, 5, ownerGrantVoiceRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ChangeUserRole err = %v, want ErrForbidden", err)
	}
	if _, err := svc.ChangeUserRole(context.Background(), 6, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("holder of the bit ChangeUserRole: %v", err)
	}
}
