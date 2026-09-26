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
	if err := os.WriteFile(exePath+".old", []byte("previous version"), 0o600); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	removeOldBinaryAt(exePath, log)
	if _, err := os.Stat(exePath + ".old"); !os.IsNotExist(err) {
		t.Fatalf("old binary still present after cleanup: %v", err)
	}
	// Subsequent ordinary starts with no backup are harmless.
	removeOldBinaryAt(exePath, log)
	if contents, err := os.ReadFile(exePath); err != nil || string(contents) != "new version" {
		t.Fatalf("replacement after cleanup = %q, %v; want new version", contents, err)
	}
}
