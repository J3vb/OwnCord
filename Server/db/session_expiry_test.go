package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

// TestDeleteExpiredSessions_SargableFormat locks the migration-031 contract:
// the sweep's plain-text cutoff comparison deletes exactly the expired
// sessions when rows are stored in the normalized RFC3339-Z layout, and the
// supporting index exists.
func TestDeleteExpiredSessions_SargableFormat(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.MigrateFS(database, migrations.FS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	ctx := context.Background()

	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'x', 1)`); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	const layout = "2006-01-02T15:04:05Z"
	insert := func(token, expires string) {
		t.Helper()
		if _, err := database.ExecContext(ctx,
			`INSERT INTO sessions (user_id, token, expires_at) VALUES (1, ?, ?)`, token, expires); err != nil {
			t.Fatalf("seed session %s: %v", token, err)
		}
	}
	insert("expired", time.Now().UTC().Add(-time.Hour).Format(layout))
	insert("live", time.Now().UTC().Add(time.Hour).Format(layout))
	// A legacy space-format row normalized by migration 031's UPDATE — the
	// migration ran before these inserts, so normalize it the same way here
	// to model a post-migration database.
	insert("legacy_live", time.Now().UTC().Add(2*time.Hour).Format("2006-01-02T15:04:05Z"))

	if err := database.DeleteExpiredSessions(ctx); err != nil {
		t.Fatalf("DeleteExpiredSessions: %v", err)
	}

	var tokens []string
	rows, err := database.QueryContext(ctx, `SELECT token FROM sessions ORDER BY token`)
	if err != nil {
		t.Fatalf("query sessions: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var tok string
		if err := rows.Scan(&tok); err != nil {
			t.Fatal(err)
		}
		tokens = append(tokens, tok)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 2 || tokens[0] != "legacy_live" || tokens[1] != "live" {
		t.Fatalf("surviving sessions = %v, want [legacy_live live]", tokens)
	}

	// The index the sweep depends on must exist.
	var n int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_expires_at'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("idx_sessions_expires_at is missing")
	}
}

// TestMigration031_NormalizesLegacyFormats drives the real migration file:
// it builds the pre-031 schema with migrationCutoffFS, seeds legacy
// space-separated and Z-less expires_at rows on it, then applies the full
// chain so migration 031's one-time UPDATE pass is what normalizes them.
func TestMigration031_NormalizesLegacyFormats(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()

	if err := db.MigrateFS(database, migrationCutoffFS{underlying: migrations.FS, cutoff: "031_"}); err != nil {
		t.Fatalf("MigrateFS building pre-031 schema: %v", err)
	}
	var idx int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_expires_at'`).Scan(&idx); err != nil {
		t.Fatal(err)
	}
	if idx != 0 {
		t.Fatal("idx_sessions_expires_at exists before 031 ran — cutoff FS leaked the migration")
	}

	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'x', 1)`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	cases := []struct{ token, stored, want string }{
		{"legacy_space", "2030-05-01 10:00:00", "2030-05-01T10:00:00Z"},
		{"legacy_no_z", "2030-06-02T11:22:33", "2030-06-02T11:22:33Z"},
		{"already_normalized", "2030-07-03T12:34:56Z", "2030-07-03T12:34:56Z"},
	}
	for _, tc := range cases {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO sessions (user_id, token, expires_at) VALUES (1, ?, ?)`, tc.token, tc.stored); err != nil {
			t.Fatalf("seed session %s: %v", tc.token, err)
		}
	}

	// Only 031 is left to apply, so any change below is its doing.
	if err := db.MigrateFS(database, migrations.FS); err != nil {
		t.Fatalf("MigrateFS applying 031: %v", err)
	}

	for _, tc := range cases {
		var got string
		if err := database.QueryRowContext(ctx,
			`SELECT expires_at FROM sessions WHERE token = ?`, tc.token).Scan(&got); err != nil {
			t.Fatalf("read %s: %v", tc.token, err)
		}
		if got != tc.want {
			t.Errorf("%s: expires_at = %q, want %q", tc.token, got, tc.want)
		}
	}
}
