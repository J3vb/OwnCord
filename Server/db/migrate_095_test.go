package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func backupScopeValue(t *testing.T, database *db.DB) string {
	t.Helper()
	var v string
	if err := database.QueryRowContext(context.Background(), `SELECT value FROM settings WHERE key = 'backup_scope'`).Scan(&v); err != nil {
		t.Fatalf("read backup_scope: %v", err)
	}
	return v
}

// A server with no accounts yet is a new one: automatic backups start on everything.
func TestMigration095_FreshDatabaseBacksUpEverything(t *testing.T) {
	t.Parallel()
	database := openMemory(t)
	mustDo(t, "Migrate", db.Migrate(database))
	if got := backupScopeValue(t, database); got != "everything" {
		t.Errorf("backup_scope on a fresh database = %q, want everything", got)
	}
}

// A server that already has people keeps taking database-only copies and asks the owner to choose.
func TestMigration095_DatabaseWithAUserIsUnset(t *testing.T) {
	t.Parallel()
	database := openMemory(t)
	mustDo(t, "pre-095 schema", db.MigrateFS(database, migrationsUpTo(t, "095_")))
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'alice', 'hash', 4)`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	mustDo(t, "Migrate", db.Migrate(database))
	if got := backupScopeValue(t, database); got != "unset" {
		t.Errorf("backup_scope on a database with a user = %q, want unset", got)
	}
}

// The row is written once: a later run leaves the owner's choice alone.
func TestMigration095_DoesNotOverwriteAChoice(t *testing.T) {
	t.Parallel()
	database := openMemory(t)
	mustDo(t, "pre-095 schema", db.MigrateFS(database, migrationsUpTo(t, "095_")))
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO settings (key, value) VALUES ('backup_scope', 'database')`); err != nil {
		t.Fatalf("seed backup_scope: %v", err)
	}
	mustDo(t, "Migrate", db.Migrate(database))
	if got := backupScopeValue(t, database); got != "database" {
		t.Errorf("backup_scope = %q, want the existing choice database kept", got)
	}
}
