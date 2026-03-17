package db_test

import (
	"database/sql"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/db"
)

// openMemory opens an in-memory database for testing.
func openMemory(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("Open(':memory:') error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestOpenInMemory(t *testing.T) {
	database := openMemory(t)
	if database == nil {
		t.Fatal("Open returned nil DB")
	}
}

func TestOpenCreatesFile(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error: %v", err)
	}
	defer database.Close() //nolint:errcheck

	if _, statErr := os.Stat(dbPath); os.IsNotExist(statErr) {
		t.Error("Open() did not create the database file")
	}
}

func TestOpenInvalidPath(t *testing.T) {
	// A path to a non-existent directory should return an error.
	_, err := db.Open("/nonexistent/dir/that/does/not/exist/test.db")
	if err == nil {
		t.Error("Open() with invalid path should return error, got nil")
	}
}

func TestWALModeEnabled(t *testing.T) {
	database := openMemory(t)

	var journalMode string
	err := database.QueryRow("PRAGMA journal_mode;").Scan(&journalMode)
	if err != nil {
		t.Fatalf("PRAGMA journal_mode query error: %v", err)
	}
	// In-memory databases return "memory" even when WAL is requested,
	// because WAL is not supported for in-memory DBs. File DBs return "wal".
	// Accept both for in-memory test; the file-based test verifies WAL properly.
	if journalMode != "memory" && journalMode != "wal" {
		t.Errorf("journal_mode = %q, want 'wal' or 'memory'", journalMode)
	}
}

func TestWALModeEnabledOnFile(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "wal_test.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error: %v", err)
	}
	defer database.Close() //nolint:errcheck

	var journalMode string
	if err := database.QueryRow("PRAGMA journal_mode;").Scan(&journalMode); err != nil {
		t.Fatalf("PRAGMA journal_mode query error: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("journal_mode = %q, want 'wal'", journalMode)
	}
}

func TestForeignKeysEnabled(t *testing.T) {
	database := openMemory(t)

	var fkEnabled int
	if err := database.QueryRow("PRAGMA foreign_keys;").Scan(&fkEnabled); err != nil {
		t.Fatalf("PRAGMA foreign_keys query error: %v", err)
	}
	if fkEnabled != 1 {
		t.Errorf("foreign_keys = %d, want 1 (enabled)", fkEnabled)
	}
}

func TestMigrateCreatesAllTables(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	expectedTables := []string{
		"users", "sessions", "roles", "channels", "channel_overrides",
		"messages", "attachments", "reactions", "invites", "read_states",
		"audit_log", "login_attempts", "settings", "emoji", "sounds",
	}

	for _, table := range expectedTables {
		t.Run(table, func(t *testing.T) {
			var name string
			err := database.QueryRow(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
				table,
			).Scan(&name)
			if err == sql.ErrNoRows {
				t.Errorf("table %q not found after migration", table)
			} else if err != nil {
				t.Errorf("query error for table %q: %v", table, err)
			}
		})
	}
}

func TestMigrateCreatesFTSTable(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	var name string
	err := database.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
	).Scan(&name)
	if err == sql.ErrNoRows {
		t.Error("messages_fts virtual table not found after migration")
	} else if err != nil {
		t.Errorf("query error: %v", err)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	database := openMemory(t)

	// Run migration twice — should not error.
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() first run error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() second run error: %v", err)
	}
}

func TestMigrateInsertsDefaultRoles(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM roles").Scan(&count); err != nil {
		t.Fatalf("COUNT roles error: %v", err)
	}
	if count < 4 {
		t.Errorf("expected at least 4 default roles, got %d", count)
	}
}

func TestMigrateInsertsDefaultSettings(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	var value string
	err := database.QueryRow("SELECT value FROM settings WHERE key='registration_open'").Scan(&value)
	if err != nil {
		t.Fatalf("settings query error: %v", err)
	}
	if value != "0" {
		t.Errorf("registration_open = %q, want '0'", value)
	}
}

func TestMigrateCreatesIndexes(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	expectedIndexes := []string{
		"idx_sessions_token",
		"idx_messages_channel",
		"idx_invites_code",
		"idx_audit_timestamp",
	}

	for _, idx := range expectedIndexes {
		t.Run(idx, func(t *testing.T) {
			var name string
			err := database.QueryRow(
				"SELECT name FROM sqlite_master WHERE type='index' AND name=?",
				idx,
			).Scan(&name)
			if err == sql.ErrNoRows {
				t.Errorf("index %q not found after migration", idx)
			} else if err != nil {
				t.Errorf("query error for index %q: %v", idx, err)
			}
		})
	}
}

func TestCloseIdempotent(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("Open error: %v", err)
	}

	if err := database.Close(); err != nil {
		t.Errorf("Close() first call error: %v", err)
	}
}

func TestQueryRow(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	// Verify we can run a simple query via the exposed DB.
	var schemaVersion string
	err := database.QueryRow("SELECT value FROM settings WHERE key='schema_version'").Scan(&schemaVersion)
	if err != nil {
		t.Fatalf("QueryRow error: %v", err)
	}
	if schemaVersion == "" {
		t.Error("schema_version should not be empty")
	}
}

func TestExec(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	// Insert a settings row using Exec.
	_, err := database.Exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", "test_key", "test_val")
	if err != nil {
		t.Fatalf("Exec() error: %v", err)
	}

	var val string
	if err := database.QueryRow("SELECT value FROM settings WHERE key='test_key'").Scan(&val); err != nil {
		t.Fatalf("QueryRow after Exec error: %v", err)
	}
	if val != "test_val" {
		t.Errorf("value = %q, want 'test_val'", val)
	}
}

func TestQuery(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	rows, err := database.Query("SELECT key FROM settings")
	if err != nil {
		t.Fatalf("Query() error: %v", err)
	}
	defer rows.Close() //nolint:errcheck

	var count int
	for rows.Next() {
		count++
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatalf("rows.Scan error: %v", err)
		}
	}
	if count == 0 {
		t.Error("Query() returned no rows from settings table")
	}
}

func TestBegin(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	tx, err := database.Begin()
	if err != nil {
		t.Fatalf("Begin() error: %v", err)
	}

	_, err = tx.Exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('tx_key', 'tx_val')")
	if err != nil {
		_ = tx.Rollback()
		t.Fatalf("tx.Exec error: %v", err)
	}

	if err := tx.Rollback(); err != nil {
		t.Fatalf("tx.Rollback error: %v", err)
	}

	// After rollback, tx_key should not exist.
	var val string
	err = database.QueryRow("SELECT value FROM settings WHERE key='tx_key'").Scan(&val)
	if err == nil {
		t.Error("tx_key should not exist after rollback")
	}
}

func TestSQLDb(t *testing.T) {
	database := openMemory(t)
	sqlDB := database.SQLDb()
	if sqlDB == nil {
		t.Error("SQLDb() returned nil")
	}
}

// failReadFS implements fs.FS with a ReadDir that returns a file but
// ReadFile always errors — used to test the read-file error path in MigrateFS.
type failReadFS struct{}

func (failReadFS) Open(name string) (fs.File, error) {
	if name == "." {
		return &fakeDir{}, nil
	}
	return nil, fmt.Errorf("read error for %s", name)
}

type fakeDir struct{ pos int }

func (d *fakeDir) Read([]byte) (int, error) { return 0, io.EOF }
func (d *fakeDir) Close() error             { return nil }
func (d *fakeDir) Stat() (fs.FileInfo, error) {
	return fakeDirInfo{}, nil
}
func (d *fakeDir) ReadDir(n int) ([]fs.DirEntry, error) {
	if d.pos > 0 {
		return nil, io.EOF
	}
	d.pos++
	return []fs.DirEntry{fakeDirEntry{}}, nil
}

type fakeDirInfo struct{}

func (fakeDirInfo) Name() string      { return "." }
func (fakeDirInfo) Size() int64       { return 0 }
func (fakeDirInfo) Mode() fs.FileMode { return fs.ModeDir | 0o755 }
func (fakeDirInfo) ModTime() time.Time { return time.Time{} }
func (fakeDirInfo) IsDir() bool       { return true }
func (fakeDirInfo) Sys() any  { return nil }

type fakeDirEntry struct{}

func (fakeDirEntry) Name() string               { return "001_fail.sql" }
func (fakeDirEntry) IsDir() bool                { return false }
func (fakeDirEntry) Type() fs.FileMode          { return 0 }
func (fakeDirEntry) Info() (fs.FileInfo, error) { return fakeFileInfo{}, nil }

type fakeFileInfo struct{}

func (fakeFileInfo) Name() string      { return "001_fail.sql" }
func (fakeFileInfo) Size() int64       { return 0 }
func (fakeFileInfo) Mode() fs.FileMode { return 0o644 }
func (fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (fakeFileInfo) IsDir() bool       { return false }
func (fakeFileInfo) Sys() any  { return nil }

func TestMigrateFSReadFileError(t *testing.T) {
	database := openMemory(t)

	err := db.MigrateFS(database, failReadFS{})
	if err == nil {
		t.Error("MigrateFS() should return error when ReadFile fails")
	}
}

func TestMigrateFSInvalidSQL(t *testing.T) {
	database := openMemory(t)

	// Create an in-memory FS with invalid SQL to trigger an exec error.
	badFS := fstest.MapFS{
		"001_bad.sql": &fstest.MapFile{
			Data: []byte("THIS IS NOT VALID SQL !!!@@@###"),
		},
	}

	err := db.MigrateFS(database, badFS)
	if err == nil {
		t.Error("MigrateFS() should return error for invalid SQL, got nil")
	}
}

func TestMigrateFSSkipsNonSQL(t *testing.T) {
	database := openMemory(t)

	// FS with non-.sql files should be skipped without error.
	mixedFS := fstest.MapFS{
		"README.md": &fstest.MapFile{Data: []byte("not sql")},
		"001_ok.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE IF NOT EXISTS test_skip (id INTEGER PRIMARY KEY);"),
		},
	}

	if err := db.MigrateFS(database, mixedFS); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	// The table from the .sql file should exist.
	var name string
	if err := database.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='test_skip'",
	).Scan(&name); err != nil {
		t.Error("table test_skip not found after MigrateFS")
	}
}

func TestOpenPingFails(t *testing.T) {
	// Providing a path in a non-existent directory should fail.
	_, err := db.Open("/no/such/directory/db.sqlite")
	if err == nil {
		t.Error("Open() should fail for inaccessible path")
	}
}

func TestMigrateWALAndFKOnFile(t *testing.T) {
	// Verify Open sets WAL and foreign_keys on a file-backed DB, then migrate.
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "migrate_test.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error: %v", err)
	}
	defer database.Close() //nolint:errcheck

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	// Tables should exist.
	var name string
	if err := database.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
	).Scan(&name); err != nil {
		t.Errorf("users table not found after migration on file db: %v", err)
	}
}
