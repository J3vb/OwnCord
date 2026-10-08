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

// TestMigration058_DropsTrustForBlockedPairsOnly proves the cleanup: standing
// trust the blocker holds in a currently blocked sender is removed, while trust
// without a block and the blocked user's trust in the blocker are kept.
func TestMigration058_DropsTrustForBlockedPairsOnly(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	if err := db.MigrateFS(database, migrationsBefore(t, "058")); err != nil {
		t.Fatalf("migrate to 057: %v", err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, password, role_id) VALUES
		(10, 'alice', 'x', 4), (11, 'bob', 'x', 4), (12, 'carol', 'x', 4), (13, 'dave', 'x', 4)`)
	// alice (10) trusts bob (11) and blocks him; bob also trusts alice.
	// carol (12) trusts dave (13) with no block.
	exec(`INSERT INTO trusted_senders (recipient_id, sender_id, source) VALUES
		(10, 11, 'accepted'), (11, 10, 'accepted'), (12, 13, 'accepted')`)
	exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (10, 11)`)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("058 failed: %v", err)
	}

	trusted := func(recipient, sender int64) bool {
		t.Helper()
		ok, err := database.IsTrustedSender(ctx, recipient, sender)
		if err != nil {
			t.Fatalf("IsTrustedSender(%d,%d): %v", recipient, sender, err)
		}
		return ok
	}
	if trusted(10, 11) {
		t.Error("blocker's trust in the blocked sender survived the migration")
	}
	if !trusted(11, 10) {
		t.Error("the blocked user's trust in the blocker was removed")
	}
	if !trusted(12, 13) {
		t.Error("trust without a block was removed")
	}
}
