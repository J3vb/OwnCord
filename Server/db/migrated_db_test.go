package db_test

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
)

// newMigratedTestDB opens an in-memory database with the *real* embedded
// migration set applied, unlike newTestDB / newAdminTestDB / newVoiceTestDB
// which run a hand-maintained subset of the schema inline.
//
// Tests for tables introduced by later migrations (rate_lockouts in 011,
// user_blocks in 012, events in 014, plugins in 015) use this so they exercise
// the schema that actually ships rather than a copy that can drift from it.
func newMigratedTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// seedBlockUser inserts a minimal user row with an explicit id so block tests
// satisfy the user_blocks foreign keys.
func seedBlockUser(t *testing.T, database *db.DB, id int64, username string) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password) VALUES (?, ?, 'x')`, id, username)
	if err != nil {
		t.Fatalf("seed user %d: %v", id, err)
	}
}
