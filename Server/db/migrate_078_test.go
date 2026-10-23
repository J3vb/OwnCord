package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	bit23              = int64(0x800000)
	untouchedModerator = int64(7340031)
	untouchedAdmin     = int64(1073741823)
)

// migratedAt077 returns a database at migration 077, ready to be customised
// before 078 runs.
func migratedAt077(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "078_")); err != nil {
		t.Fatalf("MigrateFS up to 077: %v", err)
	}
	return database
}

func rolePerms(t *testing.T, database *db.DB, id int64) int64 {
	t.Helper()
	var p int64
	if err := database.QueryRowContext(context.Background(), `SELECT permissions FROM roles WHERE id = ?`, id).Scan(&p); err != nil {
		t.Fatalf("read role %d: %v", id, err)
	}
	return p
}

func TestMigration078_GrantsUntouchedAdminAndModerator(t *testing.T) {
	database := migratedAt077(t)
	if got := rolePerms(t, database, 3); got != untouchedModerator {
		t.Fatalf("Moderator before 078 = %d, want %d (the mask the migration compares against)", got, untouchedModerator)
	}
	if got := rolePerms(t, database, 2); got != untouchedAdmin {
		t.Fatalf("Admin before 078 = %d, want %d", got, untouchedAdmin)
	}
	// Stop after 078: later migrations (080) change these roles again.
	if err := db.MigrateFS(database, migrationsUpTo(t, "079_")); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for _, tc := range []struct {
		id   int64
		name string
		want bool
	}{{1, "Owner", true}, {2, "Admin", true}, {3, "Moderator", true}, {4, "Member", false}} {
		if got := rolePerms(t, database, tc.id)&bit23 != 0; got != tc.want {
			t.Errorf("%s holds MANAGE_NICKNAMES = %v, want %v", tc.name, got, tc.want)
		}
	}
	if got := rolePerms(t, database, 3); got != untouchedModerator|bit23 {
		t.Errorf("Moderator = %d, want %d", got, untouchedModerator|bit23)
	}
	if got := rolePerms(t, database, 2); got != untouchedAdmin {
		t.Errorf("Admin = %d, want it unchanged at %d", got, untouchedAdmin)
	}
}

func TestMigration078_CustomisedRolesUnchangedOrCleared(t *testing.T) {
	database := migratedAt077(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// A customised Moderator (one bit short of untouched) gets no grant.
	exec(`UPDATE roles SET permissions = ? WHERE id = 3`, untouchedModerator&^int64(0x1))
	// A customised Admin carrying the bit loses it, as does any other role.
	exec(`UPDATE roles SET permissions = ? WHERE id = 2`, untouchedAdmin&^int64(0x1))
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (9, 'Helper', ?, 50)`, bit23|0x3)
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (10, 'Moderator2', ?, 45)`, untouchedModerator)
	// A role merely renamed Moderator on another id is not the default row.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (11, 'Mod Twin', ?, 44)`, untouchedModerator|bit23)

	// Stop after 078: later migrations (080) change these roles again.
	if err := db.MigrateFS(database, migrationsUpTo(t, "079_")); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if got, want := rolePerms(t, database, 3), untouchedModerator&^int64(0x1); got != want {
		t.Errorf("customised Moderator = %d, want %d unchanged", got, want)
	}
	if got := rolePerms(t, database, 2); got&bit23 != 0 {
		t.Errorf("customised Admin = %d, want bit 23 cleared", got)
	}
	if got := rolePerms(t, database, 9); got != 0x3 {
		t.Errorf("Helper = %#x, want only the non-nickname bits (0x3)", got)
	}
	if got := rolePerms(t, database, 10); got != untouchedModerator {
		t.Errorf("a second role with Moderator's mask = %d, want it untouched at %d", got, untouchedModerator)
	}
	if got := rolePerms(t, database, 11); got != untouchedModerator {
		t.Errorf("Mod Twin = %d, want bit 23 cleared (%d)", got, untouchedModerator)
	}
	if got := rolePerms(t, database, 1); got&bit23 == 0 {
		t.Errorf("Owner lost bit 23: %#x", got)
	}
}
