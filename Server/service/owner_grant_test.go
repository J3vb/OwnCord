package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.4a (G1): bits in permissions.OwnerGrantOnly (MOVE_MEMBERS) are changed
// only by the owner or an Administrator: on a role (create, edit, delete), by
// assigning, removing or replacing a role that carries them, and in a channel
// or category override's allow or deny. MANAGE_ROLES or MANAGE_CHANNELS alone,
// even with the bit held, is not enough.

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
		{"manage-roles holder of the bit refused", 6, true},
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
	holds := func() bool { return slices.Contains(heldIDs(t, database, 5), ownerGrantVoiceRoleID) }
	for name, actor := range map[string]int64{"moderator": 3, "holder of the bit": 6} {
		if _, err := svc.RemoveUserRole(ctx, actor, 5, ownerGrantVoiceRoleID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s remove err = %v, want ErrForbidden", name, err)
		}
		if !holds() {
			t.Fatalf("%s: refused removal revoked the role", name)
		}
	}
	if _, err := svc.RemoveUserRole(ctx, 1, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("owner remove: %v", err)
	}
	if holds() {
		t.Fatal("owner removal left the role")
	}
}

func TestChangeUserRole_RoleCarryingOwnerGrantOnlyBit_NeedsTheBit(t *testing.T) {
	svc, _ := newOwnerGrantModerationFixture(t)
	if _, err := svc.ChangeUserRole(context.Background(), 3, 5, ownerGrantVoiceRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ChangeUserRole err = %v, want ErrForbidden", err)
	}
	if _, err := svc.ChangeUserRole(context.Background(), 6, 5, ownerGrantVoiceRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder of the bit ChangeUserRole err = %v, want ErrForbidden", err)
	}
}

// Replacing a member's roles clears the ones they hold now: a MANAGE_ROLES
// non-owner cannot strip a carrier role that way either.
func TestChangeUserRole_CannotStripACarrierRole(t *testing.T) {
	svc, database := newOwnerGrantModerationFixture(t)
	ctx := context.Background()
	if _, err := svc.AddUserRole(ctx, 1, 5, ownerGrantVoiceRoleID); err != nil {
		t.Fatalf("owner setup add: %v", err)
	}
	if _, err := svc.ChangeUserRole(ctx, 3, 5, memberRolesHelperID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator ChangeUserRole err = %v, want ErrForbidden", err)
	}
	if !slices.Contains(heldIDs(t, database, 5), ownerGrantVoiceRoleID) {
		t.Fatal("refused change cleared the carrier role")
	}
	if _, err := svc.ChangeUserRole(ctx, 1, 5, memberRolesHelperID); err != nil {
		t.Fatalf("owner ChangeUserRole: %v", err)
	}
	if slices.Contains(heldIDs(t, database, 5), ownerGrantVoiceRoleID) {
		t.Fatal("owner change left the carrier role")
	}
}

func TestDeleteRole_CarryingOwnerGrantOnlyBit(t *testing.T) {
	for name, tc := range map[string]struct {
		actor   int64
		wantErr bool
	}{
		"manage-roles admin refused":      {2, true},
		"owner allowed":                   {1, false},
		"non-owner administrator allowed": {ownerGrantSuperUserID, false},
	} {
		t.Run(name, func(t *testing.T) {
			svc, database := newOwnerGrantRoleService(t)
			_, _, _, err := svc.DeleteRole(context.Background(), tc.actor, ownerGrantVoiceRoleID)
			stored, _ := database.GetRoleByID(context.Background(), ownerGrantVoiceRoleID)
			if tc.wantErr {
				if !errors.Is(err, ErrForbidden) || stored == nil {
					t.Fatalf("err = %v, role present = %v; want ErrForbidden and the role kept", err, stored != nil)
				}
				return
			}
			if err != nil || stored != nil {
				t.Fatalf("err = %v, role present = %v; want deleted", err, stored != nil)
			}
		})
	}
}

// A default role that carries the bit would hand it to members left with no
// other role, so deleting any role then needs the owner too.
func TestDeleteRole_FallbackCarryingOwnerGrantOnlyBit(t *testing.T) {
	svc, database := newOwnerGrantRoleService(t)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE is_default = 1`, permissions.MoveMembers); err != nil {
		t.Fatalf("set default role bit: %v", err)
	}
	if _, _, _, err := svc.DeleteRole(context.Background(), 2, ownerGrantPlainRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("manage-roles admin err = %v, want ErrForbidden", err)
	}
	if _, _, _, err := svc.DeleteRole(context.Background(), 1, ownerGrantPlainRoleID); err != nil {
		t.Fatalf("owner: %v", err)
	}
}
