//go:build linux || darwin || windows

package db

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// TestTryLockFile_Exclusive locks the single-process guard's contract: the
// second acquisition fails with errAlreadyLocked while the first holds the
// lock, and succeeds after release.
//
// Note this exercises the raw tryLockFile, not acquireProcessLock — the
// latter's 30s restart-handoff retry would stall the contended case.
func TestTryLockFile_Exclusive(t *testing.T) {
	path := lockFilePath(filepath.Join(t.TempDir(), "test.db"))

	release1, err := tryLockFile(path)
	if err != nil {
		t.Fatalf("first tryLockFile: %v", err)
	}

	if _, err := tryLockFile(path); !errors.Is(err, errAlreadyLocked) {
		t.Fatalf("second tryLockFile err = %v, want errAlreadyLocked", err)
	}

	release1()

	release2, err := tryLockFile(path)
	if err != nil {
		t.Fatalf("tryLockFile after release: %v", err)
	}
	release2()
}

// TestAcquireProcessLock_OnlyBlamesAHolderWhenLocked: a lock that cannot be
// taken for another reason (here, a missing data dir) must not send the
// operator looking for a running server.
func TestAcquireProcessLock_OnlyBlamesAHolderWhenLocked(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	release, err := AcquireProcessLock(dbPath)
	if err != nil {
		t.Fatalf("AcquireProcessLock: %v", err)
	}
	if _, err := AcquireProcessLock(dbPath); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("held lock err = %v, want an in-use error", err)
	}
	release()

	_, err = AcquireProcessLock(filepath.Join(t.TempDir(), "missing", "test.db"))
	if err == nil || strings.Contains(err.Error(), "in use") {
		t.Fatalf("missing dir err = %v, want a non-in-use error", err)
	}
}
