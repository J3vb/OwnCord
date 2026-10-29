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

// WP 8.4d: the seven owner-type bits are in permissions.OwnerGrantOnly. The
// five owner-tier bits (permissions.OwnerOnlyGrant) are stricter: only the
// owner changes them, an Administrator does not, because the owner tier
// ignores ADMINISTRATOR and an Administrator could otherwise give the bit to
// themself. VIEW_DIAGNOSTICS and ERASE_ACCOUNTS stay owner-or-Administrator.

var ownerTierBits = []int64{
	permissions.RestoreBackups, permissions.ManageConfig, permissions.ManageUpdates,
	permissions.ManageTokens, permissions.IssueRecovery,
}

var administratorTierBits = []int64{permissions.ViewDiagnostics, permissions.EraseAccounts}

const (
	otCarrierRoleID = int64(14) // carries one owner-type bit, position 50
	otLeadRoleID    = int64(15) // MANAGE_ROLES, position 65
	otLeadUserID    = int64(9)
)

func otOwnerMsg(bit int64) string { return "only the owner can change " + permissions.Name(bit) }

func TestOwnerTypeBits_RoleCreateAndEdit(t *testing.T) {
	for _, bit := range append(slices.Clone(ownerTierBits), administratorTierBits...) {
		ownerTier := slices.Contains(ownerTierBits, bit)
		t.Run(permissions.Name(bit), func(t *testing.T) {
			ctx := context.Background()
			svc, database := newOwnerGrantRoleService(t)
			seedRole(t, database, &db.Role{ID: otCarrierRoleID, Name: "Carrier", Permissions: ownerGrantNonMoverBits | bit, Position: 50})

			// A MANAGE_ROLES moderator is refused for every owner-type bit.
			_, err := svc.CreateRole(ctx, 3, RoleInput{Name: new("X"), Permissions: new(ownerGrantNonMoverBits | bit), Position: new(30)})
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("moderator create err = %v, want ErrForbidden", err)
			}

			// ManageRoles+Administrator: refused for the owner tier, allowed for the admin tier.
			_, createErr := svc.CreateRole(ctx, ownerGrantSuperUserID, RoleInput{Name: new("Y"), Permissions: new(ownerGrantNonMoverBits | bit), Position: new(30)})
			_, _, addErr := svc.UpdateRole(ctx, ownerGrantSuperUserID, ownerGrantPlainRoleID, RoleInput{Permissions: new(ownerGrantNonMoverBits | bit)})
			_, _, removeErr := svc.UpdateRole(ctx, ownerGrantSuperUserID, otCarrierRoleID, RoleInput{Permissions: new(ownerGrantNonMoverBits)})
			for name, e := range map[string]error{"create": createErr, "add": addErr, "remove": removeErr} {
				if ownerTier {
					if !errors.Is(e, ErrForbidden) || !strings.Contains(e.Error(), otOwnerMsg(bit)) {
						t.Errorf("administrator %s err = %v, want the owner-only refusal naming %s", name, e, permissions.Name(bit))
					}
				} else if e != nil {
					t.Errorf("administrator %s: %v, want allowed", name, e)
				}
			}
			if ownerTier {
				if stored, _ := database.GetRoleByID(ctx, otCarrierRoleID); stored.Permissions&bit == 0 {
					t.Error("refused removal cleared the bit")
				}
			}

			// The owner may do all three.
			if _, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Z"), Permissions: new(ownerGrantNonMoverBits | bit), Position: new(31)}); err != nil {
				t.Errorf("owner create: %v", err)
			}
			if _, _, err := svc.UpdateRole(ctx, 1, otCarrierRoleID, RoleInput{Permissions: new(ownerGrantNonMoverBits)}); err != nil {
				t.Errorf("owner remove: %v", err)
			}
			if _, _, err := svc.UpdateRole(ctx, 1, otCarrierRoleID, RoleInput{Permissions: new(ownerGrantNonMoverBits | bit)}); err != nil {
				t.Errorf("owner add: %v", err)
			}
		})
	}
}

func TestOwnerTypeBits_RoleDelete(t *testing.T) {
	ctx := context.Background()
	for _, bit := range []int64{permissions.RestoreBackups, permissions.ViewDiagnostics} {
		ownerTier := slices.Contains(ownerTierBits, bit)
		svc, database := newOwnerGrantRoleService(t)
		seedRole(t, database, &db.Role{ID: otCarrierRoleID, Name: "Carrier", Permissions: ownerGrantNonMoverBits | bit, Position: 50})
		_, _, _, err := svc.DeleteRole(ctx, ownerGrantSuperUserID, otCarrierRoleID)
		if ownerTier && !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: administrator delete err = %v, want ErrForbidden", permissions.Name(bit), err)
		}
		if !ownerTier && err != nil {
			t.Errorf("%s: administrator delete: %v, want allowed", permissions.Name(bit), err)
		}
	}
}

func TestOwnerTypeBits_RoleAssignment(t *testing.T) {
	for _, bit := range append(slices.Clone(ownerTierBits), administratorTierBits...) {
		ownerTier := slices.Contains(ownerTierBits, bit)
		t.Run(permissions.Name(bit), func(t *testing.T) {
			ctx := context.Background()
			svc, database := newOwnerGrantModerationFixture(t)
			seedRole(t, database, &db.Role{ID: otCarrierRoleID, Name: "Carrier", Permissions: permissions.ReadMessages | bit, Position: 50})
			// Admin user 2 is the seeded Administrator-level actor of this fixture.
			seedRole(t, database, &db.Role{ID: otLeadRoleID, Name: "lead2", Permissions: permissions.ManageRoles | bit, Position: 66})
			seedUser(t, database, &db.User{ID: otLeadUserID, Username: "lead2", Status: "offline"})
			seedUserRole(t, database, otLeadUserID, otLeadRoleID)

			// MANAGE_ROLES, even holding the bit itself, is refused.
			for name, actor := range map[string]int64{"moderator": 3, "holder": otLeadUserID} {
				if _, err := svc.AddUserRole(ctx, actor, 5, otCarrierRoleID); !errors.Is(err, ErrForbidden) {
					t.Fatalf("%s AddUserRole err = %v, want ErrForbidden", name, err)
				}
				if _, err := svc.ChangeUserRole(ctx, actor, 5, otCarrierRoleID); !errors.Is(err, ErrForbidden) {
					t.Fatalf("%s ChangeUserRole err = %v, want ErrForbidden", name, err)
				}
			}
			// Administrator: refused for the owner tier, allowed for the admin tier.
			_, err := svc.AddUserRole(ctx, 2, 5, otCarrierRoleID)
			if ownerTier && !errors.Is(err, ErrForbidden) {
				t.Fatalf("administrator AddUserRole err = %v, want ErrForbidden", err)
			}
			if !ownerTier && err != nil {
				t.Fatalf("administrator AddUserRole: %v, want allowed", err)
			}
			if ownerTier && slices.Contains(heldIDs(t, database, 5), otCarrierRoleID) {
				t.Fatal("a refused assignment granted the role")
			}
			if _, err := svc.AddUserRole(ctx, 1, 5, otCarrierRoleID); err != nil && ownerTier {
				t.Fatalf("owner AddUserRole: %v", err)
			}
			// Removing or replacing a carrier role is a change to the bit too.
			if ownerTier {
				if _, err := svc.RemoveUserRole(ctx, 2, 5, otCarrierRoleID); !errors.Is(err, ErrForbidden) {
					t.Fatalf("administrator RemoveUserRole err = %v, want ErrForbidden", err)
				}
				if _, err := svc.ChangeUserRole(ctx, 2, 5, memberRolesHelperID); !errors.Is(err, ErrForbidden) {
					t.Fatalf("administrator replacing a carrier role err = %v, want ErrForbidden", err)
				}
				if !slices.Contains(heldIDs(t, database, 5), otCarrierRoleID) {
					t.Fatal("a refused removal or replacement revoked the role")
				}
				if _, err := svc.RemoveUserRole(ctx, 1, 5, otCarrierRoleID); err != nil {
					t.Fatalf("owner RemoveUserRole: %v", err)
				}
			}
		})
	}
}

func TestOwnerTypeBits_Overrides(t *testing.T) {
	for _, bit := range append(slices.Clone(ownerTierBits), administratorTierBits...) {
		ownerTier := slices.Contains(ownerTierBits, bit)
		t.Run(permissions.Name(bit), func(t *testing.T) {
			ctx := context.Background()
			svc, database, _, low, ch := seedOverrideFixture(t)
			admin := &db.Role{ID: 36, Name: "chan-super3", Position: 90, Permissions: permissions.Administrator}
			owner := &db.Role{ID: permissions.OwnerRoleID, Name: "owner", Position: permissions.OwnerRolePosition, Permissions: permissions.AllPerms}
			seedRole(t, database, admin)

			for name, mask := range map[string][2]int64{"allow": {bit, 0}, "deny": {0, bit}} {
				_, err := svc.PutRoleOverride(ctx, 7, admin, ch, low.ID, mask[0], mask[1])
				if ownerTier && (!errors.Is(err, ErrForbidden) || !strings.HasPrefix(err.Error(), otOwnerMsg(bit))) {
					t.Fatalf("administrator %s: err = %v, want the owner-only refusal", name, err)
				}
				if !ownerTier && err != nil {
					t.Fatalf("administrator %s: %v, want allowed", name, err)
				}
				if ownerTier {
					if a, d, _ := database.GetChannelPermissions(ctx, ch.ID, low.ID); a != 0 || d != 0 {
						t.Fatalf("refused write persisted (%#x,%#x)", a, d)
					}
				}
			}
			if _, err := svc.PutRoleOverride(ctx, 7, owner, ch, low.ID, bit, 0); err != nil {
				t.Fatalf("owner allow: %v", err)
			}
		})
	}
}

// Deleting an ordinary role moves its members to the default role, so a default
// role that carries an owner-tier bit is a way to hand that bit to them: an
// Administrator (not the owner) is refused, the owner is not.
func TestOwnerTypeBits_RoleDeleteFallbackCarriesOwnerTierBit(t *testing.T) {
	for _, tc := range []struct {
		name  string
		actor int64
		fail  bool
	}{
		{"administrator refused", ownerGrantSuperUserID, true},
		{"owner allowed", 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			svc, database := newOwnerGrantRoleService(t)
			seedRole(t, database, &db.Role{ID: otCarrierRoleID, Name: "Ordinary", Permissions: ownerGrantNonMoverBits, Position: 50})
			if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = ? WHERE is_default = 1`,
				ownerGrantNonMoverBits|permissions.RestoreBackups); err != nil {
				t.Fatalf("set default role mask: %v", err)
			}
			_, _, _, err := svc.DeleteRole(ctx, tc.actor, otCarrierRoleID)
			if tc.fail && !errors.Is(err, ErrForbidden) {
				t.Errorf("err = %v, want ErrForbidden", err)
			}
			if !tc.fail && err != nil {
				t.Errorf("owner delete: %v", err)
			}
		})
	}
}
