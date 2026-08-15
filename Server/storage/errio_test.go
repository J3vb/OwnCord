package storage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSave_FilesystemFailureIsErrIO locks the error classification handlers
// depend on for status codes: a server-side filesystem failure carries ErrIO,
// while content rejections (blocked type, size) do not.
func TestSave_FilesystemFailureIsErrIO(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "store")
	s, err := New(dir, 1)
	if err != nil {
		t.Fatal(err)
	}

	// Remove the storage dir so os.Create fails — the same class of failure
	// as a read-only mount or a full disk.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	_, saveErr := s.Save("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", strings.NewReader("hello"))
	if saveErr == nil {
		t.Fatal("Save into a missing dir should fail")
	}
	if !errors.Is(saveErr, ErrIO) {
		t.Fatalf("filesystem failure not marked ErrIO: %v", saveErr)
	}

	// Content rejections stay non-ErrIO (the client's fault → 400).
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	_, blockedErr := s.Save("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef", strings.NewReader("MZ executable bytes"))
	if blockedErr == nil {
		t.Fatal("blocked file type should fail")
	}
	if errors.Is(blockedErr, ErrIO) {
		t.Fatalf("content rejection wrongly marked ErrIO: %v", blockedErr)
	}
}
