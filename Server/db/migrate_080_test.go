package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	bit13         = int64(0x2000)
	muteMembers   = int64(0x100000)
	ownerFullMask = int64(0x7FFFFFFF)
)

// migratedAt079 returns a database at migration 079, ready to be customised
// before 080 runs.
func migratedAt079(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "080_")); err != nil {
		t.Fatalf("MigrateFS up to 079: %v", err)
	}
	return database
}

func TestMigration080_DefaultRolesLoseTheUnusedBit(t *testing.T) {
	database := migratedAt079(t)
	for _, id := range []int64{2, 3} {
		if rolePerms(t, database, id)&bit13 == 0 {
			t.Fatalf("role %d before 080 lacks bit 13; the test no longer exercises the stray bit", id)
		}
	}
	before := map[int64]int64{2: rolePerms(t, database, 2), 3: rolePerms(t, database, 3), 4: rolePerms(t, database, 4)}
	if err := db.MigrateFS(database, migrationsUpTo(t, "081_")); err != nil {
		t.Fatalf("Migrate 080: %v", err)
	}
	for id, was := range before {
		if got, want := rolePerms(t, database, id), was&^bit13; got != want {
			t.Errorf("role %d = %#x, want %#x (only bit 13 cleared)", id, got, want)
		}
	}
	if got := rolePerms(t, database, 3); got&muteMembers != 0 {
		t.Errorf("Moderator = %#x, MUTE_MEMBERS must not be granted by 080", got)
	}
	if got := rolePerms(t, database, 1); got != ownerFullMask {
		t.Errorf("Owner = %#x, want %#x unchanged", got, ownerFullMask)
	}
}

func TestMigration080_CustomRoles(t *testing.T) {
	database := migratedAt079(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// A role with MUTE_MEMBERS does not gain the move bit: it still moves
	// lower ranks through MUTE_MEMBERS.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (9, 'Voice Mod', ?, 50)`, muteMembers|0x3)
	// A stray bit 13 is cleared whatever else the role holds.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (10, 'Stray', ?, 45)`, bit13|muteMembers|0x3)
	// A role at the owner position is left alone.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (11, 'Co-owner', ?, 100)`, bit13|0x3)

	if err := db.MigrateFS(database, migrationsUpTo(t, "081_")); err != nil {
		t.Fatalf("Migrate 080: %v", err)
	}
	if got, want := rolePerms(t, database, 9), muteMembers|0x3; got != want {
		t.Errorf("Voice Mod = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 10), muteMembers|0x3; got != want {
		t.Errorf("Stray = %#x, want %#x (bit 13 cleared)", got, want)
	}
	if got, want := rolePerms(t, database, 11), bit13|0x3; got != want {
		t.Errorf("owner-position role = %#x, want %#x untouched", got, want)
	}
}
