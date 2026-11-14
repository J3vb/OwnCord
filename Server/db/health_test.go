package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHealthStats_FileBackedDatabase(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "health.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close() //nolint:errcheck
	if err := Migrate(d); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	got, err := d.HealthStats(context.Background())
	if err != nil {
		t.Fatalf("HealthStats: %v", err)
	}
	if got.FileBytes <= 0 {
		t.Errorf("FileBytes = %d, want > 0", got.FileBytes)
	}
	if !strings.HasSuffix(got.SchemaVersion, ".sql") {
		t.Errorf("SchemaVersion = %q, want the newest migration file name", got.SchemaVersion)
	}
	if got.ReadersMax <= 0 {
		t.Errorf("ReadersMax = %d, want the reader pool bound", got.ReadersMax)
	}
}

// An expired deadline fails the read instead of waiting on the database.
func TestHealthStats_HonoursDeadline(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "health.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close() //nolint:errcheck
	if err := Migrate(d); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(time.Millisecond)
	if _, err := d.HealthStats(ctx); err == nil {
		t.Error("HealthStats with an expired deadline returned no error")
	}
}
