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

// WP 8.4c: MANAGE_BACKUPS (bit 14) is in permissions.OwnerGrantOnly, so every
// path WP 8.4a guards for MOVE_MEMBERS guards it too: a role create or edit, a
// role assigned, removed, replaced or deleted, and a channel or category
// override. The 8.4a code is generic over the mask; these rows pin it for the
// new bit.

const (
	backupsRoleID   = int64(12) // carries MANAGE_BACKUPS, position 50
	backupsBits     = permissions.ReadMessages | permissions.ManageBackups
	backupsOwnerMsg = "only the owner can change MANAGE_BACKUPS"
)

func TestManageBackups_RoleCreateAndEdit(t *testing.T) {
	ctx := context.Background()
	svc, database := newOwnerGrantRoleService(t)
	seedRole(t, database, &db.Role{ID: backupsRoleID, Name: "Backup Keepers", Permissions: backupsBits, Position: 50})

	_, err := svc.CreateRole(ctx, 2, RoleInput{Name: new("Keepers"), Permissions: new(backupsBits), Position: new(30)})
	if !errors.Is(err, ErrForbidden) || !strings.Contains(err.Error(), backupsOwnerMsg) {
		t.Fatalf("manage-roles create err = %v, want the owner-only refusal naming MANAGE_BACKUPS", err)
	}
	if _, _, err := svc.UpdateRole(ctx, 2, ownerGrantPlainRoleID,
		RoleInput{Permissions: new(ownerGrantNonMoverBits | permissions.ManageBackups)}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("manage-roles add err = %v, want ErrForbidden", err)
	}
	if _, _, err := svc.UpdateRole(ctx, 2, backupsRoleID,
		RoleInput{Permissions: new(permissions.ReadMessages)}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("manage-roles remove err = %v, want ErrForbidden", err)
	}
	stored, _ := database.GetRoleByID(ctx, backupsRoleID)
	if stored.Permissions != backupsBits {
		t.Errorf("refused removal changed the mask to %#x", stored.Permissions)
	}
	// An edit that leaves the bit as it is stays a MANAGE_ROLES edit.
	if _, _, err := svc.UpdateRole(ctx, 2, backupsRoleID,
		RoleInput{Permissions: new(backupsBits | permissions.SendMessages)}); err != nil {
		t.Fatalf("edit that leaves MANAGE_BACKUPS unchanged: %v", err)
	}

	for name, actor := range map[string]int64{"owner": 1, "administrator": ownerGrantSuperUserID} {
		if _, _, err := svc.UpdateRole(ctx, actor, ownerGrantPlainRoleID,
			RoleInput{Permissions: new(ownerGrantNonMoverBits | permissions.ManageBackups)}); err != nil {
			t.Fatalf("%s add: %v", name, err)
		}
		if _, _, err := svc.UpdateRole(ctx, actor, ownerGrantPlainRoleID,
			RoleInput{Permissions: new(ownerGrantNonMoverBits)}); err != nil {
			t.Fatalf("%s remove: %v", name, err)
		}
	}
}

func TestManageBackups_RoleDelete(t *testing.T) {
	ctx := context.Background()
	svc, database := newOwnerGrantRoleService(t)
	seedRole(t, database, &db.Role{ID: backupsRoleID, Name: "Backup Keepers", Permissions: backupsBits, Position: 50})
	if _, _, _, err := svc.DeleteRole(ctx, 2, backupsRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("manage-roles delete err = %v, want ErrForbidden", err)
	}
	if stored, _ := database.GetRoleByID(ctx, backupsRoleID); stored == nil {
		t.Fatal("refused delete removed the role")
	}
	if _, _, _, err := svc.DeleteRole(ctx, 1, backupsRoleID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
}

func TestManageBackups_RoleAssignment(t *testing.T) {
	ctx := context.Background()
	svc, database := newOwnerGrantModerationFixture(t)
	seedRole(t, database, &db.Role{ID: backupsRoleID, Name: "Backup Keepers", Permissions: backupsBits, Position: 50})
	// A MANAGE_ROLES non-owner who holds the bit itself.
	seedRole(t, database, &db.Role{ID: 13, Name: "keeper-lead", Permissions: permissions.ManageRoles | permissions.ManageBackups, Position: 65})
	seedUser(t, database, &db.User{ID: 8, Username: "u8", Status: "offline"})
	seedUserRole(t, database, 8, 13)

	for name, actor := range map[string]int64{"moderator": 3, "holder of the bit": 8} {
		if _, err := svc.AddUserRole(ctx, actor, 5, backupsRoleID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s AddUserRole err = %v, want ErrForbidden", name, err)
		}
		if _, err := svc.ChangeUserRole(ctx, actor, 5, backupsRoleID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s ChangeUserRole err = %v, want ErrForbidden", name, err)
		}
	}
	if slices.Contains(heldIDs(t, database, 5), backupsRoleID) {
		t.Fatal("a refused assignment granted the role")
	}
	if _, err := svc.AddUserRole(ctx, 1, 5, backupsRoleID); err != nil {
		t.Fatalf("owner AddUserRole: %v", err)
	}
	if _, err := svc.RemoveUserRole(ctx, 3, 5, backupsRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator RemoveUserRole err = %v, want ErrForbidden", err)
	}
	if _, err := svc.ChangeUserRole(ctx, 3, 5, memberRolesHelperID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator replacing a carrier role err = %v, want ErrForbidden", err)
	}
	if !slices.Contains(heldIDs(t, database, 5), backupsRoleID) {
		t.Fatal("a refused removal or replacement revoked the role")
	}
	if _, err := svc.RemoveUserRole(ctx, 1, 5, backupsRoleID); err != nil {
		t.Fatalf("owner RemoveUserRole: %v", err)
	}
}

func TestManageBackups_Overrides(t *testing.T) {
	ctx := context.Background()
	svc, database, _, low, ch := seedOverrideFixture(t)
	holder := &db.Role{ID: 34, Name: "chan-keeper", Position: 50,
		Permissions: permissions.ManageChannels | permissions.ReadMessages | permissions.ManageBackups}
	admin := &db.Role{ID: 35, Name: "chan-super2", Position: 90, Permissions: permissions.Administrator}
	seedRole(t, database, holder)
	seedRole(t, database, admin)

	for name, mask := range map[string][2]int64{"allow": {permissions.ManageBackups, 0}, "deny": {0, permissions.ManageBackups}} {
		_, err := svc.PutRoleOverride(ctx, 7, holder, ch, low.ID, mask[0], mask[1])
		if !errors.Is(err, ErrForbidden) || !strings.HasPrefix(err.Error(), backupsOwnerMsg) {
			t.Fatalf("%s: err = %v, want the owner-only refusal", name, err)
		}
	}
	if allow, deny, _ := database.GetChannelPermissions(ctx, ch.ID, low.ID); allow != 0 || deny != 0 {
		t.Fatalf("refused writes persisted (%#x,%#x)", allow, deny)
	}
	if _, err := svc.PutRoleOverride(ctx, 7, admin, ch, low.ID, permissions.ManageBackups, 0); err != nil {
		t.Fatalf("administrator add: %v", err)
	}
	if _, err := svc.DeleteRoleOverride(ctx, 7, holder, ch, low.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("holder delete err = %v, want ErrForbidden", err)
	}
}
