package db_test

import (
	"context"
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
	if err := database.BackupToSafe(context.Background(), backupPath, backupDir); err != nil {
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
	err := database.BackupToSafe(context.Background(), escapePath, backupDir)
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
	err := database.BackupToSafe(context.Background(), malicious, backupDir)
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
	err := database.BackupToSafe(context.Background(), malicious, backupDir)
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
	err := database.BackupToSafe(context.Background(), malicious, backupDir)
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
	malicious := filepath.Join(backupDir, "evil\x00.db") //nolint:gocritic // intentional null byte for security test
	err := database.BackupToSafe(context.Background(), malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with null byte in path should return error, got nil")
	}
}

// TestBackupToSafe_ErrorKeepsPreexistingFile locks the cleanup guard: a
// failed VACUUM INTO removes a partial file it created, but an error caused
// by the destination already existing must never delete the operator's file.
func TestBackupToSafe_ErrorKeepsPreexistingFile(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	existing := filepath.Join(backupDir, "keep_me.db")
	if err := os.WriteFile(existing, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}

	// VACUUM INTO refuses an existing destination.
	if err := database.BackupToSafe(context.Background(), existing, backupDir); err == nil {
		t.Fatal("BackupToSafe over an existing file should error")
	}
	content, err := os.ReadFile(existing)
	if err != nil || string(content) != "precious" {
		t.Fatalf("pre-existing file was modified or removed (content=%q, err=%v)", content, err)
	}
}

// TestCheckBackupIntegrity_ValidAndCorrupt verifies the integrity gate both
// accepts a real backup and rejects a non-database file.
func TestCheckBackupIntegrity_ValidAndCorrupt(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	good := filepath.Join(backupDir, "good.db")
	if err := database.BackupToSafe(context.Background(), good, backupDir); err != nil {
		t.Fatalf("BackupToSafe: %v", err)
	}
	if err := db.CheckBackupIntegrity(context.Background(), good); err != nil {
		t.Fatalf("CheckBackupIntegrity on a fresh backup: %v", err)
	}

	bad := filepath.Join(backupDir, "bad.db")
	if err := os.WriteFile(bad, []byte("this is not a sqlite database at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := db.CheckBackupIntegrity(context.Background(), bad); err == nil {
		t.Fatal("CheckBackupIntegrity accepted a garbage file")
	}

	if err := db.CheckBackupIntegrity(context.Background(), filepath.Join(backupDir, "missing.db")); err == nil {
		t.Fatal("CheckBackupIntegrity accepted a missing file")
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
	err := database.BackupToSafe(context.Background(), malicious, backupDir)
	if err == nil {
		t.Error("BackupToSafe() with double-quote in path should return error, got nil")
	}
}
