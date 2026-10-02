//go:build windows

package app

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// lockLikeARunningImage opens path the way the loader holds a running
// executable: without FILE_SHARE_DELETE, so it cannot be removed.
func lockLikeARunningImage(t *testing.T, path string) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(h) })
}

// A predecessor staying behind on its console keeps its .old-* locked for as
// long as the replacement runs: start-up removes the others and leaves that
// one without waiting for it.
func TestRemoveOldBinary_LeavesALockedOneWithoutWaiting(t *testing.T) {
	exePath := filepath.Join(t.TempDir(), "chatserver.exe")
	for _, p := range []string{exePath + ".old", exePath + ".old-1", exePath + ".old-2"} {
		if err := os.WriteFile(p, []byte("previous version"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	lockLikeARunningImage(t, exePath+".old-2")

	started := time.Now()
	removeOldBinaryAt(exePath, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if took := time.Since(started); took > 2*time.Second {
		t.Errorf("cleanup took %s; a locked binary must be left, not waited on", took)
	}
	for _, p := range []string{exePath + ".old", exePath + ".old-1"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("unlocked %s still present after cleanup: %v", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(exePath + ".old-2"); err != nil {
		t.Errorf("locked .old-2 = %v, want it left in place", err)
	}
}
