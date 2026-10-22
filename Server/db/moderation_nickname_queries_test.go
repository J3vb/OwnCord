package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestManageNicknamesMaskMatchesPermissions(t *testing.T) {
	// db cannot import permissions, so SetDisplayNameAsModerator carries the
	// literal; a drift here would silently change who may rename members.
	if want := permissions.ManageNicknames | permissions.Administrator; db.ManageNicknamesOrAdminForTest != want {
		t.Fatalf("db literal = %d, want MANAGE_NICKNAMES|ADMINISTRATOR = %d", db.ManageNicknamesOrAdminForTest, want)
	}
}

func nicknameFixtureDB(t *testing.T) (database *db.DB, mod, member int64) {
	t.Helper()
	database = openMigratedMemory(t)
	ctx := context.Background()
	role, err := database.CreateRole(ctx, "nick-mod", nil, permissions.ManageNicknames, 80, false, false)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	mod = seedUser(t, database, "nick-mod")
	member = seedUser(t, database, "nick-member")
	if err := database.UpdateUserRole(ctx, mod, role.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	return database, mod, member
}

func TestSetDisplayNameAsModerator_WritesAndReturnsOld(t *testing.T) {
	database, mod, member := nicknameFixtureDB(t)
	ctx := context.Background()
	a, b := "Alpha", "Beta"
	old, err := database.SetDisplayNameAsModerator(ctx, mod, member, &a)
	if err != nil || old != nil {
		t.Fatalf("first write: old %v err %v, want nil nil", old, err)
	}
	old, err = database.SetDisplayNameAsModerator(ctx, mod, member, &b)
	if err != nil || old == nil || *old != "Alpha" {
		t.Fatalf("second write: old %v err %v, want Alpha", old, err)
	}
	old, err = database.SetDisplayNameAsModerator(ctx, mod, member, nil)
	if err != nil || old == nil || *old != "Beta" {
		t.Fatalf("clear: old %v err %v, want Beta", old, err)
	}
	u, err := database.GetUserByID(ctx, member)
	if err != nil || u.DisplayName != nil {
		t.Fatalf("stored = %+v, %v, want NULL", u, err)
	}
}

func TestSetDisplayNameAsModerator_Refusals(t *testing.T) {
	database, mod, member := nicknameFixtureDB(t)
	ctx := context.Background()
	x := "x"
	for name, call := range map[string]func() error{
		"non-positive actor": func() error { _, err := database.SetDisplayNameAsModerator(ctx, 0, member, &x); return err },
		"self":               func() error { _, err := database.SetDisplayNameAsModerator(ctx, mod, mod, &x); return err },
		"actor without bit":  func() error { _, err := database.SetDisplayNameAsModerator(ctx, member, mod, &x); return err },
	} {
		if err := call(); !errors.Is(err, db.ErrOutranked) {
			t.Errorf("%s: err = %v, want ErrOutranked", name, err)
		}
	}
	// An unknown target has no rank to beat; the service answers 404 before
	// it ever reaches the write, so here it is refused like any unwinnable rank.
	if _, err := database.SetDisplayNameAsModerator(ctx, mod, 99999, &x); !errors.Is(err, db.ErrOutranked) {
		t.Errorf("unknown target: err = %v, want ErrOutranked", err)
	}
}

// TestSetDisplayNameAsModerator_RoleChangeInsideTxIsHonoured: a role change
// that contends for the one writer connection while the transaction is open
// cannot land mid-decision, and one that landed before the transaction began
// governs the outcome.
func TestSetDisplayNameAsModerator_RoleChangeInsideTxIsHonoured(t *testing.T) {
	database, mod, member := nicknameFixtureDB(t)
	ctx := context.Background()
	x := "x"

	// The actor loses the bit before the transaction reads it.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = 0 WHERE name = 'nick-mod'`); err != nil {
		t.Fatalf("strip: %v", err)
	}
	if _, err := database.SetDisplayNameAsModerator(ctx, mod, member, &x); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("bit stripped: err = %v, want ErrOutranked", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = ? WHERE name = 'nick-mod'`, permissions.ManageNicknames); err != nil {
		t.Fatalf("restore: %v", err)
	}

	// The hook runs inside the transaction. A second writer started there
	// must wait for it (single writer connection), so the write below sees
	// the pre-change state and commits whole.
	changed := make(chan struct{})
	db.SetNicknamePreCheckHookForTest(func() {
		go func() {
			defer close(changed)
			_, _ = database.ExecContext(ctx, `UPDATE roles SET permissions = 0 WHERE name = 'nick-mod'`)
		}()
	})
	t.Cleanup(func() { db.SetNicknamePreCheckHookForTest(nil) })
	if _, err := database.SetDisplayNameAsModerator(ctx, mod, member, &x); err != nil {
		t.Fatalf("write with a contending role change: %v", err)
	}
	<-changed
	u, err := database.GetUserByID(ctx, member)
	if err != nil || u.DisplayName == nil || *u.DisplayName != "x" {
		t.Fatalf("stored = %+v, %v, want x", u, err)
	}
}
