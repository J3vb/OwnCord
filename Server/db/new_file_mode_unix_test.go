//go:build unix

package db_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// A database the server creates is owner-only, and so are the WAL and SHM
// files SQLite makes beside it.
func TestOpen_NewDatabaseFilesAreOwnerOnly(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "chatserver.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if _, err := d.ExecContext(context.Background(), `CREATE TABLE IF NOT EXISTS mode_probe (x INTEGER)`); err != nil {
		t.Fatalf("write: %v", err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("%s mode = %o, want 600", filepath.Base(p), got)
		}
	}
}

// An existing database keeps the mode its owner gave it, so a setup where
// another account reads it today keeps working.
func TestOpen_ExistingDatabaseKeepsItsMode(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "chatserver.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	_ = d.Close()
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	d, err = db.Open(path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Errorf("existing database mode = %o, want 640 kept", got)
	}
}
