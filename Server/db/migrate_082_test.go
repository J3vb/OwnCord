package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ownerTypeMask is migration 082's mask: bits 2, 3, 4, 7, 8, 15 and 28.
const ownerTypeMask = int64(0x1000819C)

// migratedAt081 returns a database at migration 081, ready to be customised
// before 082 runs.
func migratedAt081(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsUpTo(t, "082_")); err != nil {
		t.Fatalf("MigrateFS up to 081: %v", err)
	}
	return database
}

// TestMigration082_DefaultRolesLoseTheUnusedBits: the seeded Admin and
// Moderator masks carry the seven owner-type bits as unused bits; after 082
// they hold none of them and nothing else changes. The Owner is untouched.
func TestMigration082_DefaultRolesLoseTheUnusedBits(t *testing.T) {
	database := migratedAt081(t)
	for _, id := range []int64{2, 3} {
		if rolePerms(t, database, id)&ownerTypeMask == 0 {
			t.Fatalf("role %d before 082 holds none of the owner-type bits; the test no longer exercises the stray bits", id)
		}
	}
	before := map[int64]int64{2: rolePerms(t, database, 2), 3: rolePerms(t, database, 3), 4: rolePerms(t, database, 4)}
	if err := db.MigrateFS(database, migrationsUpTo(t, "083_")); err != nil {
		t.Fatalf("Migrate 082: %v", err)
	}
	for id, was := range before {
		got := rolePerms(t, database, id)
		if got&ownerTypeMask != 0 {
			t.Errorf("role %d = %#x still holds owner-type bits %#x", id, got, got&ownerTypeMask)
		}
		if want := was &^ ownerTypeMask; got != want {
			t.Errorf("role %d = %#x, want %#x (only the owner-type bits cleared)", id, got, want)
		}
	}
	if got, want := rolePerms(t, database, 2), int64(0x2FFF1E63); got != want {
		t.Errorf("seeded Admin = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 3), int64(0x00EF1E63); got != want {
		t.Errorf("seeded Moderator = %#x, want %#x", got, want)
	}
	if got := rolePerms(t, database, 1); got != ownerFullMask {
		t.Errorf("Owner = %#x, want %#x unchanged", got, ownerFullMask)
	}
}

func TestMigration082_CustomRoles(t *testing.T) {
	database := migratedAt081(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// A custom role holding only the owner-type bits loses all of them.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (10, 'Junk', ?, 45)`, ownerTypeMask)
	// A custom role mixing them with real bits keeps the real ones, including
	// bits 13 and 14 which earlier migrations own.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (9, 'Mixed', ?, 50)`, ownerTypeMask|muteMembers|bit13|bit14|0x3)
	// A role without any of them is left as it is.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (8, 'Voice Mod', ?, 52)`, muteMembers|0x3)
	// A role at the owner position is left alone.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (11, 'Co-owner', ?, 100)`, ownerTypeMask|0x3)

	if err := db.MigrateFS(database, migrationsUpTo(t, "083_")); err != nil {
		t.Fatalf("Migrate 082: %v", err)
	}
	if got := rolePerms(t, database, 10); got != 0 {
		t.Errorf("Junk = %#x, want 0", got)
	}
	if got, want := rolePerms(t, database, 9), muteMembers|bit13|bit14|0x3; got != want {
		t.Errorf("Mixed = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 8), muteMembers|0x3; got != want {
		t.Errorf("Voice Mod = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 11), ownerTypeMask|0x3; got != want {
		t.Errorf("owner-position role = %#x, want %#x untouched", got, want)
	}
}
