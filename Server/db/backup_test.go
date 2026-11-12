package db_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/db"
)

// openBackupSourceDB opens an unmigrated file-backed database in a fresh
// temp dir and returns the dir, for tests that choose their own schema.
func openBackupSourceDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	tmpDir := t.TempDir()
	database, err := db.Open(filepath.Join(tmpDir, "source.db"))
	mustDo(t, "db.Open", err)
	t.Cleanup(func() { _ = database.Close() })
	return database, tmpDir
}

// newBackupTestDB opens a file-backed database suitable for VACUUM INTO tests.
// VACUUM INTO requires a file-backed source database; :memory: produces an
// empty-but-valid backup file which is sufficient for validation tests.
func newBackupFileDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	database, tmpDir := openBackupSourceDB(t)
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminTestSchema},
	}
	mustDo(t, "MigrateFS", db.MigrateFS(database, migrFS))
	return database, tmpDir
}

// ─── BackupToSafe path-validation tests ─────────────────────────────────────

// TestBackupToSafe_ValidPath verifies a properly-named backup file is created.
func TestBackupToSafe_ValidPath(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	backupPath := filepath.Join(backupDir, "chatserver_20260315_120000.db")
	mustDo(t, "BackupToSafe() with valid path returned error", database.BackupToSafe(context.Background(), backupPath, backupDir))

	info, err := os.Stat(backupPath)
	mustDo(t, "backup file does not exist after BackupToSafe", err)
	if info.Size() == 0 {
		t.Error("backup file is empty, expected non-empty SQLite file")
	}
}

// TestBackupToSafe_RejectsPathOutsideRoot ensures a path outside the safe root
// is rejected.
func TestBackupToSafe_RejectsPathOutsideRoot(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	// Try to write outside backupDir
	escapePath := filepath.Join(tmpDir, "escaped.db")
	err := database.BackupToSafe(context.Background(), escapePath, backupDir)
	if err == nil {
		t.Error("BackupToSafe() should reject path outside safe root, got nil")
	}
}

// TestBackupToSafe_AcceptsAnyNameTheFilesystemAllows: the backup folder sits
// under wherever the operator installed the server, so its path can hold an
// accented user name, brackets, an apostrophe or a double hyphen. Each such
// path must produce a restorable backup at exactly that name, and nothing else.
func TestBackupToSafe_AcceptsAnyNameTheFilesystemAllows(t *testing.T) {
	names := []string{"o'neil", "a;b", "a--b", "Jörg (x86) +@&!", "100% #1 [new] {x}=$,"}
	if runtime.GOOS != "windows" {
		names = append(names, `say "hi"`, "what?", "a*b|c<d>")
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			database, tmpDir := newBackupFileDB(t)
			backupDir := filepath.Join(tmpDir, name, "backups")
			mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
			backupPath := filepath.Join(backupDir, name+".db")

			mustDo(t, "BackupToSafe", database.BackupToSafe(context.Background(), backupPath, backupDir))
			mustDo(t, "CheckBackupIntegrity", db.CheckBackupIntegrity(context.Background(), backupPath))

			entries, err := os.ReadDir(backupDir)
			mustDo(t, "ReadDir", err)
			if len(entries) != 1 || entries[0].Name() != name+".db" {
				t.Errorf("backup dir holds %v, want only %q", entries, name+".db")
			}
		})
	}
}

// TestBackupToSafe_QuotedNameCannotRunSQL: a destination that reads like the
// end of a string followed by a statement is only ever a file name.
func TestBackupToSafe_QuotedNameCannotRunSQL(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	_, err := database.ExecContext(context.Background(), `CREATE TABLE backup_canary (id INTEGER PRIMARY KEY)`)
	mustDo(t, "create canary table", err)

	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	backupPath := filepath.Join(backupDir, "x'; DROP TABLE backup_canary; --.db")
	mustDo(t, "BackupToSafe", database.BackupToSafe(context.Background(), backupPath, backupDir))

	if _, err := os.Stat(backupPath); err != nil {
		t.Errorf("backup is not at the name it was given: %v", err)
	}
	var n int
	mustDo(t, "canary table is still there",
		database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM backup_canary`).Scan(&n))
}

// TestBackupToSafe_RejectsNullByte ensures a path containing a null byte is rejected.
func TestBackupToSafe_RejectsNullByte(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
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
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	existing := filepath.Join(backupDir, "keep_me.db")
	mustDo(t, "WriteFile", os.WriteFile(existing, []byte("precious"), 0o600))

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
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	good := filepath.Join(backupDir, "good.db")
	mustDo(t, "BackupToSafe", database.BackupToSafe(context.Background(), good, backupDir))
	mustDo(t, "CheckBackupIntegrity on a fresh backup", db.CheckBackupIntegrity(context.Background(), good))

	bad := filepath.Join(backupDir, "bad.db")
	mustDo(t, "WriteFile", os.WriteFile(bad, []byte("this is not a sqlite database at all"), 0o600))
	if err := db.CheckBackupIntegrity(context.Background(), bad); err == nil {
		t.Fatal("CheckBackupIntegrity accepted a garbage file")
	}

	if err := db.CheckBackupIntegrity(context.Background(), filepath.Join(backupDir, "missing.db")); err == nil {
		t.Fatal("CheckBackupIntegrity accepted a missing file")
	}
}

// TestBackupChecks_URIMetacharactersInPath: the restore CLI verifies a file
// the operator names, and SQLite reads its path as a URI. A '#', '?' or '%' in
// the name must still check that very file — not open (and create) a
// different one and report it "ok".
func TestBackupChecks_URIMetacharactersInPath(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	plain := filepath.Join(backupDir, "plain.db")
	mustDo(t, "BackupToSafe", database.BackupToSafe(context.Background(), plain, backupDir))
	wantAhead, err := db.CheckBackupSchemaAhead(context.Background(), plain)
	mustDo(t, "CheckBackupSchemaAhead on the plain name", err)
	data, err := os.ReadFile(plain)
	mustDo(t, "ReadFile", err)

	oddDir := filepath.Join(tmpDir, "odd")
	mustDo(t, "MkdirAll", os.MkdirAll(oddDir, 0o755))
	name := "chat#2%41"
	if runtime.GOOS != "windows" {
		name += "?x"
	}
	good := filepath.Join(oddDir, name+".db")
	bad := filepath.Join(oddDir, name+"-bad.db")
	mustDo(t, "WriteFile", os.WriteFile(good, data, 0o600))
	mustDo(t, "WriteFile", os.WriteFile(bad, []byte("this is not a sqlite database at all"), 0o600))

	if err := db.CheckBackupIntegrity(context.Background(), good); err != nil {
		t.Fatalf("CheckBackupIntegrity on %q: %v", good, err)
	}
	if err := db.CheckBackupIntegrity(context.Background(), bad); err == nil {
		t.Fatalf("CheckBackupIntegrity accepted the garbage file %q", bad)
	}
	gotAhead, err := db.CheckBackupSchemaAhead(context.Background(), good)
	if err != nil || !slices.Equal(gotAhead, wantAhead) {
		t.Fatalf("CheckBackupSchemaAhead on %q = %v, %v; want %v", good, gotAhead, err, wantAhead)
	}

	entries, err := os.ReadDir(oddDir)
	mustDo(t, "ReadDir", err)
	for _, e := range entries {
		if n := e.Name(); n != filepath.Base(good) && n != filepath.Base(bad) {
			t.Errorf("the checks created a stray file %q", n)
		}
	}
}

// TestBackupTo_RejectsPathOutsideDataBackups: the production entry point pins
// its safe root to data/backups, so a destination anywhere else is refused
// before a byte is written.
func TestBackupTo_RejectsPathOutsideDataBackups(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	outside := filepath.Join(tmpDir, "outside.db")
	if err := database.BackupTo(context.Background(), outside); err == nil {
		t.Fatal("BackupTo accepted a path outside data/backups")
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("a refused backup left a file behind (stat err=%v)", err)
	}
}

// TestBackupToSafe_MissingDirectoryFails: a destination directory that does
// not exist is an error, not a silently created tree.
func TestBackupToSafe_MissingDirectoryFails(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	missing := filepath.Join(backupDir, "not-there")
	if err := database.BackupToSafe(context.Background(), filepath.Join(missing, "b.db"), backupDir); err == nil {
		t.Fatal("BackupToSafe into a missing directory should fail")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("a failed backup created its directory (stat err=%v)", err)
	}
}

// TestBackupToSafe_ParentIsAFileFails: a destination whose parent is a regular
// file cannot be checked for existence, so it is refused and the file that is
// in the way is left alone.
func TestBackupToSafe_ParentIsAFileFails(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)

	backupDir := filepath.Join(tmpDir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o755))
	blocker := filepath.Join(backupDir, "blocker")
	mustDo(t, "WriteFile", os.WriteFile(blocker, []byte("not a directory"), 0o600))
	if err := database.BackupToSafe(context.Background(), filepath.Join(blocker, "b.db"), backupDir); err == nil {
		t.Fatal("BackupToSafe under a regular file should fail")
	}
	if got, err := os.ReadFile(blocker); err != nil || string(got) != "not a directory" {
		t.Fatalf("the file in the way was touched: %q, %v", got, err)
	}
}
