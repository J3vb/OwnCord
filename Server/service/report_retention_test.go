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
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam", Detail: "the reporter's written detail"})
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

	// A second report, closed only 10 days ago with the same real content:
	// the 180-day window must leave it completely alone (P2-11 threshold
	// coverage — the earlier version of this test never proved anything
	// short of the window was left untouched).
	recentMsgID := seedReportMessage(t, database, 1400, 11, "hi again")
	recentID, err := svc.File(ctx, FileReportParams{ReporterID: 12, TargetType: TargetMessage, TargetID: strconv.FormatInt(recentMsgID, 10), Reason: "spam", Detail: "recent detail"})
	if err != nil {
		t.Fatalf("File(recent): %v", err)
	}
	if err := svc.Note(ctx, 2, recentID, "recent note"); err != nil {
		t.Fatalf("Note(recent): %v", err)
	}
	if _, err := svc.Close(ctx, 2, recentID, "actioned"); err != nil {
		t.Fatalf("Close(recent): %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE reports SET closed_at = datetime('now', '-10 days') WHERE id = ?`, recentID); err != nil {
		t.Fatalf("back-date closed_at(recent): %v", err)
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

	recentEvidence, err := database.ListReportEvidence(ctx, recentID)
	if err != nil {
		t.Fatalf("ListReportEvidence(recent): %v", err)
	}
	if len(recentEvidence) == 0 {
		t.Error("recent report's evidence was pruned by a 180-day window at 10 days closed")
	}
	recentNotes, err := database.ListReportNotes(ctx, recentID)
	if err != nil {
		t.Fatalf("ListReportNotes(recent): %v", err)
	}
	if len(recentNotes) == 0 {
		t.Error("recent report's notes were pruned by a 180-day window at 10 days closed")
	}
	recentReport, err := database.GetReport(ctx, recentID)
	if err != nil {
		t.Fatalf("GetReport(recent): %v", err)
	}
	if recentReport.Detail == "" {
		t.Error("recent report's detail was pruned by a 180-day window at 10 days closed")
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

// The config-level contract (report_retention_days = 0 means the sweep is
// never invoked; = 180 prunes only content closed more than 180 days ago,
// driven through the real maintenance tick as B5-4's orphan-sweep test
// drives it) is P2-11's regression and is covered in
// internal/app/maintenance_test.go:
// TestMaintenance_ReportRetentionZeroDaysNeverPrunes and
// TestMaintenance_ReportRetentionPrunesOnlyAgedContent — this package has no
// maintenance-loop dependency to drive tick/loop with, so there is nothing
// left for a service-package test to add here.
