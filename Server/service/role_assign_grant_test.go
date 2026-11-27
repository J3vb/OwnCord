package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Roles from newTestRoleService: mod 3 (60) holds MANAGE_ROLES | KICK_MEMBERS;
// users 1 owner, 3 mod, 5 member. Two low roles sit under mod: one carrying
// ADMINISTRATOR, one carrying only a bit mod holds.
const (
	lowAdminRoleID = int64(8)
	lowKickRoleID  = int64(9)
)

func newRoleGrantFixture(t *testing.T) (*ModerationService, *db.DB) {
	t.Helper()
	svc, database := newTestRoleService(t)
	seedRole(t, database, &db.Role{ID: lowAdminRoleID, Name: "low-admin", Position: 10, Permissions: permissions.Administrator})
	seedRole(t, database, &db.Role{ID: lowKickRoleID, Name: "low-kick", Position: 10, Permissions: permissions.KickMembers})
	return svc, database
}

// Adding or switching to a role that carries a bit the assigner lacks is
// refused and writes nothing; a role within the assigner's own bits passes.
func TestRoleAssignment_OnlyBitsTheAssignerHolds(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	svc, database := newRoleGrantFixture(t)
	if _, err := svc.AddUserRole(ctx, 3, 5, lowAdminRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("add: err = %v, want ErrForbidden", err)
	}
	if _, err := svc.ChangeUserRole(ctx, 3, 5, lowAdminRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("change: err = %v, want ErrForbidden", err)
	}
	if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{4}) {
		t.Fatalf("held roles = %v, want [member] untouched", got)
	}

	if _, err := svc.AddUserRole(ctx, 3, 5, lowKickRoleID); err != nil {
		t.Fatalf("add a role within the assigner's bits: %v", err)
	}
}

// An Administrator assigns a role whatever bits it carries, below its rank.
func TestRoleAssignment_AdministratorAssignsAnyBits(t *testing.T) {
	t.Parallel()
	svc, database := newRoleGrantFixture(t)
	if _, err := svc.AddUserRole(context.Background(), 1, 5, lowAdminRoleID); err != nil {
		t.Fatalf("owner add: %v", err)
	}
	if got := heldIDs(t, database, 5); !slices.Contains(got, lowAdminRoleID) {
		t.Fatalf("held roles = %v, want low-admin added", got)
	}
}

// The shipped roles keep working: the stock Admin promotes a stock Member to
// Moderator and back, since its mask covers both.
func TestRoleAssignment_StockAdminAssignsStockRoles(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	database := newTestDB(t)
	seedUserRole(t, database, 10, permissions.AdminRoleID)
	seedUserRole(t, database, 11, permissions.MemberRoleID)
	svc := NewModerationService(database, NewPermissionService(database, permissions.NewChecker(database)))

	if _, err := svc.ChangeUserRole(ctx, 10, 11, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("promote to Moderator: %v", err)
	}
	if _, err := svc.ChangeUserRole(ctx, 10, 11, permissions.MemberRoleID); err != nil {
		t.Fatalf("back to Member: %v", err)
	}
	if _, err := svc.AddUserRole(ctx, 10, 11, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("add Moderator: %v", err)
	}
}
