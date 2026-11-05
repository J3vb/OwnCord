package app

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveOldBinary_PreservesReplacement(t *testing.T) {
	exePath := filepath.Join(t.TempDir(), "chatserver")
	mustDo(t, "WriteFile", os.WriteFile(exePath, []byte("new version"), 0o600))
	olds := []string{exePath + ".old", exePath + ".old-1", exePath + ".old-2"}
	for _, p := range olds {
		mustDo(t, "WriteFile", os.WriteFile(p, []byte("previous version"), 0o600))
	}
	unrelated := exePath + ".new"
	mustDo(t, "WriteFile", os.WriteFile(unrelated, []byte("staged"), 0o600))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	removeOldBinaryAt(exePath, log)
	for _, p := range olds {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("old binary %s still present after cleanup: %v", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Errorf("cleanup removed %s, which is not an old binary: %v", filepath.Base(unrelated), err)
	}
	// Subsequent ordinary starts with no backup are harmless.
	removeOldBinaryAt(exePath, log)
	if contents, err := os.ReadFile(exePath); err != nil || string(contents) != "new version" {
		t.Fatalf("replacement after cleanup = %q, %v; want new version", contents, err)
	}
}

// A crash between creating and removing the updater's writability probe
// leaves chatserver.old-probe-*; the ".old-" prefix lets the boot cleanup
// remove it like any other previous binary.
func TestRemoveOldBinary_RemovesLeftoverProbe(t *testing.T) {
	exePath := filepath.Join(t.TempDir(), "chatserver")
	mustDo(t, "WriteFile", os.WriteFile(exePath, []byte("current"), 0o600))
	probe := exePath + ".old-probe-123456"
	mustDo(t, "WriteFile", os.WriteFile(probe, nil, 0o600))

	removeOldBinaryAt(exePath, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if _, err := os.Stat(probe); !os.IsNotExist(err) {
		t.Errorf("leftover probe still present after cleanup: %v", err)
	}
	if _, err := os.Stat(exePath); err != nil {
		t.Errorf("cleanup removed the current binary: %v", err)
	}
}
