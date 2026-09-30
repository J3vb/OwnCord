package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
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
// it builds the pre-031 schema with migrationsUpTo, seeds legacy
// space-separated and Z-less expires_at rows on it, then applies the full
// chain so migration 031's one-time UPDATE pass is what normalizes them.
func TestMigration031_NormalizesLegacyFormats(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()

	if err := db.MigrateFS(database, migrationsUpTo(t, "031_")); err != nil {
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

// seedAgedSession inserts a session created `age` ago that expires at
// expiresAt, the shape a real row has after `age` of use (DP-05).
func seedAgedSession(t *testing.T, database *db.DB, token string, age time.Duration, expiresAt time.Time) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.ExecContext(ctx,
		`INSERT OR IGNORE INTO users (id, username, password, role_id) VALUES (1, 'u', 'x', 1)`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (1, ?, ?, ?)`,
		token,
		time.Now().UTC().Add(-age).Format("2006-01-02 15:04:05"),
		expiresAt.UTC().Format("2006-01-02T15:04:05Z")); err != nil {
		t.Fatalf("seed session %s: %v", token, err)
	}
}

func sessionExpiresAt(t *testing.T, database *db.DB, token string) string {
	t.Helper()
	sess, err := database.GetSessionByTokenHash(context.Background(), token)
	if err != nil || sess == nil {
		t.Fatalf("GetSessionByTokenHash(%s): %v (sess=%v)", token, err, sess)
	}
	return sess.ExpiresAt
}

func parseExpiry(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse("2006-01-02T15:04:05Z", s)
	if err != nil {
		t.Fatalf("parse expires_at %q: %v", s, err)
	}
	return ts
}

// TestTouchSession_SlidesIdleExpiry pins DP-05: using a session pushes its
// expiry to a full idle window from now, so a user who keeps opening the app
// is not signed out by age alone.
func TestTouchSession_SlidesIdleExpiry(t *testing.T) {
	database := openMigratedMemory(t)
	seedAgedSession(t, database, "active", 29*24*time.Hour, time.Now().Add(24*time.Hour))

	if err := database.TouchSessions(context.Background(), []string{"active"}); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}

	got := parseExpiry(t, sessionExpiresAt(t, database, "active"))
	want := time.Now().UTC().Add(30 * 24 * time.Hour)
	if d := want.Sub(got); d < -time.Minute || d > time.Minute {
		t.Fatalf("expires_at = %v, want about %v (now + 30 days)", got, want)
	}
}

// TestTouchSession_NeverRevivesExpired pins the revocation-race guard: a
// touch landing after a session lapsed must leave it lapsed, and the auth
// check must still refuse it.
func TestTouchSession_NeverRevivesExpired(t *testing.T) {
	database := openMigratedMemory(t)
	seedAgedSession(t, database, "lapsed", 31*24*time.Hour, time.Now().Add(-time.Hour))
	before := sessionExpiresAt(t, database, "lapsed")

	if err := database.TouchSessions(context.Background(), []string{"lapsed"}); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}

	after := sessionExpiresAt(t, database, "lapsed")
	if after != before {
		t.Fatalf("expires_at moved from %q to %q; an expired session must never be revived", before, after)
	}
	if !auth.IsSessionExpired(after) {
		t.Fatalf("IsSessionExpired(%q) = false after touching an expired session", after)
	}
}

// TestTouchSession_AbsoluteCap pins D-1's one-year cap from sign-in: a touch
// never extends a session past created_at + 365 days, however active it is.
func TestTouchSession_AbsoluteCap(t *testing.T) {
	database := openMigratedMemory(t)
	const capAge = 365 * 24 * time.Hour

	// Created 364 days ago: sliding would give now+30d, the cap allows one more day.
	seedAgedSession(t, database, "near_cap", capAge-24*time.Hour, time.Now().Add(24*time.Hour))
	// Created 366 days ago with an expiry still ahead: must not be extended.
	seedAgedSession(t, database, "past_cap", capAge+24*time.Hour, time.Now().Add(time.Hour))
	pastBefore := parseExpiry(t, sessionExpiresAt(t, database, "past_cap"))

	ctx := context.Background()
	for _, tok := range []string{"near_cap", "past_cap"} {
		if err := database.TouchSessions(ctx, []string{tok}); err != nil {
			t.Fatalf("TouchSession(%s): %v", tok, err)
		}
	}

	near := parseExpiry(t, sessionExpiresAt(t, database, "near_cap"))
	wantNear := time.Now().UTC().Add(24 * time.Hour)
	if d := wantNear.Sub(near); d < -time.Minute || d > time.Minute {
		t.Errorf("near_cap expires_at = %v, want about %v (created_at + 365 days)", near, wantNear)
	}
	if past := parseExpiry(t, sessionExpiresAt(t, database, "past_cap")); past.After(pastBefore) {
		t.Errorf("past_cap expires_at extended from %v to %v; a session older than the cap must not be", pastBefore, past)
	}
}

// TestTouchSessions_OneBatchSlidesEveryLiveSession pins P5-S07's batched
// touch: one call slides every live session it names, more than one
// statement's worth of them included, and still never revives a lapsed one.
func TestTouchSessions_OneBatchSlidesEveryLiveSession(t *testing.T) {
	database := openMigratedMemory(t)
	tokens := make([]string, 0, 1201)
	for i := range 1200 {
		tok := fmt.Sprintf("live-%d", i)
		seedAgedSession(t, database, tok, 2*24*time.Hour, time.Now().Add(24*time.Hour))
		tokens = append(tokens, tok)
	}
	seedAgedSession(t, database, "lapsed", 31*24*time.Hour, time.Now().Add(-time.Hour))
	before := sessionExpiresAt(t, database, "lapsed")
	tokens = append(tokens, "lapsed", "no-such-token")

	if err := database.TouchSessions(context.Background(), tokens); err != nil {
		t.Fatalf("TouchSessions: %v", err)
	}

	want := time.Now().UTC().Add(30 * 24 * time.Hour)
	for _, tok := range []string{"live-0", "live-999", "live-1000", "live-1199"} {
		got := parseExpiry(t, sessionExpiresAt(t, database, tok))
		if d := want.Sub(got); d < -time.Minute || d > time.Minute {
			t.Errorf("%s expires_at = %v, want about %v", tok, got, want)
		}
	}
	if after := sessionExpiresAt(t, database, "lapsed"); after != before {
		t.Fatalf("lapsed expires_at moved from %q to %q; a batch must never revive a session", before, after)
	}
}
