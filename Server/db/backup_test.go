package db_test

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/owncord/server/db"
)

// newBackupTestDB opens a file-backed database suitable for VACUUM INTO tests.
// VACUUM INTO requires a file-backed source database; :memory: produces an
// empty-but-valid backup file which is sufficient for validation tests.
func newBackupFileDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "source.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database, tmpDir
}

// ─── BackupToSafe path-validation tests ─────────────────────────────────────

// TestBackupToSafe_ValidPath verifies a properly-named backup file is created.
func TestBackupToSafe_ValidPath(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "chatserver_20260315_120000.db")
	if err := database.BackupToSafe(backupPath, backupDir); err != nil {
		t.Fatalf("BackupToSafe() with valid path returned error: %v", err)
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		t.Fatalf("backup file does not exist after BackupToSafe: %v", err)
	}
	if info.Size() == 0 {
		t.Error("backup file is empty, expected non-empty SQLite file")
	}
}

// TestBackupToSafe_RejectsPathOutsideRoot ensures a path outside the safe root
// is rejected.
func TestBackupToSafe_RejectsPathOutsideRoot(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// Try to write outside backupDir
	escapePath := filepath.Join(tmpDir, "escaped.db")
	err := database.BackupToSafe(escapePath, backupDir)
	if err == nil {
		t.Error("BackupToSafe() should reject path outside safe root, got nil")
	}
}

// TestBackupToSafe_RejectsSingleQuote ensures a path containing a single-quote
// is rejected before the SQL is executed (prevents SQL injection).
func TestBackupToSafe_RejectsSingleQuote(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	malicious := filepath.Join(backupDir, "evil'.db")
	err := database.BackupToSafe(malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with single-quote in path should return error, got nil")
	}
}

// TestBackupToSafe_RejectsSemicolon ensures a semicolon in the path is rejected.
func TestBackupToSafe_RejectsSemicolon(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	malicious := filepath.Join(backupDir, "evil;drop.db")
	err := database.BackupToSafe(malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with semicolon in path should return error, got nil")
	}
}

// TestBackupToSafe_RejectsSQLComment ensures a path containing "--" is rejected.
func TestBackupToSafe_RejectsSQLComment(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	malicious := filepath.Join(backupDir, "evil--comment.db")
	err := database.BackupToSafe(malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with '--' in path should return error, got nil")
	}
}

// TestBackupToSafe_RejectsNullByte ensures a path containing a null byte is rejected.
func TestBackupToSafe_RejectsNullByte(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	malicious := filepath.Join(backupDir, "evil\x00.db")
	err := database.BackupToSafe(malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with null byte in path should return error, got nil")
	}
}

// TestBackupToSafe_RejectsDoubleQuote ensures a path containing a double-quote
// is rejected.
func TestBackupToSafe_RejectsDoubleQuote(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	malicious := filepath.Join(backupDir, `evil".db`)
	err := database.BackupToSafe(malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with double-quote in path should return error, got nil")
	}
}
