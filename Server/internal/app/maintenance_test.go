package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
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
		"report content retention failed",
		"moderation action retention failed",
		"erasure jobs still pending",
		"storage reconciliation failed",
		"storage recount failed",
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

// TestMaintenance_TickReturnsBytesTheOrphanSweepFreed is the sweep-level
// reconciliation proof (B5-2, decision 11): an attachment charged to its
// uploader, orphaned and past the grace period, is deleted by the orphan
// sweep and its bytes returned by the recount in the SAME tick — the recount
// runs last on purpose. A restart between the two (a fresh maintenance over
// the same database) repairs it just the same, from the loop's start-up
// recount.
func TestMaintenance_TickReturnsBytesTheOrphanSweepFreed(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	// Migration 001 schedules a daily backup, and a full tick would write one
	// under a path relative to this package. Off: this test is about the
	// storage steps.
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cfg := &config.Config{Upload: config.UploadConfig{StorageDir: dir, MaxSizeMB: 1}}
	svc := service.New(database, auth.NewRateLimiter())
	svc.Uploads.SetStorageLimits(service.StorageLimits{Dir: dir})

	// An upload as the handler does it: reserve, write, record.
	res, err := svc.Uploads.Reserve(ctx, 10, 6)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "orphan-1"), []byte("6bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.Uploads.Record(ctx, service.AttachmentRecord{ID: "orphan-1", UploaderID: 10, Filename: "o.bin", MimeType: "application/octet-stream", Size: 6}, res); err != nil {
		t.Fatal(err)
	}
	// Never attached, and older than the sweep's one-hour grace.
	old := time.Now().Add(-2 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := database.ExecContext(ctx, `UPDATE attachments SET uploaded_at = ? WHERE id = 'orphan-1'`, old); err != nil {
		t.Fatal(err)
	}
	if used, _ := svc.Uploads.StorageUsed(ctx, 10); used != 6 {
		t.Fatalf("counter before the tick = %d, want 6", used)
	}

	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}
	if _, err := os.Stat(filepath.Join(dir, "orphan-1")); !os.IsNotExist(err) {
		t.Fatalf("orphan file still on disk after the sweep: %v", err)
	}
	if used, _ := svc.Uploads.StorageUsed(ctx, 10); used != 0 {
		t.Fatalf("counter after the tick = %d, want 0: the recount must run after the orphan sweep", used)
	}

	// Restart shape: a charge with no row, a fresh process, the loop's
	// start-up recount.
	if _, err := svc.Uploads.Reserve(ctx, 10, 9); err != nil {
		t.Fatal(err)
	}
	fresh := service.New(database, auth.NewRateLimiter())
	if used, _ := fresh.Uploads.StorageUsed(ctx, 10); used != 9 {
		t.Fatalf("phantom charge before the restart recount = %d, want 9 (kept, high side)", used)
	}
	if err := newMaintenance(slog.Default(), cfg, database, fresh).recountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if used, _ := fresh.Uploads.StorageUsed(ctx, 10); used != 0 {
		t.Fatalf("phantom charge after the restart recount = %d, want 0", used)
	}
}

// seedAgedClosedReport inserts a closed report, one evidence row and one
// note, all with real content, closed daysAgo days ago. Returns the id.
func seedAgedClosedReport(t *testing.T, database *db.DB, ctx context.Context, id int64, daysAgo int) int64 {
	t.Helper()
	closedAt := time.Now().Add(-time.Duration(daysAgo) * 24 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail, state, outcome, created_at, updated_at, closed_at)
		 VALUES (?, ?, 10, 11, 'message', '1', 'spam', 'the reporter''s written detail', 'resolved', 'actioned', ?, ?, ?)`,
		id, fmt.Sprintf("pub-aged-%d", id), closedAt, closedAt, closedAt); err != nil {
		t.Fatalf("seed report %d: %v", id, err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_evidence (report_id, seq, author_id, content) VALUES (?, 0, 11, 'the reported message content')`, id); err != nil {
		t.Fatalf("seed evidence for report %d: %v", id, err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_notes (report_id, author_id, body) VALUES (?, 2, 'a moderator note')`, id); err != nil {
		t.Fatalf("seed note for report %d: %v", id, err)
	}
	return id
}

// TestMaintenance_ReportRetentionZeroDaysNeverPrunes is P2-11's zero-config
// regression test: a tick run with moderation.report_retention_days = 0 must
// leave a long-closed report's content untouched, because pruneReportContent
// checks the config value before ever calling PruneClosedContent.
func TestMaintenance_ReportRetentionZeroDaysNeverPrunes(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4), (11, 'bob', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	id := seedAgedClosedReport(t, database, ctx, 9001, 400)

	cfg := &config.Config{
		Upload:     config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1},
		Moderation: config.ModerationConfig{ReportRetentionDays: 0},
	}
	svc := service.New(database, auth.NewRateLimiter())
	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}

	var detail string
	if err := database.QueryRowContext(ctx, `SELECT detail FROM reports WHERE id = ?`, id).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if detail == "" {
		t.Error("detail was cleared with report_retention_days = 0, want untouched")
	}
	var evidenceRows, noteRows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_evidence WHERE report_id = ?`, id).Scan(&evidenceRows); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_notes WHERE report_id = ?`, id).Scan(&noteRows); err != nil {
		t.Fatal(err)
	}
	if evidenceRows != 1 || noteRows != 1 {
		t.Errorf("evidence/notes = %d/%d after a report_retention_days=0 tick, want 1/1 (untouched)", evidenceRows, noteRows)
	}
}

// TestMaintenance_ReportRetentionPrunesOnlyAgedContent is P2-11's
// threshold regression test, driven through the real maintenance tick (as
// B5-4's orphan-sweep test drives m.tick rather than calling the service
// method directly): with report_retention_days = 180, a report closed 200
// days ago loses its content but keeps its row and outcome, while a report
// closed only 10 days ago is left completely alone.
func TestMaintenance_ReportRetentionPrunesOnlyAgedContent(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4), (11, 'bob', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	oldID := seedAgedClosedReport(t, database, ctx, 9002, 200)
	recentID := seedAgedClosedReport(t, database, ctx, 9003, 10)

	cfg := &config.Config{
		Upload:     config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1},
		Moderation: config.ModerationConfig{ReportRetentionDays: 180},
	}
	svc := service.New(database, auth.NewRateLimiter())
	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}

	assertReportContent := func(id int64, wantDetail string, wantEvidence, wantNotes int) {
		t.Helper()
		var detail, state, outcome string
		if err := database.QueryRowContext(ctx, `SELECT detail, state, outcome FROM reports WHERE id = ?`, id).Scan(&detail, &state, &outcome); err != nil {
			t.Fatalf("report %d: %v", id, err)
		}
		if detail != wantDetail {
			t.Errorf("report %d detail = %q, want %q", id, detail, wantDetail)
		}
		if state != "resolved" || outcome != "actioned" {
			t.Errorf("report %d state/outcome = %q/%q, want resolved/actioned (kept)", id, state, outcome)
		}
		var evidenceRows, noteRows int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_evidence WHERE report_id = ?`, id).Scan(&evidenceRows); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_notes WHERE report_id = ?`, id).Scan(&noteRows); err != nil {
			t.Fatal(err)
		}
		if evidenceRows != wantEvidence || noteRows != wantNotes {
			t.Errorf("report %d evidence/notes = %d/%d, want %d/%d", id, evidenceRows, noteRows, wantEvidence, wantNotes)
		}
	}
	assertReportContent(oldID, "", 0, 0)
	assertReportContent(recentID, "the reporter's written detail", 1, 1)
}
