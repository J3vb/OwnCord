package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestMigration046_GrandfathersEveryOneToOnePair proves the backfill
// (migration 046's comment, decision 4's scope line): every one-to-one DM
// pair that already exists at migration time is trusted in both directions
// afterward, and a group DM's participants are not.
func TestMigration046_GrandfathersEveryOneToOnePair(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	if err := db.MigrateFS(database, migrationsBefore(t, "046")); err != nil {
		t.Fatalf("migrate to 045: %v", err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// alice=10 <-> bob=11: a pre-existing one-to-one DM.
	exec(`INSERT INTO users (id, username, password, role_id) VALUES
		(10, 'alice', 'x', 4), (11, 'bob', 'x', 4), (12, 'carol', 'x', 4), (13, 'dave', 'x', 4)`)
	exec(`INSERT INTO channels (id, name, type, is_group) VALUES (1, '', 'dm', 0)`)
	exec(`INSERT INTO dm_participants (channel_id, user_id) VALUES (1, 10), (1, 11)`)
	// carol=12, dave=13: a pre-existing GROUP DM -- must NOT be grandfathered.
	exec(`INSERT INTO channels (id, name, type, is_group) VALUES (2, 'group', 'dm', 1)`)
	exec(`INSERT INTO dm_participants (channel_id, user_id) VALUES (2, 12), (2, 13)`)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("046 failed on a pre-existing tree: %v", err)
	}

	trusted := func(recipient, sender int64) bool {
		t.Helper()
		ok, err := database.IsTrustedSender(ctx, recipient, sender)
		if err != nil {
			t.Fatalf("IsTrustedSender(%d,%d): %v", recipient, sender, err)
		}
		return ok
	}
	if !trusted(10, 11) || !trusted(11, 10) {
		t.Error("pre-existing one-to-one DM pair was not grandfathered as trusted in both directions")
	}
	if trusted(12, 13) || trusted(13, 12) {
		t.Error("group DM participants were grandfathered as trusted -- decision 4 scopes this to one-to-one DMs only")
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM trusted_senders`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("trusted_senders rows = %d, %v; want exactly 2 (the one-to-one pair, both directions)", rows, err)
	}
	var sources int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM trusted_senders WHERE source = 'grandfathered'`).Scan(&sources); err != nil || sources != 2 {
		t.Fatalf("grandfathered-source rows = %d, %v; want 2", sources, err)
	}
}
