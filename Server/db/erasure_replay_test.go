package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ReplayEraseAccount is the marker replay's erasure: the same transaction
// without the last-admin guard, since the erasure it repeats passed the
// guard when it ran and a restored backup from before the admin handover
// must not keep the subject (B4-10). EraseAccountPreflight is the guard
// outside the transaction, run before a marker is written, and
// CountAdminClassAccounts is what the replay reports on afterwards.
func TestReplayEraseAccount_BypassesTheLastAdminGuard(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "sole-owner")
	setRole(t, database, owner, 1)
	if n, err := database.CountAdminClassAccounts(ctx); err != nil || n != 1 {
		t.Fatalf("CountAdminClassAccounts = %d, %v; want 1", n, err)
	}
	if err := database.EraseAccountPreflight(ctx, owner); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("EraseAccountPreflight(sole owner) = %v, want ErrLastAdmin", err)
	}
	if err := database.EraseAccountPreflight(ctx, 424242); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EraseAccountPreflight(absent) = %v, want ErrNotFound", err)
	}
	if _, err := database.EraseAccount(ctx, owner, "tok"); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("EraseAccount(sole owner) = %v, want ErrLastAdmin", err)
	}
	job, err := database.ReplayEraseAccount(ctx, owner, "tok")
	if err != nil {
		t.Fatalf("ReplayEraseAccount(sole owner): %v", err)
	}
	if job == nil || job.UserID != owner {
		t.Fatalf("job = %+v", job)
	}
	if u, _ := database.GetUserByID(ctx, owner); u != nil {
		t.Error("the sole owner survived the replay erasure")
	}
	if n, _ := database.CountAdminClassAccounts(ctx); n != 0 {
		t.Errorf("admin-class accounts after the replay = %d, want 0", n)
	}
	if _, err := database.ReplayEraseAccount(ctx, owner, "tok"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("second ReplayEraseAccount = %v, want ErrNotFound", err)
	}

	// The preflight passes for a member while another admin-class account
	// exists, and for an administrator who is not the last one.
	member := seedUser(t, database, "member-x")
	setRole(t, database, member, 4)
	admin := seedUser(t, database, "admin-x")
	setRole(t, database, admin, 1)
	if err := database.EraseAccountPreflight(ctx, member); err != nil {
		t.Errorf("EraseAccountPreflight(member) = %v", err)
	}
	if err := database.EraseAccountPreflight(ctx, admin); !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("EraseAccountPreflight(last admin) = %v, want ErrLastAdmin", err)
	}
	second := seedUser(t, database, "admin-y")
	setRole(t, database, second, 1)
	if err := database.EraseAccountPreflight(ctx, admin); err != nil {
		t.Errorf("EraseAccountPreflight(one of two admins) = %v", err)
	}
	if n, _ := database.CountAdminClassAccounts(ctx); n != 2 {
		t.Errorf("admin-class accounts = %d, want 2", n)
	}
}
