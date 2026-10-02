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
	if err := os.WriteFile(exePath, []byte("new version"), 0o600); err != nil {
		t.Fatal(err)
	}
	olds := []string{exePath + ".old", exePath + ".old-1", exePath + ".old-2"}
	for _, p := range olds {
		if err := os.WriteFile(p, []byte("previous version"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	unrelated := exePath + ".new"
	if err := os.WriteFile(unrelated, []byte("staged"), 0o600); err != nil {
		t.Fatal(err)
	}
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
