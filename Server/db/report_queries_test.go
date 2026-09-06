package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// These exercise the db package's own report wrappers directly (migration
// 048, B5-8) — the service-layer tests in Server/service/report_test.go
// drive the same calls through a real *db.DB, but per-package coverage only
// counts a package's own tests, so the wrappers need their own here too.

func TestReportQueries_InsertGetAndDedupe(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-reporter")
	subject := seedUser(t, database, "rq-subject")
	chID := seedChannel(t, database, "rq-channel")

	id, err := database.InsertReport(ctx, reporter, subject, "message", "42", &chID, "spam", "some detail")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	if id <= 0 {
		t.Fatalf("InsertReport id = %d, want positive", id)
	}

	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.ReporterID != reporter || report.SubjectID != subject || report.TargetType != "message" ||
		report.TargetRef != "42" || report.Reason != "spam" || report.Detail != "some detail" || report.State != "open" {
		t.Errorf("GetReport = %+v, unexpected", report)
	}
	if report.ChannelID == nil || *report.ChannelID != chID {
		t.Errorf("GetReport channel_id = %v, want %d", report.ChannelID, chID)
	}

	if _, err := database.GetReport(ctx, id+9999); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetReport(missing) = %v, want ErrNotFound", err)
	}

	dupeID, err := database.FindOpenOrAssignedReport(ctx, reporter, "message", "42")
	if err != nil {
		t.Fatalf("FindOpenOrAssignedReport: %v", err)
	}
	if dupeID != id {
		t.Errorf("FindOpenOrAssignedReport = %d, want %d", dupeID, id)
	}
	if none, err := database.FindOpenOrAssignedReport(ctx, reporter, "message", "no-such-ref"); err != nil || none != 0 {
		t.Errorf("FindOpenOrAssignedReport(no match) = %d, %v, want 0, nil", none, err)
	}
}

// TestReportQueries_GetReportCarriesTokens exercises the non-nil branch of
// the token mapping (strOrEmpty): after an erasure, GetReport's Report value
// must surface the marker token through the same wrapper Queue/Mine use.
func TestReportQueries_GetReportCarriesTokens(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-token-reporter")
	subject := seedUser(t, database, "rq-token-subject")

	id, err := database.InsertReport(ctx, reporter, subject, "user", "1", nil, "spam", "d")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	if _, err := database.EraseAccount(ctx, subject, "tok-subject-rq"); err != nil {
		t.Fatalf("EraseAccount(subject): %v", err)
	}
	if _, err := database.EraseAccount(ctx, reporter, "tok-reporter-rq"); err != nil {
		t.Fatalf("EraseAccount(reporter): %v", err)
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.SubjectToken != "tok-subject-rq" || report.ReporterToken != "tok-reporter-rq" {
		t.Errorf("GetReport tokens = subject=%q reporter=%q, want tok-subject-rq/tok-reporter-rq",
			report.SubjectToken, report.ReporterToken)
	}
	if report.SubjectID != 0 || report.ReporterID != 0 {
		t.Errorf("GetReport ids after erasure = subject=%d reporter=%d, want 0/0", report.SubjectID, report.ReporterID)
	}
}

func TestReportQueries_QueueFilters(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-queue-reporter")
	subject := seedUser(t, database, "rq-queue-subject")

	openID, err := database.InsertReport(ctx, reporter, subject, "user", "1", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport(open): %v", err)
	}
	assignedID, err := database.InsertReport(ctx, reporter, subject, "user", "2", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport(assigned): %v", err)
	}
	if ok, err := database.AssignReport(ctx, assignedID, reporter); err != nil || !ok {
		t.Fatalf("AssignReport = %v, %v, want true, nil", ok, err)
	}
	closedID, err := database.InsertReport(ctx, reporter, subject, "user", "3", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport(closed): %v", err)
	}
	if ok, err := database.CloseReport(ctx, closedID, "dismissed", "no_action"); err != nil || !ok {
		t.Fatalf("CloseReport = %v, %v, want true, nil", ok, err)
	}

	assertIDs := func(t *testing.T, rows []db.ReportQueueRow, want ...int64) {
		t.Helper()
		got := map[int64]bool{}
		for _, r := range rows {
			got[r.ID] = true
		}
		for _, w := range want {
			if !got[w] {
				t.Errorf("queue rows = %v, missing %d", rows, w)
			}
		}
	}

	openRows, err := database.ListReportsQueue(ctx, "open")
	if err != nil {
		t.Fatalf("ListReportsQueue(open): %v", err)
	}
	assertIDs(t, openRows, openID)
	for _, r := range openRows {
		if r.ID == assignedID || r.ID == closedID {
			t.Errorf("open filter leaked a non-open row: %+v", r)
		}
	}

	assignedRows, err := database.ListReportsQueue(ctx, "assigned")
	if err != nil {
		t.Fatalf("ListReportsQueue(assigned): %v", err)
	}
	assertIDs(t, assignedRows, assignedID)
	if len(assignedRows) > 0 && (assignedRows[0].ReporterName == "" || assignedRows[0].SubjectName == "") {
		t.Errorf("assigned row missing reporter/subject names: %+v", assignedRows[0])
	}

	closedRows, err := database.ListReportsQueue(ctx, "closed")
	if err != nil {
		t.Fatalf("ListReportsQueue(closed): %v", err)
	}
	assertIDs(t, closedRows, closedID)

	defaultRows, err := database.ListReportsQueue(ctx, "")
	if err != nil {
		t.Fatalf("ListReportsQueue(default): %v", err)
	}
	assertIDs(t, defaultRows, openID, assignedID)
	for _, r := range defaultRows {
		if r.ID == closedID {
			t.Error("default (open+assigned) view leaked a closed row")
		}
	}

	mine, err := database.ListReportsMine(ctx, reporter)
	if err != nil {
		t.Fatalf("ListReportsMine: %v", err)
	}
	if len(mine) != 3 {
		t.Fatalf("ListReportsMine = %d rows, want 3", len(mine))
	}
}

func TestReportQueries_AssignAndCloseAreGuarded(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-guard-reporter")
	subject := seedUser(t, database, "rq-guard-subject")
	mod := seedUser(t, database, "rq-guard-mod")

	id, err := database.InsertReport(ctx, reporter, subject, "user", "9", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	if ok, err := database.CloseReport(ctx, id, "dismissed", "no_action"); err != nil || !ok {
		t.Fatalf("CloseReport = %v, %v, want true, nil", ok, err)
	}
	// Guarded: a closed report accepts no further assign or close.
	if ok, err := database.AssignReport(ctx, id, mod); err != nil || ok {
		t.Errorf("AssignReport on a closed report = %v, %v, want false, nil", ok, err)
	}
	if ok, err := database.CloseReport(ctx, id, "resolved", "actioned"); err != nil || ok {
		t.Errorf("CloseReport on an already-closed report = %v, %v, want false, nil", ok, err)
	}
	// A nonexistent id is the same guarded zero-rows path.
	if ok, err := database.AssignReport(ctx, id+9999, mod); err != nil || ok {
		t.Errorf("AssignReport(missing) = %v, %v, want false, nil", ok, err)
	}
}

func TestReportQueries_EvidenceAndNotes(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-ev-reporter")
	subject := seedUser(t, database, "rq-ev-subject")
	author := seedUser(t, database, "rq-ev-author")

	id, err := database.InsertReport(ctx, reporter, subject, "message", "5", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	msgID := int64(5)
	if err := database.InsertReportEvidence(ctx, id, 0, &msgID, author, "the content", `[{"id":"a","filename":"f","mime":"m","size":1}]`); err != nil {
		t.Fatalf("InsertReportEvidence: %v", err)
	}
	if err := database.InsertReportEvidence(ctx, id, -1, nil, 0, "before", "[]"); err != nil {
		t.Fatalf("InsertReportEvidence(seq -1): %v", err)
	}

	evidence, err := database.ListReportEvidence(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 2 {
		t.Fatalf("ListReportEvidence = %d rows, want 2", len(evidence))
	}
	if evidence[0].Seq != -1 || evidence[1].Seq != 0 {
		t.Errorf("evidence order = %+v, want seq -1 then 0", evidence)
	}
	if evidence[1].Content != "the content" || evidence[1].AuthorID != author {
		t.Errorf("evidence[1] = %+v", evidence[1])
	}

	if err := database.InsertReportNote(ctx, id, author, "an internal note"); err != nil {
		t.Fatalf("InsertReportNote: %v", err)
	}
	notes, err := database.ListReportNotes(ctx, id)
	if err != nil {
		t.Fatalf("ListReportNotes: %v", err)
	}
	if len(notes) != 1 || notes[0].Body != "an internal note" || notes[0].AuthorID != author {
		t.Errorf("ListReportNotes = %+v", notes)
	}
}

// TestReportQueries_EvidenceAndNoteErrorsPropagate exercises the wrapper
// error branches on a foreign-key violation (a report_id with no reports
// row): both wrappers must return the underlying error, not swallow it.
func TestReportQueries_EvidenceAndNoteErrorsPropagate(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	const noSuchReport = int64(999999)

	if err := database.InsertReportEvidence(ctx, noSuchReport, 0, nil, 0, "x", "[]"); err == nil {
		t.Error("InsertReportEvidence with no such report_id: want an error")
	}
	if err := database.InsertReportNote(ctx, noSuchReport, 0, "x"); err == nil {
		t.Error("InsertReportNote with no such report_id: want an error")
	}
}

// TestReportQueries_ErrorsPropagateOnClosedDB exercises the wrapper error
// branches (not sql.ErrNoRows) that a live query cannot easily reach:
// every method wraps and returns whatever the connection reports, and a
// closed connection is the simplest way to make that a real error.
func TestReportQueries_ErrorsPropagateOnClosedDB(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-closed-reporter")
	subject := seedUser(t, database, "rq-closed-subject")
	id, err := database.InsertReport(ctx, reporter, subject, "user", "1", nil, "spam", "")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := database.InsertReport(ctx, reporter, subject, "user", "2", nil, "spam", ""); err == nil {
		t.Error("InsertReport on a closed db: want an error")
	}
	if _, err := database.GetReport(ctx, id); err == nil {
		t.Error("GetReport on a closed db: want an error")
	}
	if _, err := database.FindOpenOrAssignedReport(ctx, reporter, "user", "1"); err == nil {
		t.Error("FindOpenOrAssignedReport on a closed db: want an error")
	}
	if _, err := database.ListReportsQueue(ctx, "open"); err == nil {
		t.Error("ListReportsQueue on a closed db: want an error")
	}
	if _, err := database.ListReportsQueue(ctx, "closed"); err == nil {
		t.Error("ListReportsQueue(closed) on a closed db: want an error")
	}
	if _, err := database.ListReportsMine(ctx, reporter); err == nil {
		t.Error("ListReportsMine on a closed db: want an error")
	}
	if _, err := database.AssignReport(ctx, id, reporter); err == nil {
		t.Error("AssignReport on a closed db: want an error")
	}
	if _, err := database.CloseReport(ctx, id, "resolved", "actioned"); err == nil {
		t.Error("CloseReport on a closed db: want an error")
	}
	if _, err := database.ListReportEvidence(ctx, id); err == nil {
		t.Error("ListReportEvidence on a closed db: want an error")
	}
	if _, err := database.ListReportNotes(ctx, id); err == nil {
		t.Error("ListReportNotes on a closed db: want an error")
	}
	if _, err := database.PruneReportContentOlderThan(ctx, "2999-01-01 00:00:00"); err == nil {
		t.Error("PruneReportContentOlderThan on a closed db: want an error")
	}
}

func TestReportQueries_PruneContentOlderThan(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-prune-reporter")
	subject := seedUser(t, database, "rq-prune-subject")

	id, err := database.InsertReport(ctx, reporter, subject, "user", "1", nil, "spam", "kept until pruned")
	if err != nil {
		t.Fatalf("InsertReport: %v", err)
	}
	if err := database.InsertReportEvidence(ctx, id, 0, nil, 0, "content", "[]"); err != nil {
		t.Fatalf("InsertReportEvidence: %v", err)
	}
	if err := database.InsertReportNote(ctx, id, reporter, "a note"); err != nil {
		t.Fatalf("InsertReportNote: %v", err)
	}
	if ok, err := database.CloseReport(ctx, id, "dismissed", "no_action"); err != nil || !ok {
		t.Fatalf("CloseReport: %v, %v", ok, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE reports SET closed_at = datetime('now', '-200 days') WHERE id = ?`, id); err != nil {
		t.Fatalf("back-date closed_at: %v", err)
	}

	// A future cutoff (well past now) prunes; nothing to assert on the
	// return value beyond "no error" since it reports rows whose DETAIL
	// changed, and an already-empty detail elsewhere would not move it.
	cutoff := "2999-01-01 00:00:00"
	if _, err := database.PruneReportContentOlderThan(ctx, cutoff); err != nil {
		t.Fatalf("PruneReportContentOlderThan: %v", err)
	}

	evidence, err := database.ListReportEvidence(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 0 {
		t.Errorf("evidence after prune = %d, want 0", len(evidence))
	}
	notes, err := database.ListReportNotes(ctx, id)
	if err != nil {
		t.Fatalf("ListReportNotes: %v", err)
	}
	if len(notes) != 0 {
		t.Errorf("notes after prune = %d, want 0", len(notes))
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.Detail != "" {
		t.Errorf("detail after prune = %q, want empty", report.Detail)
	}

	// An open report is never pruned by this window, regardless of cutoff.
	openID, err := database.InsertReport(ctx, reporter, subject, "user", "2", nil, "spam", "still open")
	if err != nil {
		t.Fatalf("InsertReport(open): %v", err)
	}
	if _, err := database.PruneReportContentOlderThan(ctx, cutoff); err != nil {
		t.Fatalf("PruneReportContentOlderThan: %v", err)
	}
	openReport, err := database.GetReport(ctx, openID)
	if err != nil {
		t.Fatalf("GetReport(open): %v", err)
	}
	if openReport.Detail != "still open" {
		t.Errorf("open report detail after prune = %q, want unchanged", openReport.Detail)
	}
}
