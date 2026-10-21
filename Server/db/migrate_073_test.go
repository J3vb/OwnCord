package db_test

import (
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 073 resets user_roles to exactly the role users.role_id names.
func TestMigrate_073ReconcilesUserRolesWithMirror(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "073_")); err != nil {
		t.Fatalf("pre-073 schema: %v", err)
	}
	execAll(t, database,
		// 1 consistent, 2 demoted from Admin (mirror 4, still holds 2),
		// 3 left with zero rows (role delete cascade), 4 names a missing role.
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'a', 'h', 4), (2, 'b', 'h', 4), (3, 'c', 'h', 4)`,
		`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (2, 2)`,
		`DELETE FROM user_roles WHERE user_id = 3`,
		`PRAGMA foreign_keys = OFF`,
		`INSERT INTO users (id, username, password, role_id) VALUES (4, 'd', 'h', 999)`,
		`PRAGMA foreign_keys = ON`,
	)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for uid, want := range map[int64]int64{1: 4, 2: 4, 3: 4} {
		if got := userRoleIDs(t, database, uid); !slices.Equal(got, []int64{want}) {
			t.Errorf("user %d user_roles = %v, want [%d]", uid, got, want)
		}
	}
	var def, mirror int64
	if err := database.QueryRowContext(t.Context(),
		`SELECT id FROM roles WHERE is_default = 1`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(t.Context(),
		`SELECT role_id FROM users WHERE id = 4`).Scan(&mirror); err != nil {
		t.Fatal(err)
	}
	if mirror != def {
		t.Errorf("user 4 mirror = %d, want the default role %d", mirror, def)
	}
	if got := userRoleIDs(t, database, 4); !slices.Equal(got, []int64{def}) {
		t.Errorf("user 4 user_roles = %v, want [%d]", got, def)
	}
}
