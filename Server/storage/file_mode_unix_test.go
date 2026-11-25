//go:build unix

package storage

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// A stored upload and a new storage folder are owner-only.
func TestSave_NewFilesAndFolderAreOwnerOnly(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "uploads")
	s, err := New(dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	const name = "0f8fad5b-d9cb-469f-a165-70867728950e"
	if _, err := s.Save(name, bytes.NewReader(png)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for p, want := range map[string]os.FileMode{dir: 0o700, filepath.Join(dir, name): 0o600} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", p, got, want)
		}
	}
}
