package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// generateSnapshot runs the full alpha pipeline — migrate, seed, scrub,
// VACUUM INTO — exactly as `-profile alpha -snapshot … -scrub …` does, and
// returns the snapshot's bytes.
func generateSnapshot(t *testing.T, name string) []byte {
	t.Helper()
	dir := t.TempDir()
	database, err := db.Open(filepath.Join(dir, name+".db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer func() { _ = database.Close() }()
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	if err := seedAlpha(database); err != nil {
		t.Fatalf("seedAlpha: %v", err)
	}
	out := filepath.Join(dir, name+".sqlite")
	if err := writeSnapshot(database, filepath.Join("..", "..", "testdata", "snapshots", "scrub.sql"), out); err != nil {
		t.Fatalf("writeSnapshot: %v", err)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("reading snapshot: %v", err)
	}
	return raw
}

// TestAlphaProfileByteIdentical is the B3-7 exit condition: the profile is a
// pure function — two runs, two files, identical bytes. Anything wall-clock,
// salted, map-ordered or pool-raced in the pipeline fails this test.
func TestAlphaProfileByteIdentical(t *testing.T) {
	first := generateSnapshot(t, "first")
	second := generateSnapshot(t, "second")
	if !bytes.Equal(first, second) {
		i := 0
		for i < len(first) && i < len(second) && first[i] == second[i] {
			i++
		}
		t.Fatalf("two alpha seed runs differ (len %d vs %d, first divergence at byte %d) — the profile has a nondeterminism leak", len(first), len(second), i)
	}
}

// TestAlphaProfileRefusesNonEmptyDatabase pins the guard: determinism is
// per-database-lifetime, so the profile only ever seeds an empty file.
func TestAlphaProfileRefusesNonEmptyDatabase(t *testing.T) {
	database, err := db.Open(filepath.Join(t.TempDir(), "occupied.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer func() { _ = database.Close() }()
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	if err := seedAlpha(database); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	if err := seedAlpha(database); err == nil {
		t.Fatal("second seed on a populated database succeeded; want a refusal")
	}
}
