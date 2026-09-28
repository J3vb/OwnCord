package app

import (
	"context"
	"database/sql"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

// migrationsUpTo exposes only the embedded migrations whose filenames sort
// before cutoff, so the test can build a real database at an older schema
// point. The db package's own copy is test-only there and not importable.
func migrationsUpTo(t *testing.T, cutoff string) fstest.MapFS {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	out := fstest.MapFS{}
	for _, e := range entries {
		if e.Name() >= cutoff {
			continue
		}
		data, err := fs.ReadFile(migrations.FS, e.Name())
		if err != nil {
			t.Fatalf("ReadFile(%s): %v", e.Name(), err)
		}
		out[e.Name()] = &fstest.MapFile{Data: data}
	}
	return out
}

// onlyBackup returns the single pre-migration backup in dir, failing when
// there is not exactly one.
func onlyBackup(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	var found []string
	for _, e := range entries {
		if !e.IsDir() {
			found = append(found, filepath.Join(dir, e.Name()))
		}
	}
	if len(found) != 1 {
		t.Fatalf("backup dir %s holds %d files (%v), want exactly one pre-migration backup", dir, len(found), found)
	}
	return found[0]
}

// TestInitDatabase_BacksUpBeforeApplyingPendingMigrations is the core
// promise: a boot that is about to move the schema takes a verified copy of
// the database FIRST, so a `docker compose pull` cannot migrate an
// unbacked-up database. The copy must hold the PRE-migration schema, which is
// what makes it a rollback target.
func TestInitDatabase_BacksUpBeforeApplyingPendingMigrations(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chatserver.db")
	backupDir := filepath.Join(dir, "backups")
	t.Cleanup(func() { admin.SetBackupDir(filepath.Join("data", "backups")) })

	// Build a real database at a partial schema point, with a row, and close
	// it — the state of a server one `pull` away from a schema move.
	seed, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open seed: %v", err)
	}
	if err := db.MigrateFS(seed, migrationsUpTo(t, "020_")); err != nil {
		t.Fatalf("MigrateFS(<020): %v", err)
	}
	if _, err := seed.CreateUser(context.Background(), "pre-migrate-owner", "hash", 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("Close seed: %v", err)
	}

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Database: config.DatabaseConfig{Path: dbPath},
		Backup:   config.BackupConfig{Dir: backupDir},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rc := NewRestartCoordinator(time.Hour, nil)

	if err := initDatabase(log, cfg, database, rc); err != nil {
		t.Fatalf("initDatabase: %v", err)
	}

	backup := onlyBackup(t, backupDir)
	if base := filepath.Base(backup); !strings.HasPrefix(base, admin.PreMigrateBackupPrefix) {
		t.Fatalf("backup %q does not carry the %q prefix", base, admin.PreMigrateBackupPrefix)
	}
	if err := db.CheckBackupIntegrity(context.Background(), backup); err != nil {
		t.Fatalf("pre-migration backup failed integrity_check: %v", err)
	}

	// The copy must predate the migration: its schema_versions must not name
	// any migration the boot applied.
	if hasVersion(t, backup, "021_voice_server_moderation.sql") {
		t.Fatal("pre-migration backup contains a post-migration schema_versions row — it was taken AFTER migrating, not before")
	}
	// And the live database did move forward.
	if !hasVersion(t, dbPath, "021_voice_server_moderation.sql") {
		t.Fatal("live database was not migrated to HEAD")
	}
}

// TestInitDatabase_UpgradeAfterRollbackTakesFreshBackup covers upgrade,
// rollback that leaves the first pre_migrate_ copy behind, then upgrade again:
// the second boot faces the same first pending migration, and must still take
// a fresh copy holding the data written since the rollback, beside the
// untouched earlier one.
func TestInitDatabase_UpgradeAfterRollbackTakesFreshBackup(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chatserver.db")
	archive := filepath.Join(dir, "archive.db")
	backupDir := filepath.Join(dir, "backups")
	t.Cleanup(func() { admin.SetBackupDir(filepath.Join("data", "backups")) })

	seed, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open seed: %v", err)
	}
	if err := db.MigrateFS(seed, migrationsUpTo(t, "020_")); err != nil {
		t.Fatalf("MigrateFS(<020): %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("Close seed: %v", err)
	}
	copyFile(t, dbPath, archive)

	cfg := &config.Config{
		Database: config.DatabaseConfig{Path: dbPath},
		Backup:   config.BackupConfig{Dir: backupDir},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	boot := func() {
		t.Helper()
		database, err := db.Open(dbPath)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if err := initDatabase(log, cfg, database, NewRestartCoordinator(time.Hour, nil)); err != nil {
			t.Fatalf("initDatabase: %v", err)
		}
		if err := database.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}

	boot()
	first := onlyBackup(t, backupDir)

	// Roll back: restore the pre-upgrade archive over the live database,
	// leaving the backup directory as it is, and run the old version long
	// enough to write new data.
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(dbPath + suffix)
	}
	copyFile(t, archive, dbPath)
	old, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open rolled-back: %v", err)
	}
	if _, err := old.CreateUser(context.Background(), "rollback-era-user", "hash", 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := old.Close(); err != nil {
		t.Fatalf("Close rolled-back: %v", err)
	}

	boot()

	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("backup dir holds %d files, want the earlier copy plus a fresh one", len(entries))
	}
	var second string
	for _, e := range entries {
		if p := filepath.Join(backupDir, e.Name()); p != first {
			second = p
		}
	}
	if second == "" {
		t.Fatal("the earlier pre-migration copy was replaced instead of kept")
	}
	if hasUser(t, first, "rollback-era-user") {
		t.Fatal("the earlier pre-migration copy was overwritten")
	}
	if !hasUser(t, second, "rollback-era-user") {
		t.Fatal("the second upgrade migrated data written since the rollback without backing it up")
	}
	if hasVersion(t, second, "021_voice_server_moderation.sql") {
		t.Fatal("fresh pre-migration backup was taken after migrating")
	}
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		t.Fatalf("WriteFile(%s): %v", dst, err)
	}
}

// hasUser reports whether the SQLite file at path holds a user with the name.
func hasUser(t *testing.T, path, username string) bool {
	t.Helper()
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer conn.Close() //nolint:errcheck
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users WHERE username = ?`, username).Scan(&n); err != nil {
		t.Fatalf("count users in %s: %v", path, err)
	}
	return n > 0
}

// TestInitDatabase_NoBackupWhenNothingIsPending keeps the gate from firing on
// every ordinary boot: a database already at HEAD runs no migration SQL, so
// there is nothing to protect.
func TestInitDatabase_NoBackupWhenNothingIsPending(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chatserver.db")
	backupDir := filepath.Join(dir, "backups")
	t.Cleanup(func() { admin.SetBackupDir(filepath.Join("data", "backups")) })

	seed, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open seed: %v", err)
	}
	if err := db.Migrate(seed); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("Close seed: %v", err)
	}

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Database: config.DatabaseConfig{Path: dbPath},
		Backup:   config.BackupConfig{Dir: backupDir},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rc := NewRestartCoordinator(time.Hour, nil)

	if err := initDatabase(log, cfg, database, rc); err != nil {
		t.Fatalf("initDatabase: %v", err)
	}

	if entries, err := os.ReadDir(backupDir); err == nil && len(entries) > 0 {
		t.Fatalf("a boot with no pending migrations wrote %d backup file(s)", len(entries))
	}
}

// TestInitDatabase_RefusesToBootWhenBackupCannotBeWritten locks the fail-closed
// promise: with migrations pending, a backup that cannot be written must stop
// the boot rather than let the schema move unbacked-up. A path under a regular
// file can never be created as a directory, which is the cheapest portable way
// to make MkdirAll fail.
func TestInitDatabase_RefusesToBootWhenBackupCannotBeWritten(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chatserver.db")
	t.Cleanup(func() { admin.SetBackupDir(filepath.Join("data", "backups")) })

	seed, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open seed: %v", err)
	}
	if err := db.MigrateFS(seed, migrationsUpTo(t, "020_")); err != nil {
		t.Fatalf("MigrateFS(<020): %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("Close seed: %v", err)
	}

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// A file where the backup directory should be.
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rc := NewRestartCoordinator(time.Hour, nil)
	cfg := &config.Config{
		Database: config.DatabaseConfig{Path: dbPath},
		Backup:   config.BackupConfig{Dir: filepath.Join(blocker, "backups")},
	}
	if err := initDatabase(log, cfg, database, rc); err == nil {
		t.Fatal("initDatabase succeeded with an unwritable backup dir and migrations pending; it must fail closed")
	}

	// And the schema must not have moved.
	if hasVersion(t, dbPath, "021_voice_server_moderation.sql") {
		t.Fatal("the live database was migrated even though the pre-migration backup failed")
	}
}

// hasVersion reports whether the SQLite file at path records the named
// migration in schema_versions.
func hasVersion(t *testing.T, path, version string) bool {
	t.Helper()
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer conn.Close() //nolint:errcheck
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM schema_versions WHERE version = ?`, version).Scan(&n); err != nil {
		t.Fatalf("count schema_versions in %s: %v", path, err)
	}
	return n > 0
}
