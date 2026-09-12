package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestTarRoundTrip pins the only logic in the container leg that needs no
// Docker daemon, and it is the logic a silent data loss would hide in: the
// pair of functions that carry the data directory in and out of a container.
// archive() and restore() are the rollback, so an entry this pair drops is a
// file the rehearsal claims to have restored and did not — and every phase
// would still pass, because a file that is in neither capture is in neither
// comparison.
func TestTarRoundTrip(t *testing.T) {
	src := t.TempDir()
	files := map[string]string{
		"chatserver.db":               "database bytes",
		"totp.key":                    "a credential",
		filepath.Join("uploads", "a"): "an attachment",
		filepath.Join("backups", "chatserver_20260912_101500.db"): "a backup",
	}
	for name, content := range files {
		path := filepath.Join(src, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// An empty directory the server made and nothing has written to yet:
	// dropped by a walk that only emits files, and restored as a missing
	// directory the next boot may or may not recreate.
	if err := os.MkdirAll(filepath.Join(src, "livekit"), 0o700); err != nil {
		t.Fatal(err)
	}

	// The prefix is what makes the stream land at /app/data rather than at
	// /app: docker cp extracts relative to the destination, so a stream
	// written without it would scatter the data directory across /app.
	var stream bytes.Buffer
	if err := writeTar(&stream, src, "data"); err != nil {
		t.Fatalf("writeTar: %v", err)
	}
	dst := t.TempDir()
	if err := extractTar(&stream, dst); err != nil {
		t.Fatalf("extractTar: %v", err)
	}

	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(dst, "data", name))
		if err != nil {
			t.Errorf("data/%s did not survive the round trip: %v", name, err)
			continue
		}
		if string(got) != want {
			t.Errorf("data/%s is %q after the round trip, want %q", name, got, want)
		}
	}
	if info, err := os.Stat(filepath.Join(dst, "data", "livekit")); err != nil || !info.IsDir() {
		t.Errorf("the empty data/livekit directory did not survive the round trip: %v", err)
	}
}

// TestExtractTarRefusesEscape covers the guard rather than the happy path: the
// stream comes from the local daemon, so an escaping entry would be a bug, and
// a bug that writes outside the snapshot directory is the kind that is found
// somewhere else entirely.
func TestExtractTarRefusesEscape(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "escape"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stream bytes.Buffer
	if err := writeTar(&stream, src, "../.."); err != nil {
		t.Fatalf("writeTar: %v", err)
	}
	err := extractTar(&stream, t.TempDir())
	if err == nil {
		t.Fatal("extractTar accepted an entry that walks out of its destination")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("refusing tar entry")) {
		t.Fatalf("extractTar failed with %q, want the refusal", err)
	}
}
