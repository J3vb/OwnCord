package db

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// The committed alpha snapshot (B3-7 item 3) — the "upgrade still applies"
// canary. It opens Server/testdata/snapshots/v1.2.0-alpha.4.sqlite on a
// throwaway copy, asserts its recorded provenance, runs HEAD's migrations
// over it, and checks the row counts the profile promises. The moment a
// post-alpha.4 migration lands, Migrate below is a real upgrade rehearsal:
// it must apply the delta cleanly or this test is the first thing to break.
//
// alphaSnapshotMigrations is the schema_versions count baked into the
// committed snapshot — 31, the migration set at the v1.2.0-alpha.4 tag
// (unchanged through B3). It only moves when the snapshot is REGENERATED on
// a newer schema, which is a deliberate act recorded in the B3-7 evidence
// block, never a drive-by.
const alphaSnapshotMigrations = 31

func openSnapshotCopy(t *testing.T) *DB {
	t.Helper()
	src, err := os.Open(filepath.Join("..", "testdata", "snapshots", "v1.2.0-alpha.4.sqlite"))
	if err != nil {
		t.Fatalf("opening committed snapshot: %v", err)
	}
	defer func() { _ = src.Close() }()
	dstPath := filepath.Join(t.TempDir(), "alpha-copy.sqlite")
	dst, err := os.Create(dstPath)
	if err != nil {
		t.Fatalf("creating copy: %v", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatalf("copying snapshot: %v", err)
	}
	if err := dst.Close(); err != nil {
		t.Fatalf("closing copy: %v", err)
	}
	database, err := Open(dstPath)
	if err != nil {
		t.Fatalf("db.Open on snapshot copy: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestAlphaSnapshotMigratesOnHead(t *testing.T) {
	database := openSnapshotCopy(t)

	count := func(q string) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(context.Background(), q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}

	// Provenance: the snapshot was created at the alpha.4 migration set.
	if got := count(`SELECT COUNT(*) FROM schema_versions`); got != alphaSnapshotMigrations {
		t.Fatalf("snapshot carries %d applied migrations, want %d — regenerate it deliberately or fix the constant with the B3-7 evidence block", got, alphaSnapshotMigrations)
	}

	// The upgrade: HEAD's migrations must apply to an alpha.4 database.
	if err := Migrate(database); err != nil {
		t.Fatalf("HEAD migrations failed on the alpha.4 snapshot: %v", err)
	}
	if got := count(`SELECT COUNT(*) FROM schema_versions`); got < alphaSnapshotMigrations {
		t.Fatalf("schema_versions shrank to %d after Migrate", got)
	}

	// The row-count checksum: what cmd/seed's alpha profile promises.
	for _, tc := range []struct {
		q    string
		want int
	}{
		{`SELECT COUNT(*) FROM users`, 100},
		{`SELECT COUNT(*) FROM channels`, 52}, // 12 server + 40 DM
		{`SELECT COUNT(*) FROM channels WHERE type = 'dm'`, 40},
		{`SELECT COUNT(*) FROM channels WHERE archived = 1`, 1},
		{`SELECT COUNT(*) FROM channel_overrides`, 4},      // 3 channels carry them
		{`SELECT COUNT(*) FROM channel_user_overrides`, 2}, // 2 channels carry them
		{`SELECT COUNT(*) FROM messages`, 20000},
		{`SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type = 'dm'`, 3000},
		{`SELECT COUNT(*) FROM dm_participants`, 80},
		{`SELECT COUNT(*) FROM attachments`, 300},
		{`SELECT COUNT(*) FROM reactions`, 500},
		{`SELECT COUNT(*) FROM invites`, 30},
		{`SELECT COUNT(*) FROM invites WHERE revoked = 1`, 10},
		{`SELECT COUNT(*) FROM plugins`, 1},
		{`SELECT COUNT(*) FROM plugins WHERE enabled = 0`, 1},
		// A quiescent, scrubbed server carries none of these — see the
		// profile's package comment (voice is ephemeral; the replay log is
		// empty on a restarted server; sessions and tokens are scrubbed).
		{`SELECT COUNT(*) FROM sessions`, 0},
		{`SELECT COUNT(*) FROM api_tokens`, 0},
		{`SELECT COUNT(*) FROM events`, 0},
		{`SELECT COUNT(*) FROM voice_states`, 0},
	} {
		if got := count(tc.q); got != tc.want {
			t.Errorf("%s = %d, want %d", tc.q, got, tc.want)
		}
	}

	// FTS came along: the virtual table indexes every message.
	if got := count(`SELECT COUNT(*) FROM messages_fts`); got != 20000 {
		t.Errorf("messages_fts holds %d rows, want 20000", got)
	}

	// Realism invariants a live database cannot violate (Codex on #1469):
	// nothing is authored before its author joined, ids follow timestamps as
	// insertion order does, and every attachment records its uploader.
	for _, tc := range []struct {
		what, q string
	}{
		{"messages authored before their author joined",
			`SELECT COUNT(*) FROM messages m JOIN users u ON u.id = m.user_id WHERE m.timestamp < u.created_at`},
		{"adjacent message ids with inverted timestamps",
			`SELECT COUNT(*) FROM messages a JOIN messages b ON b.id = a.id + 1 WHERE b.timestamp < a.timestamp`},
		{"attachments without an uploader",
			`SELECT COUNT(*) FROM attachments WHERE uploader_id IS NULL`},
		{"DM messages before both members existed",
			`SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type = 'dm'
			 JOIN dm_participants dp ON dp.channel_id = c.id JOIN users u ON u.id = dp.user_id
			 WHERE m.timestamp < u.created_at`},
	} {
		if got := count(tc.q); got != 0 {
			t.Errorf("%s: %d, want 0", tc.what, got)
		}
	}
}
