package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.4d: ERASE_ACCOUNTS lets a role without ADMINISTRATOR erase an account.
// The rank rule is unchanged: the actor must strictly outrank the target.
func TestModerationService_EraseUser_EraseAccountsBit(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	member, _ := seedErasureMember(t, database, dir) // also creates the owner
	owner, _ := database.GetUserByUsername(ctx, "erasure-owner")

	seedRole(t, database, &db.Role{ID: 20, Name: "Eraser", Permissions: permissions.ReadMessages | permissions.EraseAccounts, Position: 70})
	seedRole(t, database, &db.Role{ID: 21, Name: "Eraser peer", Permissions: permissions.ReadMessages, Position: 70})
	seedRole(t, database, &db.Role{ID: 22, Name: "Senior", Permissions: permissions.ReadMessages, Position: 75})
	seedRole(t, database, &db.Role{ID: 23, Name: "Server manager", Permissions: permissions.ManageServer | permissions.KickMembers, Position: 70})
	eraser, err := database.CreateUser(ctx, "eraser", "hash", 20)
	if err != nil {
		t.Fatal(err)
	}
	peer, _ := database.CreateUser(ctx, "eraser-peer", "hash", 21)
	senior, _ := database.CreateUser(ctx, "eraser-senior", "hash", 22)
	manager, _ := database.CreateUser(ctx, "eraser-manager", "hash", 23)

	svc := New(database, auth.NewRateLimiter())
	svc.Erasure.SetFiles(newTestStorage(t, dir))
	mod := svc.Moderation

	// Without the bit or ADMINISTRATOR: refused, nothing erased.
	if err := mod.EraseUser(ctx, manager, member); !errors.Is(err, ErrForbidden) {
		t.Errorf("manager without the bit = %v, want ErrForbidden", err)
	}
	// With the bit but at or above the target's rank, or the owner: refused.
	for name, target := range map[string]int64{"equal rank": peer, "higher rank": senior, "the owner": owner.ID} {
		if err := mod.EraseUser(ctx, eraser, target); !errors.Is(err, ErrForbidden) {
			t.Errorf("holder erasing %s = %v, want ErrForbidden", name, err)
		}
		if u, _ := database.GetUserByID(ctx, target); u == nil {
			t.Errorf("a refused erasure of %s removed the account", name)
		}
	}
	if u, _ := database.GetUserByID(ctx, member); u == nil {
		t.Fatal("a refused erasure removed the member")
	}
	// A holder erases a lower-ranked member without holding ADMINISTRATOR.
	if err := mod.EraseUser(ctx, eraser, member); err != nil {
		t.Fatalf("holder erasing a lower-ranked member: %v", err)
	}
	if u, _ := database.GetUserByID(ctx, member); u != nil {
		t.Error("member row survived")
	}
}
