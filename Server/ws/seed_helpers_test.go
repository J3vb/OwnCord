package ws_test

import (
	"context"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// openSchemaDB opens an in-memory DB migrated with only the given schema, the
// minimal table set a test file declares for itself.
func openSchemaDB(t testing.TB, schema []byte) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.MigrateFS(database, fstest.MapFS{"001_schema.sql": {Data: schema}}); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// openMigratedDB opens an in-memory DB with the full production migration set.
func openMigratedDB(t testing.TB) *db.DB {
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

// seedUserWithRole inserts a user holding roleID and returns the stored row.
func seedUserWithRole(t testing.TB, database *db.DB, username string, roleID int) *db.User {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "hash", roleID); err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	return user
}

// Seeding helpers shared with the internal tests; their implementations live
// in session_helpers_internal_test.go.
var (
	mustCreateUser    = ws.MustCreateUser
	mustJoinVoice     = ws.MustJoinVoice
	mustCreateChannel = ws.MustCreateChannel
	mustExec          = ws.MustExec
	mustGetUser       = ws.MustGetUser
	mustCreateMessage = ws.MustCreateMessage
	seedSessionToken  = ws.SeedSessionToken
)
