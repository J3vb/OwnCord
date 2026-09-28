package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// restoreCLIFixture builds a config.yaml and a live database path under a temp
// dir, and returns both plus the backup dir the config points at.
func restoreCLIFixture(t *testing.T) (cfgPath, dbPath, backupDir string) {
	t.Helper()
	dir := t.TempDir()
	dbPath = filepath.Join(dir, "data", "chatserver.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o750); err != nil {
		t.Fatal(err)
	}
	live, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open live: %v", err)
	}
	if err := db.Migrate(live); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := live.CreateUser(context.Background(), "existing-owner", "hash", 1); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := live.Close(); err != nil {
		t.Fatalf("Close live: %v", err)
	}

	backupDir = filepath.Join(dir, "backups")
	cfgPath = filepath.Join(dir, "config.yaml")
	body := "database:\n  path: " + filepath.ToSlash(dbPath) + "\nbackup:\n  dir: " + filepath.ToSlash(backupDir) + "\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgPath, dbPath, backupDir
}

// makeBackup writes a valid backup of the given database file to a fresh path
// and returns it. It opens a source database, seeds it, and VACUUMs to path.
func makeBackup(t *testing.T, dir, name string, seedUser string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	srcPath := filepath.Join(dir, "src-"+name)
	src, err := db.Open(srcPath)
	if err != nil {
		t.Fatalf("Open src: %v", err)
	}
	if err := db.Migrate(src); err != nil {
		t.Fatalf("Migrate src: %v", err)
	}
	if seedUser != "" {
		if _, err := src.CreateUser(context.Background(), seedUser, "hash", 1); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
	}
	out := filepath.Join(dir, name)
	if err := src.BackupToSafe(context.Background(), out, dir); err != nil {
		t.Fatalf("BackupToSafe: %v", err)
	}
	if err := src.Close(); err != nil {
		t.Fatalf("Close src: %v", err)
	}
	return out
}

func userExists(t *testing.T, dbPath, username string) bool {
	t.Helper()
	database, err := db.OpenShared(dbPath)
	if err != nil {
		t.Fatalf("OpenShared: %v", err)
	}
	defer database.Close() //nolint:errcheck
	u, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || u == nil {
		return false
	}
	return u.Username == username
}

// TestRestoreCLI_RefusesToOverwriteWithoutForce is the safety contract behind
// B11-7: a bare `chatserver restore <file>` against a server that will not
// boot must not silently replace the live database. It refuses and changes
// nothing, so an operator reads what to do rather than discovering the loss.
func TestRestoreCLI_RefusesToOverwriteWithoutForce(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")

	if code := runRestoreCLI(cfgPath, []string{backup}); code == 0 {
		t.Fatal("restore without --force exited 0, want a refusal")
	}
	// The refusal must not have touched the live database.
	if !userExists(t, dbPath, "existing-owner") || userExists(t, dbPath, "restored-user") {
		t.Fatal("the live database changed despite the refusal")
	}
}

// TestRestoreCLI_ForceRestoresAndBacksUp is the success path: --force replaces
// the live database with the backup and leaves a pre-restore safety copy
// behind, so the overwrite is reversible.
func TestRestoreCLI_ForceRestoresAndBacksUp(t *testing.T) {
	cfgPath, dbPath, backupDir := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")

	if code := runRestoreCLI(cfgPath, []string{"--force", backup}); code != 0 {
		t.Fatalf("restore --force exited %d, want 0", code)
	}
	if !userExists(t, dbPath, "restored-user") {
		t.Fatal("the backup was not restored into the live database")
	}
	if userExists(t, dbPath, "existing-owner") {
		t.Fatal("the pre-restore database is still there; the copy did not replace it")
	}

	// A pre-restore safety copy holds the state that existed before the
	// overwrite, so the operator can go back.
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("reading backup dir: %v", err)
	}
	found := false
	for _, e := range entries {
		if len(e.Name()) >= len("pre_restore_") && e.Name()[:len("pre_restore_")] == "pre_restore_" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no pre_restore_* safety copy in %s; got %v", backupDir, entries)
	}
}

// TestRestoreCLI_RejectsUnreadableFile: a file SQLite cannot open must be
// refused before anything is replaced, not copied over the live database.
func TestRestoreCLI_RejectsUnreadableFile(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	junk := filepath.Join(t.TempDir(), "junk.db")
	if err := os.WriteFile(junk, []byte("this is not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := runRestoreCLI(cfgPath, []string{"--force", junk}); code == 0 {
		t.Fatal("restore of an unreadable file exited 0, want a refusal")
	}
	if !userExists(t, dbPath, "existing-owner") {
		t.Fatal("the live database was replaced by an unreadable file")
	}
}

// TestRestoreCLI_RefusesWhileServerRunning: the single-process lock means the
// server holds this database. The CLI takes the same lock, so it refuses
// rather than corrupting a running server's files out from under it.
func TestRestoreCLI_RefusesWhileServerRunning(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")

	// Hold the process lock the way a running server does.
	holder, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open holder: %v", err)
	}
	defer holder.Close() //nolint:errcheck

	if code := runRestoreCLI(cfgPath, []string{"--force", backup}); code == 0 {
		t.Fatal("restore ran while another process held the database lock, want a refusal")
	}
}

// TestRestoreCLIUsageMentionsRestore pins that the top-level help lists the
// new subcommand, so an operator finds it.
func TestRestoreCLIUsageMentionsRestore(t *testing.T) {
	if out, _ := infoOutput([]string{"--help"}); !strings.Contains(out, "chatserver restore") {
		t.Errorf("--help does not mention `chatserver restore`:\n%s", out)
	}
}

// TestRestoreCLI_DropsStaleWAL: a dead server can leave a -wal beside a live
// database the operator has already moved aside. SQLite would replay those
// frames onto the restored file on the next boot, so the restore must not
// leave them there.
func TestRestoreCLI_DropsStaleWAL(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")

	live, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open live: %v", err)
	}
	if _, err := live.CreateUser(context.Background(), "wal-only-user", "hash", 1); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	wal, err := os.ReadFile(dbPath + "-wal")
	if err != nil || len(wal) == 0 {
		t.Fatalf("expected a non-empty -wal beside the live database: %d bytes, %v", len(wal), err)
	}
	if err := live.Close(); err != nil {
		t.Fatalf("Close live: %v", err)
	}
	if err := os.Remove(dbPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbPath+"-wal", wal, 0o600); err != nil {
		t.Fatal(err)
	}

	if code := runRestoreCLI(cfgPath, []string{"--force", backup}); code != 0 {
		t.Fatalf("restore --force exited %d, want 0", code)
	}
	if err := db.CheckBackupIntegrity(context.Background(), dbPath); err != nil {
		t.Fatalf("the restored database is not intact: %v", err)
	}
	if !userExists(t, dbPath, "restored-user") || userExists(t, dbPath, "wal-only-user") {
		t.Fatal("the stale WAL was replayed onto the restored database")
	}
}

// TestRestoreCLI_RefusesNewerSchema (REL-02): a backup a newer server wrote
// would leave this binary unable to boot, so it is refused like the admin path.
func TestRestoreCLI_RefusesNewerSchema(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")
	future, err := db.OpenShared(backup)
	if err != nil {
		t.Fatalf("OpenShared backup: %v", err)
	}
	if _, err := future.SQLDb().ExecContext(context.Background(),
		"INSERT INTO schema_versions (version) VALUES ('999_from_the_future.sql')"); err != nil {
		t.Fatalf("recording a future migration: %v", err)
	}
	if err := future.Close(); err != nil {
		t.Fatal(err)
	}

	if code := runRestoreCLI(cfgPath, []string{"--force", backup}); code == 0 {
		t.Fatal("restore of a newer-schema backup exited 0, want a refusal")
	}
	if !userExists(t, dbPath, "existing-owner") || userExists(t, dbPath, "restored-user") {
		t.Fatal("the live database changed despite the refusal")
	}
}

// TestRestoreCLI_RefusesWithoutSafetyCopy: a readable live database is only
// overwritten once its safety copy exists. A backup dir BackupToSafe rejects
// must refuse, not continue without the copy.
func TestRestoreCLI_RefusesWithoutSafetyCopy(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)
	backup := makeBackup(t, t.TempDir(), "backup.db", "restored-user")
	badDir := filepath.Join(filepath.Dir(cfgPath), "back+ups")
	body := "database:\n  path: " + filepath.ToSlash(dbPath) + "\nbackup:\n  dir: " + filepath.ToSlash(badDir) + "\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	if code := runRestoreCLI(cfgPath, []string{"--force", backup}); code == 0 {
		t.Fatal("restore without a safety copy exited 0, want a refusal")
	}
	if !userExists(t, dbPath, "existing-owner") || userExists(t, dbPath, "restored-user") {
		t.Fatal("the live database was overwritten with no safety copy taken")
	}
}

// TestRestoreCLI_RefusesLiveDatabaseAsSource: copying the live file over
// itself would truncate it to zero bytes.
func TestRestoreCLI_RefusesLiveDatabaseAsSource(t *testing.T) {
	cfgPath, dbPath, _ := restoreCLIFixture(t)

	if code := runRestoreCLI(cfgPath, []string{"--force", dbPath}); code == 0 {
		t.Fatal("restore of the live database onto itself exited 0, want a refusal")
	}
	if !userExists(t, dbPath, "existing-owner") {
		t.Fatal("the live database was truncated")
	}
}
