package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

const bit14 = int64(0x4000)

// migratedAt080 returns a database at migration 080, ready to be customised
// before 081 runs.
func migratedAt080(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "081_")); err != nil {
		t.Fatalf("MigrateFS up to 080: %v", err)
	}
	return database
}

func TestMigration081_DefaultRolesLoseTheUnusedBit(t *testing.T) {
	database := migratedAt080(t)
	for _, id := range []int64{2, 3} {
		if rolePerms(t, database, id)&bit14 == 0 {
			t.Fatalf("role %d before 081 lacks bit 14; the test no longer exercises the stray bit", id)
		}
	}
	before := map[int64]int64{2: rolePerms(t, database, 2), 3: rolePerms(t, database, 3), 4: rolePerms(t, database, 4)}
	if err := db.MigrateFS(database, migrationsUpTo(t, "082_")); err != nil {
		t.Fatalf("Migrate 081: %v", err)
	}
	for id, was := range before {
		if got, want := rolePerms(t, database, id), was&^bit14; got != want {
			t.Errorf("role %d = %#x, want %#x (only bit 14 cleared)", id, got, want)
		}
	}
	if got := rolePerms(t, database, 1); got != ownerFullMask {
		t.Errorf("Owner = %#x, want %#x unchanged", got, ownerFullMask)
	}
}

func TestMigration081_CustomRoles(t *testing.T) {
	database := migratedAt080(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// A custom role carrying a stray bit 14 loses it and keeps everything else.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (10, 'Stray', ?, 45)`, bit14|muteMembers|bit13|0x3)
	// A role without the bit is left as it is.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (9, 'Voice Mod', ?, 50)`, muteMembers|0x3)
	// A role at the owner position is left alone.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (11, 'Co-owner', ?, 100)`, bit14|0x3)

	if err := db.MigrateFS(database, migrationsUpTo(t, "082_")); err != nil {
		t.Fatalf("Migrate 081: %v", err)
	}
	if got, want := rolePerms(t, database, 10), muteMembers|bit13|0x3; got != want {
		t.Errorf("Stray = %#x, want %#x (bit 14 cleared, bit 13 untouched)", got, want)
	}
	if got, want := rolePerms(t, database, 9), muteMembers|0x3; got != want {
		t.Errorf("Voice Mod = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 11), bit14|0x3; got != want {
		t.Errorf("owner-position role = %#x, want %#x untouched", got, want)
	}
}
