package storage

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newCloneStorage(t *testing.T) (*Storage, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := New(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save("src", strings.NewReader("forwarded bytes")); err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func readStored(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

func TestClone_LinkAndCopyFallback(t *testing.T) {
	ctx := context.Background()

	t.Run("hard link shares the bytes and survives deleting the original", func(t *testing.T) {
		s, dir := newCloneStorage(t)
		if err := s.Clone(ctx, "src", "dst"); err != nil {
			t.Fatal(err)
		}
		srcInfo, _ := os.Stat(filepath.Join(dir, "src"))
		dstInfo, _ := os.Stat(filepath.Join(dir, "dst"))
		if !os.SameFile(srcInfo, dstInfo) {
			t.Error("the clone is not a hard link of the original")
		}
		if err := s.Delete("src"); err != nil {
			t.Fatal(err)
		}
		if got := readStored(t, dir, "dst"); got != "forwarded bytes" {
			t.Errorf("clone after the original was deleted = %q", got)
		}
	})

	t.Run("copy fallback when the link is refused", func(t *testing.T) {
		s, dir := newCloneStorage(t)
		old := linkFile
		linkFile = func(string, string) error { return &os.LinkError{Op: "link", Err: errors.New("cross-device")} }
		t.Cleanup(func() { linkFile = old })
		if err := s.Clone(ctx, "src", "dst"); err != nil {
			t.Fatal(err)
		}
		srcInfo, _ := os.Stat(filepath.Join(dir, "src"))
		dstInfo, _ := os.Stat(filepath.Join(dir, "dst"))
		if os.SameFile(srcInfo, dstInfo) {
			t.Error("the fallback produced a link, not a copy")
		}
		if got := readStored(t, dir, "dst"); got != "forwarded bytes" {
			t.Errorf("copied bytes = %q", got)
		}
	})

	t.Run("a cancelled context stops the copy and leaves no file", func(t *testing.T) {
		s, dir := newCloneStorage(t)
		old := linkFile
		linkFile = func(string, string) error { return errors.New("no links here") }
		t.Cleanup(func() { linkFile = old })
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		if err := s.Clone(cctx, "src", "dst"); !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "dst")); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("a cancelled clone left a file: %v", err)
		}
	})

	t.Run("a copy that fails midway removes the partial file", func(t *testing.T) {
		s, dir := newCloneStorage(t)
		old := linkFile
		linkFile = func(string, string) error { return errors.New("no links here") }
		t.Cleanup(func() { linkFile = old })
		// Make the source unreadable as a file: a directory opens but cannot be read.
		if err := os.Remove(filepath.Join(dir, "src")); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(dir, "src"), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := s.Clone(ctx, "src", "dst"); err == nil {
			t.Fatal("expected a read failure")
		}
		if _, err := os.Stat(filepath.Join(dir, "dst")); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("a failed copy left a partial file: %v", err)
		}
	})

	t.Run("a missing source is fs.ErrNotExist and an existing destination is never overwritten", func(t *testing.T) {
		s, dir := newCloneStorage(t)
		if err := s.Clone(ctx, "nope", "dst"); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("missing source: err = %v", err)
		}
		if _, err := s.Save("taken", strings.NewReader("keep me")); err != nil {
			t.Fatal(err)
		}
		if err := s.Clone(ctx, "src", "taken"); !errors.Is(err, ErrCloneExists) {
			t.Errorf("existing destination: err = %v", err)
		}
		if got := readStored(t, dir, "taken"); got != "keep me" {
			t.Errorf("destination was overwritten: %q", got)
		}
	})

	t.Run("names are validated like every other storage call", func(t *testing.T) {
		s, _ := newCloneStorage(t)
		for _, bad := range []string{"", "../escape", ".hidden", "a/b"} {
			if err := s.Clone(ctx, "src", bad); err == nil {
				t.Errorf("Clone to %q succeeded", bad)
			}
			if err := s.Clone(ctx, bad, "dst"); err == nil {
				t.Errorf("Clone from %q succeeded", bad)
			}
		}
	})
}
