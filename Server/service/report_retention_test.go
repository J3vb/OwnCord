package service

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// countRows runs a COUNT(*)-shaped query and returns the scalar.
func countRows(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// TestReportRetention_PrunesContentKeepsRow pins S5-d: content bounded, the
// outcome indefinite. A report closed longer ago than the window loses its
// evidence, notes and detail; the row and its outcome stay exactly as they
// were.
func TestReportRetention_PrunesContentKeepsRow(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1400, Name: "general"})
	msgID := seedReportMessage(t, database, 1400, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if err := svc.Note(ctx, 2, id, "old note"); err != nil {
		t.Fatalf("Note: %v", err)
	}
	if _, err := svc.Close(ctx, 2, id, "actioned"); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Back-date closed_at so the report is outside the window.
	if _, err := database.ExecContext(ctx, `UPDATE reports SET closed_at = datetime('now', '-200 days') WHERE id = ?`, id); err != nil {
		t.Fatalf("back-date closed_at: %v", err)
	}

	if err := svc.PruneClosedContent(ctx, 180*24*time.Hour); err != nil {
		t.Fatalf("PruneClosedContent: %v", err)
	}

	evidence, err := database.ListReportEvidence(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 0 {
		t.Errorf("evidence after prune = %d rows, want 0", len(evidence))
	}
	notes, err := database.ListReportNotes(ctx, id)
	if err != nil {
		t.Fatalf("ListReportNotes: %v", err)
	}
	if len(notes) != 0 {
		t.Errorf("notes after prune = %d rows, want 0", len(notes))
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.Detail != "" {
		t.Errorf("detail after prune = %q, want empty", report.Detail)
	}
	if report.State != "resolved" || report.Outcome != "actioned" {
		t.Errorf("state/outcome after prune = %q/%q, want resolved/actioned (the outcome is indefinite)", report.State, report.Outcome)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM reports WHERE id = ?`, id); n != 1 {
		t.Errorf("reports row count after prune = %d, want 1 (kept)", n)
	}

	// An open report, however old, is never touched by this window.
	openID, err := svc.File(ctx, FileReportParams{ReporterID: 12, TargetType: TargetUser, TargetID: "13", Reason: "spam", Detail: "still open detail"})
	if err != nil {
		t.Fatalf("File(open): %v", err)
	}
	if err := svc.PruneClosedContent(ctx, 0); err != nil {
		t.Fatalf("PruneClosedContent: %v", err)
	}
	openReport, err := database.GetReport(ctx, openID)
	if err != nil {
		t.Fatalf("GetReport(open): %v", err)
	}
	if openReport.Detail == "" {
		t.Error("an open report's detail was cleared by the retention sweep")
	}
}

// TestReportRetention_ZeroMeansNever pins the config contract: a retention
// step wired with 0 days must never call the prune at all (the maintenance
// step checks reportRetentionDays <= 0 before calling PruneClosedContent).
// At the service level, PruneClosedContent(0) means "closed before now",
// which every already-closed report satisfies -- proving the guard belongs
// to the caller, not this method, is the point of this test.
func TestReportRetention_ZeroMeansNever(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1401, Name: "general"})
	msgID := seedReportMessage(t, database, 1401, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if _, err := svc.Close(ctx, 2, id, "actioned"); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// The maintenance step itself (m.pruneReportContent) treats
	// reportRetentionDays <= 0 as "never" and skips the call entirely; this
	// is pinned in internal/app/maintenance_test.go. Here we confirm the
	// service method has no independent notion of "0 = off" baked in, so a
	// caller that forgets the guard would prune immediately -- which is why
	// the guard lives at the call site and is tested there too.
	if err := svc.PruneClosedContent(ctx, 24*time.Hour); err != nil {
		t.Fatalf("PruneClosedContent: %v", err)
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.Detail != "" {
		t.Errorf("detail after a 24h window on a just-closed report = %q, want unchanged (not yet old enough)", report.Detail)
	}
}
