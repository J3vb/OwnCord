package app

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// newMaintenanceTestDB opens an in-memory database with the full migration
// set applied, the shape every direct maintenance test needs.
func newMaintenanceTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// TestMaintenance_StepOrderIsPinned is the seam contract: the pass runs these
// sweeps in this order, and the reconciliation passes come after the sweeps
// that strand what they reconcile. A step added out of place — a new sweep
// after the storage reconciliation, say — fails here by name, which is the
// point: B5-4 and B5-11 add a row to steps() and to this list together.
func TestMaintenance_StepOrderIsPinned(t *testing.T) {
	m := newMaintenance(slog.Default(), &config.Config{Upload: config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1}}, newMaintenanceTestDB(t), nil)
	got := make([]string, 0, len(m.steps()))
	for _, step := range m.steps() {
		got = append(got, step.name)
	}
	want := []string{
		"failed to delete expired sessions",
		"failed to clean up expired second-factor state",
		"backup maintenance failed",
		"failed to delete orphaned attachments",
		"retention sweep failed",
		"erasure jobs still pending",
		"storage reconciliation failed",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("maintenance steps =\n  %q\nwant\n  %q", got, want)
	}
}

// TestMaintenance_TickWithNoServicesSucceeds pins that a partial wiring (no
// services at all) is a no-op pass, not a failed one: every service-backed
// step skips itself, so the circuit breaker never trips on a wiring gap.
func TestMaintenance_TickWithNoServicesSucceeds(t *testing.T) {
	m := newMaintenance(slog.Default(), &config.Config{Upload: config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1}}, newMaintenanceTestDB(t), nil)
	if failed := m.tick(context.Background()); failed {
		t.Fatal("tick reported failure with every service-backed step skipped")
	}
}
