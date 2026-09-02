package alphasnap

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPathPointsAtTrackedSnapshot(t *testing.T) {
	p, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if filepath.Base(p) != Name {
		t.Fatalf("Path = %s, want a path ending in %s", p, Name)
	}
	if !filepath.IsAbs(p) {
		t.Fatalf("Path = %s, want absolute", p)
	}
}

// The drill protocol's guarantee: a copy is byte-identical, lands where the
// caller said, and the tracked file is untouched — no sidecar, same bytes.
func TestCopyIsByteIdenticalAndLeavesSourceAlone(t *testing.T) {
	src, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	before, err := os.Stat(src)
	if err != nil {
		t.Fatalf("stat source: %v", err)
	}

	dir := t.TempDir()
	got, err := Copy(dir)
	if err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if filepath.Dir(got) != dir {
		t.Fatalf("copy landed in %s, want %s", filepath.Dir(got), dir)
	}

	want, err := os.ReadFile(src) //nolint:gosec // G304: the tracked snapshot, resolved by Path
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	have, err := os.ReadFile(got) //nolint:gosec // G304: the copy this test just made
	if err != nil {
		t.Fatalf("read copy: %v", err)
	}
	if !bytes.Equal(want, have) {
		t.Fatalf("copy differs from source (%d vs %d bytes)", len(have), len(want))
	}

	after, err := os.Stat(src)
	if err != nil {
		t.Fatalf("stat source after copy: %v", err)
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("source changed under Copy: size %d→%d, mtime %v→%v",
			before.Size(), after.Size(), before.ModTime(), after.ModTime())
	}
	for _, sidecar := range []string{src + "-wal", src + "-shm", src + "-journal"} {
		if _, err := os.Stat(sidecar); err == nil {
			t.Fatalf("Copy left a SQLite sidecar beside the tracked snapshot: %s", sidecar)
		}
	}
}

func TestCopyMakesDistinctFiles(t *testing.T) {
	dir := t.TempDir()
	a, err := Copy(dir)
	if err != nil {
		t.Fatalf("first Copy: %v", err)
	}
	b, err := Copy(dir)
	if err != nil {
		t.Fatalf("second Copy: %v", err)
	}
	if a == b {
		t.Fatalf("two copies share a path: %s", a)
	}
}

func TestCopyRefusesMissingDir(t *testing.T) {
	if _, err := Copy(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Fatal("Copy into a missing directory succeeded, want an error")
	}
}
