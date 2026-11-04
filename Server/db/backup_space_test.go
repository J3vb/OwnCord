package db_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// A backup refuses before creating any file when free space is below the
// database plus its WAL plus the reserve, names the numbers, and goes ahead
// once the space is there. An unreadable volume is not treated as full.
func TestBackupToSafe_RefusesWhenShortOfSpace(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const reserve = 256 << 20
	var free uint64 = 10 << 20
	var freeErr error
	var askedDir string
	database.SetBackupFreeBytesForTest(reserve, func(dir string) (uint64, error) {
		askedDir = dir
		return free, freeErr
	})

	err := database.BackupToSafe(context.Background(), filepath.Join(backupDir, "short.db"), backupDir)
	if !errors.Is(err, db.ErrBackupNoSpace) {
		t.Fatalf("BackupToSafe = %v, want ErrBackupNoSpace", err)
	}
	for _, want := range []string{"needs about 2", "256 MB kept free", "10 MB is free"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
	if entries, _ := os.ReadDir(backupDir); len(entries) != 0 {
		t.Errorf("a refused backup left files: %v", entries)
	}
	if abs, _ := filepath.Abs(backupDir); askedDir != abs {
		t.Errorf("free space read for %q, want the backup dir %q", askedDir, abs)
	}

	free = reserve + 64<<20
	if err := database.BackupToSafe(context.Background(), filepath.Join(backupDir, "roomy.db"), backupDir); err != nil {
		t.Fatalf("BackupToSafe with room: %v", err)
	}

	free, freeErr = 0, fmt.Errorf("statfs: %w", errors.ErrUnsupported)
	if err := database.BackupToSafe(context.Background(), filepath.Join(backupDir, "unknown.db"), backupDir); err != nil {
		t.Fatalf("BackupToSafe with unreadable free space: %v", err)
	}
}

// The default (no reserve set) still refuses a copy that cannot fit, and an
// in-memory database is never checked.
func TestBackupToSafe_SpaceCheckDefaultsAndMemory(t *testing.T) {
	database, tmpDir := newBackupFileDB(t)
	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	database.SetBackupFreeBytesForTest(0, func(string) (uint64, error) { return 0, nil })
	if err := database.BackupToSafe(context.Background(), filepath.Join(backupDir, "a.db"), backupDir); !errors.Is(err, db.ErrBackupNoSpace) {
		t.Fatalf("BackupToSafe on a full volume = %v, want ErrBackupNoSpace", err)
	}

	mem, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer mem.Close() //nolint:errcheck
	mem.SetBackupFreeBytesForTest(1<<40, func(string) (uint64, error) { return 0, nil })
	if err := mem.BackupToSafe(context.Background(), filepath.Join(backupDir, "mem.db"), backupDir); err != nil {
		t.Fatalf("in-memory BackupToSafe: %v", err)
	}
}
