package app

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func countRestoreAudits(t *testing.T, database *db.DB, action string) int {
	t.Helper()
	rows, err := database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	n := 0
	for i := range rows {
		if rows[i].Action == action {
			n++
		}
	}
	return n
}

// TestInitDatabase_RecordsRestoreResult: a restore staged before the boot is
// applied by db.Open, reported once as an audit row and an attention entry,
// and its result file is consumed.
func TestInitDatabase_RecordsRestoreResult(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat.db")
	backup := filepath.Join(dir, "backups", "chatserver_x.db")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	first, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(first); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(backup), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := first.BackupToSafe(context.Background(), backup, filepath.Dir(backup)); err != nil {
		t.Fatal(err)
	}
	if err := db.StageRestore(context.Background(), path, backup, db.StagedRestoreMarker{Backup: "chatserver_x.db", ActorID: 0}); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := db.Open(path) // the next boot: applies the staged copy
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close() //nolint:errcheck
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}

	outcome := recordRestoreResult(log, path, database)
	if !outcome.Recorded || outcome.Status != db.RestoreStatusApplied || outcome.Backup != "chatserver_x.db" {
		t.Fatalf("outcome = %+v", outcome)
	}
	if n := countRestoreAudits(t, database, "backup_restore_applied"); n != 1 {
		t.Fatalf("backup_restore_applied audit rows = %d, want 1", n)
	}
	if again := recordRestoreResult(log, path, database); again.Recorded {
		t.Fatal("the result was reported twice")
	}
	if n := countRestoreAudits(t, database, "backup_restore_applied"); n != 1 {
		t.Fatalf("a second report added an audit row (%d)", n)
	}

	svc := service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{
		DiskFree: func() (uint64, error) { return 1 << 30, nil },
	})
	svc.RecordRestoreOutcome(outcome)
	svc.Evaluate(context.Background(), time.Now())
	found := false
	for _, s := range svc.Report().Signals {
		if s.ID == "last_restore" && s.Status == service.AttentionStatusOK && s.Value != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("the attention panel has no last_restore entry")
	}
}

func TestRecordRestoreResult_NoRestorePending(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close() //nolint:errcheck
	if out := recordRestoreResult(log, ":memory:", database); out.Recorded {
		t.Fatalf("outcome = %+v, want none", out)
	}
}
