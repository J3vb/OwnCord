package db_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func execAll(t *testing.T, database *db.DB, stmts ...string) {
	t.Helper()
	for _, s := range stmts {
		if _, err := database.ExecContext(context.Background(), s); err != nil {
			t.Fatalf("exec %q: %v", s, err)
		}
	}
}

func userRoleIDs(t *testing.T, database *db.DB, userID int64) []int64 {
	t.Helper()
	rows, err := database.QueryContext(context.Background(),
		`SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id`, userID)
	if err != nil {
		t.Fatalf("query user_roles: %v", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func TestMigration067_BackfillsOneRowPerUser(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "067_")); err != nil {
		t.Fatalf("pre-067 schema: %v", err)
	}
	execAll(t, database,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'a', 'h', 1), (2, 'b', 'h', 4), (3, 'c', 'h', 4)`)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for uid, want := range map[int64]int64{1: 1, 2: 4, 3: 4} {
		if got := userRoleIDs(t, database, uid); !slices.Equal(got, []int64{want}) {
			t.Errorf("user %d user_roles = %v, want [%d]", uid, got, want)
		}
	}
	var hoisted, total int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COALESCE(SUM(hoist), 0), COUNT(*) FROM roles`).Scan(&hoisted, &total); err != nil {
		t.Fatal(err)
	}
	if hoisted != total || total == 0 {
		t.Errorf("existing roles hoisted = %d of %d, want all", hoisted, total)
	}
	var m int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COALESCE(SUM(mentionable), 0) FROM roles`).Scan(&m); err != nil || m != 0 {
		t.Errorf("mentionable sum = %d (err %v), want 0", m, err)
	}
}

func TestMigration067_DanglingRoleSkipped(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "067_")); err != nil {
		t.Fatalf("pre-067 schema: %v", err)
	}
	// Historical databases ran with foreign keys off. The memory pool holds a
	// single connection, so the pragma sticks for the seed insert.
	execAll(t, database, `PRAGMA foreign_keys = OFF`,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'a', 'h', 4), (2, 'ghost', 'h', 999)`,
		`PRAGMA foreign_keys = ON`)
	// Stop before 077, which reconciles the dangling user onto the default role.
	if err := db.MigrateFS(database, migrationsUpTo(t, "077_")); err != nil {
		t.Fatalf("Migrate must still commit: %v", err)
	}
	if got := userRoleIDs(t, database, 1); !slices.Equal(got, []int64{4}) {
		t.Errorf("user 1 roles = %v, want [4]", got)
	}
	if got := userRoleIDs(t, database, 2); len(got) != 0 {
		t.Errorf("dangling user got roles %v, want none", got)
	}
}

func TestUserInsertTriggerAddsRole(t *testing.T) {
	database := openMigratedMemory(t)
	execAll(t, database, `INSERT INTO users (id, username, password, role_id) VALUES (7, 'raw', 'h', 3)`)
	if got := userRoleIDs(t, database, 7); !slices.Equal(got, []int64{3}) {
		t.Errorf("raw insert user_roles = %v, want [3]", got)
	}
}

func TestSyncTopRole_PicksHighestPositionThenLowestID(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	execAll(t, database,
		`INSERT INTO roles (id, name, permissions, position) VALUES (20, 'tie-high-id', 0, 50), (10, 'tie-low-id', 0, 50), (30, 'lower', 0, 5)`,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'h', 30)`)

	topID := func() int64 {
		var id int64
		if err := database.QueryRowContext(ctx, `SELECT role_id FROM users WHERE id = 1`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	if err := database.AddUserRole(ctx, 1, 20); err != nil {
		t.Fatal(err)
	}
	if got := topID(); got != 20 {
		t.Fatalf("top after adding 20 = %d, want 20", got)
	}
	if err := database.AddUserRole(ctx, 1, 10); err != nil {
		t.Fatal(err)
	}
	if got := topID(); got != 10 {
		t.Fatalf("top on a position tie = %d, want lowest id 10", got)
	}
	mr, err := database.GetMemberRoles(ctx, 1)
	if err != nil || mr == nil {
		t.Fatalf("GetMemberRoles = %v, %v", mr, err)
	}
	if mr.Top.ID != 10 || !slices.Equal(mr.IDs, []int64{10, 20, 30}) {
		t.Errorf("MemberRoles top %d ids %v, want 10 and [10 20 30]", mr.Top.ID, mr.IDs)
	}
	if err := database.RemoveUserRole(ctx, 1, 10); err != nil {
		t.Fatal(err)
	}
	if got := topID(); got != 20 {
		t.Errorf("top after removing 10 = %d, want 20", got)
	}
	if err := database.RemoveUserRole(ctx, 1, 20); err != nil {
		t.Fatal(err)
	}
	if err := database.RemoveUserRole(ctx, 1, 30); !errors.Is(err, db.ErrLastRole) {
		t.Errorf("removing last role err = %v, want ErrLastRole", err)
	}
	if got := topID(); got != 30 {
		t.Errorf("top after refused removal = %d, want 30", got)
	}
}

func TestMemberGeneration_BumpsOnUserRolesWrite(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	execAll(t, database,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'h', 4)`)
	gen := func() int64 {
		g, err := database.MemberGeneration(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	g0 := gen()
	if _, err := database.ExecContext(ctx, `INSERT INTO user_roles (user_id, role_id) VALUES (1, 3)`); err != nil {
		t.Fatal(err)
	}
	g1 := gen()
	if g1 <= g0 {
		t.Errorf("generation after user_roles insert = %d, want > %d", g1, g0)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM user_roles WHERE user_id = 1 AND role_id = 3`); err != nil {
		t.Fatal(err)
	}
	g2 := gen()
	if g2 <= g1 {
		t.Errorf("generation after user_roles delete = %d, want > %d", g2, g1)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET hoist = 0 WHERE id = 3`); err != nil {
		t.Fatal(err)
	}
	g3 := gen()
	if g3 <= g2 {
		t.Errorf("generation after hoist edit = %d, want > %d", g3, g2)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET mentionable = 1 WHERE id = 3`); err != nil {
		t.Fatal(err)
	}
	if g4 := gen(); g4 != g3 {
		t.Errorf("generation moved on a mentionable edit: %d -> %d", g3, g4)
	}
}

func TestRemoveUserRole_NotHeldIsNoOp(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	execAll(t, database,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'h', 4)`)
	if err := database.RemoveUserRole(ctx, 1, 3); err != nil {
		t.Errorf("removing a role the member does not hold err = %v, want nil", err)
	}
	mr, err := database.GetMemberRoles(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if mr.Top.ID != 4 || len(mr.IDs) != 1 {
		t.Errorf("member roles after no-op removal = %+v, want only role 4", mr)
	}
}

func TestGrantAndRevokeUserRole_ReportRowsChanged(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	execAll(t, database,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'h', 4)`)

	for i, want := range []bool{true, false} {
		got, err := database.GrantUserRole(ctx, 1, 3)
		if err != nil || got != want {
			t.Fatalf("GrantUserRole #%d = %v, %v; want %v, nil", i+1, got, err, want)
		}
	}
	for i, want := range []bool{true, false} {
		got, err := database.RevokeUserRole(ctx, 1, 3)
		if err != nil || got != want {
			t.Fatalf("RevokeUserRole #%d = %v, %v; want %v, nil", i+1, got, err, want)
		}
	}
	if got, err := database.RevokeUserRole(ctx, 1, 4); !errors.Is(err, db.ErrLastRole) || got {
		t.Errorf("RevokeUserRole of the only role = %v, %v; want false, ErrLastRole", got, err)
	}
}
