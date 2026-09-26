package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestList_RegularFilesWithModTime(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, 1)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	old := time.Now().Add(-3 * time.Hour)
	for _, name := range []string{"b-file", "a-file"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if name == "a-file" {
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}

	entries, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 2 || entries[0].Name != "a-file" || entries[1].Name != "b-file" {
		t.Fatalf("List = %+v, want a-file, b-file (no directory)", entries)
	}
	if !entries[0].ModTime.Before(time.Now().Add(-2*time.Hour)) || entries[1].ModTime.Before(time.Now().Add(-time.Minute)) {
		t.Errorf("mod times not reported: %+v", entries)
	}

	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := s.List(); err == nil {
		t.Error("List on a missing directory succeeded")
	}
}
