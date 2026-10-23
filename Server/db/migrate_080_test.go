package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	bit13         = int64(0x2000)
	muteMembers   = int64(0x100000)
	moderator079  = int64(15728639) // 0xEFFFFF: untouched Moderator before 080
	moderator080  = int64(0xFFFFFF)
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

func TestMigration080_DefaultRolesAfterMove(t *testing.T) {
	database := migratedAt079(t)
	if got := rolePerms(t, database, 3); got != moderator079 {
		t.Fatalf("Moderator before 080 = %#x, want %#x (the mask the migration compares against)", got, moderator079)
	}
	if err := db.MigrateFS(database, migrationsUpTo(t, "081_")); err != nil {
		t.Fatalf("Migrate 080: %v", err)
	}
	if got := rolePerms(t, database, 3); got != moderator080 {
		t.Errorf("untouched Moderator = %#x, want %#x (MUTE_MEMBERS added)", got, moderator080)
	}
	if got := rolePerms(t, database, 2); got != untouchedAdmin {
		t.Errorf("Admin = %#x, want %#x unchanged (keeps bit 13)", got, untouchedAdmin)
	}
	if got := rolePerms(t, database, 1); got != ownerFullMask {
		t.Errorf("Owner = %#x, want %#x unchanged", got, ownerFullMask)
	}
	if got := rolePerms(t, database, 4); got&bit13 != 0 {
		t.Errorf("Member = %#x, want bit 13 clear", got)
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
	// A role that could mute (and so move) before gains the move bit.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (9, 'Voice Mod', ?, 50)`, muteMembers|0x3)
	// A stray bit 13 on a role without MUTE_MEMBERS is cleared.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (10, 'Stray', ?, 45)`, bit13|0x3)
	// A Moderator edited by hand gets no MUTE_MEMBERS, and loses the stray bit.
	exec(`UPDATE roles SET permissions = ? WHERE id = 3`, moderator079&^int64(0x1))
	// A customised Admin without MUTE_MEMBERS loses the stray bit too.
	exec(`UPDATE roles SET permissions = ? WHERE id = 2`, untouchedAdmin&^muteMembers)
	// A role at the owner position is left alone.
	exec(`INSERT INTO roles (id, name, permissions, position) VALUES (11, 'Co-owner', ?, 100)`, bit13|0x3)

	if err := db.MigrateFS(database, migrationsUpTo(t, "081_")); err != nil {
		t.Fatalf("Migrate 080: %v", err)
	}
	if got, want := rolePerms(t, database, 9), muteMembers|bit13|0x3; got != want {
		t.Errorf("Voice Mod = %#x, want %#x", got, want)
	}
	if got, want := rolePerms(t, database, 10), int64(0x3); got != want {
		t.Errorf("Stray = %#x, want %#x (bit 13 cleared)", got, want)
	}
	if got, want := rolePerms(t, database, 3), moderator079&^int64(0x1)&^bit13; got != want {
		t.Errorf("customised Moderator = %#x, want %#x (no MUTE_MEMBERS granted, no bit 13)", got, want)
	}
	if got := rolePerms(t, database, 2); got&bit13 != 0 {
		t.Errorf("customised Admin without MUTE_MEMBERS = %#x, want bit 13 cleared", got)
	}
	if got, want := rolePerms(t, database, 11), bit13|0x3; got != want {
		t.Errorf("owner-position role = %#x, want %#x untouched", got, want)
	}
}
