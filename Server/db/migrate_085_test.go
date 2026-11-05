package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestMigration085_SessionIdentityKey: 085 adds a nullable
// sessions.identity_public_key, a session that existed before it keeps NULL,
// and SetSessionIdentityKey stores the key on exactly the named session.
func TestMigration085_SessionIdentityKey(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	mustDo(t, "MigrateFS up to 084", db.MigrateFS(database, migrationsUpTo(t, "085_")))
	if columnExists(t, database, "sessions", "identity_public_key") {
		t.Fatal("sessions.identity_public_key exists before 085; the test no longer exercises the migration")
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'u', 'x', 1)`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO sessions (user_id, token, expires_at) VALUES (1, 'old', '2099-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("insert pre-085 session: %v", err)
	}

	mustDo(t, "Migrate 085", db.MigrateFS(database, migrationsUpTo(t, "086_")))
	if !columnExists(t, database, "sessions", "identity_public_key") {
		t.Fatal("sessions.identity_public_key missing after 085")
	}
	read := func(token string) *string {
		t.Helper()
		var k *string
		if err := database.QueryRowContext(ctx, `SELECT identity_public_key FROM sessions WHERE token = ?`, token).Scan(&k); err != nil {
			t.Fatalf("read %s: %v", token, err)
		}
		return k
	}
	if read("old") != nil {
		t.Fatal("a session from before 085 must carry a NULL key")
	}

	if _, err := database.ExecContext(ctx,
		`INSERT INTO sessions (user_id, token, expires_at) VALUES (1, 'other', '2099-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("insert second session: %v", err)
	}
	mustDo(t, "SetSessionIdentityKey", database.SetSessionIdentityKey(ctx, "old", "S0VZ"))
	if k := read("old"); k == nil || *k != "S0VZ" {
		t.Fatalf("stored key = %v, want S0VZ", k)
	}
	if read("other") != nil {
		t.Fatal("SetSessionIdentityKey touched a different session")
	}
	// Last write wins, and an unknown token is not an error.
	mustDo(t, "second write", database.SetSessionIdentityKey(ctx, "old", "S0VZMg=="))
	if k := read("old"); k == nil || *k != "S0VZMg==" {
		t.Fatalf("stored key after rewrite = %v", k)
	}
	mustDo(t, "unknown token", database.SetSessionIdentityKey(ctx, "gone", "S0VZ"))
}
