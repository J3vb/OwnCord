package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// A marker file written before imports existed opens, its markers keep
// replaying as "imported messages spared", and a later sweep under a channel
// window records its own, separate cutoff.
func TestMarkerStore_OldFileGainsTheImportedCutoffColumn(t *testing.T) {
	ctx := context.Background()
	key := make([]byte, 32)
	path := filepath.Join(t.TempDir(), "markers.sqlite")
	m, err := OpenMarkerStore(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.RecordMessagesSweep(ctx, 5, "2026-01-01 00:00:00", 0, false); err != nil {
		t.Fatal(err)
	}
	_ = m.Close()

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`ALTER TABLE deletion_markers DROP COLUMN imported_cutoff`); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()

	m, err = OpenMarkerStore(path, key)
	if err != nil {
		t.Fatalf("reopen an old marker file: %v", err)
	}
	defer m.Close() //nolint:errcheck
	var seen [][2]any
	replay := func(_ context.Context, ch int64, cutoff string, imported bool) (int, error) {
		seen = append(seen, [2]any{cutoff, imported})
		return 0, nil
	}
	if _, err := m.ReplayMessages(ctx, replay); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0][1] != false {
		t.Fatalf("old marker replay = %v, want one pass sparing imported messages", seen)
	}

	// A channel-window sweep at an older cutoff, then a server sweep at a newer one.
	if err := m.RecordMessagesSweep(ctx, 5, "2025-06-01 00:00:00", 0, true); err != nil {
		t.Fatal(err)
	}
	if err := m.RecordMessagesSweep(ctx, 5, "2026-03-01 00:00:00", 0, false); err != nil {
		t.Fatal(err)
	}
	seen = nil
	if _, err := m.ReplayMessages(ctx, replay); err != nil {
		t.Fatal(err)
	}
	want := [][2]any{{"2026-03-01 00:00:00", false}, {"2025-06-01 00:00:00", true}}
	if len(seen) != 2 || seen[0] != want[0] || seen[1] != want[1] {
		t.Errorf("replay passes = %v, want %v", seen, want)
	}
}
