package db_test

import (
	"io/fs"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

// expectedPending recomputes the unapplied filenames straight from the
// embedded FS, so the test does not hardcode a migration set that grows with
// every new migration.
func expectedPending(t *testing.T, cutoff string) []string {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if e.Name() >= cutoff {
			out = append(out, e.Name())
		}
	}
	return out
}

// TestPendingMigrations is the boot-time safety gate's input: a non-empty
// result is exactly the condition under which the server writes a
// pre-migration backup before it lets the schema move. It must stay empty for
// the two cases that run no migration SQL — a fresh database and one already
// at HEAD — or the backup would fire pointlessly on every boot.
func TestPendingMigrations(t *testing.T) {
	t.Run("fresh database reports nothing", func(t *testing.T) {
		database := openMemory(t)
		pending, err := db.PendingMigrations(database)
		if err != nil {
			t.Fatalf("PendingMigrations: %v", err)
		}
		if len(pending) != 0 {
			t.Fatalf("pending = %v, want none for a fresh database", pending)
		}
	})

	t.Run("fully migrated database reports nothing", func(t *testing.T) {
		database := openMigratedMemory(t)
		pending, err := db.PendingMigrations(database)
		if err != nil {
			t.Fatalf("PendingMigrations: %v", err)
		}
		if len(pending) != 0 {
			t.Fatalf("pending = %v, want none after Migrate", pending)
		}
	})

	t.Run("partially migrated database reports the remainder", func(t *testing.T) {
		database := openMemory(t)
		if err := db.MigrateFS(database, migrationsUpTo(t, "020_")); err != nil {
			t.Fatalf("MigrateFS(<020): %v", err)
		}
		pending, err := db.PendingMigrations(database)
		if err != nil {
			t.Fatalf("PendingMigrations: %v", err)
		}
		if want := expectedPending(t, "020_"); !slices.Equal(pending, want) {
			t.Fatalf("pending = %v, want %v", pending, want)
		}
	})
}
