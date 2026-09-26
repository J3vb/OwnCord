package db_test

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// These exercise the db package's own report wrappers directly (migration
// 048, B5-8) — the service-layer tests in Server/service/report_test.go
// drive the same calls through a real *db.DB, but per-package coverage only
// counts a package's own tests, so the wrappers need their own here too.

var testPublicIDCounter int64

// testPublicID mints a unique-enough public_id for a test fixture; the
// column's real generator is crypto/rand at the service layer (P2-9) — this
// is just uniqueness for a test database, not a security property.
func testPublicID() string {
	return fmt.Sprintf("test-public-%d", atomic.AddInt64(&testPublicIDCounter, 1))
}

// fileReport is FileReport with an auto-minted public_id and no evidence,
// for tests that only care about the report row itself.
func fileReport(t *testing.T, database *db.DB, reporterID, subjectID int64, targetType, targetRef string, channelID *int64, reason, detail string) int64 {
	t.Helper()
	id, err := database.FileReport(context.Background(), testPublicID(), reporterID, subjectID, targetType, targetRef, channelID, reason, detail, nil)
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}
	return id
}

func TestReportQueries_InsertGetAndDedupe(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-reporter")
	subject := seedUser(t, database, "rq-subject")
	chID := seedChannel(t, database, "rq-channel")

	id := fileReport(t, database, reporter, subject, "message", "42", &chID, "spam", "some detail")
	if id <= 0 {
		t.Fatalf("FileReport id = %d, want positive", id)
	}

	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.PublicID == "" {
		t.Error("GetReport public_id is empty")
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

	byPublic, err := database.GetReportByPublicID(ctx, report.PublicID)
	if err != nil {
		t.Fatalf("GetReportByPublicID: %v", err)
	}
	if byPublic.ID != id {
		t.Errorf("GetReportByPublicID = %+v, want id %d", byPublic, id)
	}
	if _, err := database.GetReportByPublicID(ctx, "no-such-public-id"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetReportByPublicID(missing) = %v, want ErrNotFound", err)
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

// TestReportQueries_FileReportUniqueConstraintIsConflict exercises P2-7's
// race-proof gate directly: a second FileReport for the same
// (reporter, target_type, target_ref) while the first is still open
// violates idx_reports_active_unique, and the violation must surface as
// db.ErrConflict, not a raw driver error.
func TestReportQueries_FileReportUniqueConstraintIsConflict(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-race-reporter")
	subject := seedUser(t, database, "rq-race-subject")

	if _, err := database.FileReport(ctx, testPublicID(), reporter, subject, "user", "dupe-ref", nil, "spam", "", nil); err != nil {
		t.Fatalf("first FileReport: %v", err)
	}
	_, err := database.FileReport(ctx, testPublicID(), reporter, subject, "user", "dupe-ref", nil, "spam", "", nil)
	if !errors.Is(err, db.ErrConflict) {
		t.Fatalf("second FileReport for the same active target = %v, want db.ErrConflict", err)
	}
}

// TestReportQueries_FileReportWritesEvidenceInTheSameTransaction pins P1-4:
// the report row and every evidence row land together, or none do.
func TestReportQueries_FileReportWritesEvidenceInTheSameTransaction(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-tx-reporter")
	subject := seedUser(t, database, "rq-tx-subject")

	id, err := database.FileReport(ctx, testPublicID(), reporter, subject, "message", "tx-ref", nil, "spam", "", []db.ReportEvidenceInput{
		{Seq: 0, AuthorID: subject, Content: "centre", AttachmentsJSON: "[]"},
		{Seq: -1, AuthorID: subject, Content: "before", AttachmentsJSON: "[]"},
	})
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}
	evidence, err := database.ListReportEvidence(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 2 {
		t.Fatalf("evidence rows = %d, want 2 (report and evidence committed together)", len(evidence))
	}
}

// TestReportQueries_FileReportRollsBackOnEvidenceFailure is P1-4's negative
// case, and the one the (k) revert-proof control actually exercises: a
// failing evidence insert (here, a duplicate seq colliding with
// report_evidence's PRIMARY KEY) must leave NEITHER the report row NOR any
// evidence row behind. Several autocommits instead of one transaction would
// leave the report row orphaned with no evidence — this is what would go red
// if FileReport were split back into separate statements.
func TestReportQueries_FileReportRollsBackOnEvidenceFailure(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-tx-fail-reporter")
	subject := seedUser(t, database, "rq-tx-fail-subject")

	_, err := database.FileReport(ctx, testPublicID(), reporter, subject, "message", "tx-fail-ref", nil, "spam", "", []db.ReportEvidenceInput{
		{Seq: 0, AuthorID: subject, Content: "centre", AttachmentsJSON: "[]"},
		{Seq: 0, AuthorID: subject, Content: "duplicate seq, must collide", AttachmentsJSON: "[]"},
	})
	if err == nil {
		t.Fatal("FileReport with a colliding evidence seq: want an error")
	}

	var reportRows, evidenceRows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM reports WHERE target_ref = 'tx-fail-ref'`).Scan(&reportRows); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_evidence WHERE content = 'centre'`).Scan(&evidenceRows); err != nil {
		t.Fatal(err)
	}
	if reportRows != 0 {
		t.Errorf("reports rows for the failed filing = %d, want 0 (the report insert must roll back with the evidence insert)", reportRows)
	}
	if evidenceRows != 0 {
		t.Errorf("evidence rows for the failed filing = %d, want 0", evidenceRows)
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

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "d")
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

	openID := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	assignedID := fileReport(t, database, reporter, subject, "user", "2", nil, "spam", "")
	if ok, err := database.AssignReport(ctx, assignedID, reporter, 0); err != nil || !ok {
		t.Fatalf("AssignReport = %v, %v, want true, nil", ok, err)
	}
	closedID := fileReport(t, database, reporter, subject, "user", "3", nil, "spam", "")
	if ok, err := database.CloseReport(ctx, closedID, "dismissed", "no_action"); err != nil || !ok {
		t.Fatalf("CloseReport = %v, %v, want true, nil", ok, err)
	}

	assertIDs := func(t *testing.T, rows []db.ReportQueueRow, want ...int64) {
		t.Helper()
		got := map[int64]bool{}
		for _, r := range rows {
			got[r.ID] = true
			if r.PublicID == "" {
				t.Errorf("queue row %d has no public_id", r.ID)
			}
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
	for _, r := range mine {
		if r.PublicID == "" {
			t.Errorf("Mine row %d has no public_id", r.ID)
		}
	}
}

func TestReportQueries_AssignAndCloseAreGuarded(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-guard-reporter")
	subject := seedUser(t, database, "rq-guard-subject")
	mod := seedUser(t, database, "rq-guard-mod")

	id := fileReport(t, database, reporter, subject, "user", "9", nil, "spam", "")
	if ok, err := database.CloseReport(ctx, id, "dismissed", "no_action"); err != nil || !ok {
		t.Fatalf("CloseReport = %v, %v, want true, nil", ok, err)
	}
	// Guarded: a closed report accepts no further assign or close.
	if ok, err := database.AssignReport(ctx, id, mod, 0); err != nil || ok {
		t.Errorf("AssignReport on a closed report = %v, %v, want false, nil", ok, err)
	}
	if ok, err := database.CloseReport(ctx, id, "resolved", "actioned"); err != nil || ok {
		t.Errorf("CloseReport on an already-closed report = %v, %v, want false, nil", ok, err)
	}
	// A nonexistent id is the same guarded zero-rows path.
	if ok, err := database.AssignReport(ctx, id+9999, mod, 0); err != nil || ok {
		t.Errorf("AssignReport(missing) = %v, %v, want false, nil", ok, err)
	}
}

// TestReportQueries_AssignReportObservedMismatch pins P2-8: the UPDATE is
// guarded on the caller's observed assignee, not just state. A stale
// observed value — even though the report is still open/assigned — must
// not match, exactly as if a concurrent reassignment had raced in first.
func TestReportQueries_AssignReportObservedMismatch(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-observed-reporter")
	subject := seedUser(t, database, "rq-observed-subject")
	modA := seedUser(t, database, "rq-observed-moda")
	modB := seedUser(t, database, "rq-observed-modb")

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	if ok, err := database.AssignReport(ctx, id, modA, 0); err != nil || !ok {
		t.Fatalf("first assign: %v, %v", ok, err)
	}
	// modB observed assignee_id = 0 (stale — it is actually modA now).
	if ok, err := database.AssignReport(ctx, id, modB, 0); err != nil || ok {
		t.Errorf("assign with a stale observed assignee = %v, %v, want false, nil", ok, err)
	}
	// The correct observed value (modA) succeeds.
	if ok, err := database.AssignReport(ctx, id, modB, modA); err != nil || !ok {
		t.Errorf("assign with the correct observed assignee = %v, %v, want true, nil", ok, err)
	}
}

// TestReportQueries_AssignReportRefusesAnErasedModerator pins P1-4's
// EXISTS(users) guard: a moderator whose account is gone cannot land as the
// new assignee, even though the state and observed-assignee guards would
// otherwise pass.
func TestReportQueries_AssignReportRefusesAnErasedModerator(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-ghost-reporter")
	subject := seedUser(t, database, "rq-ghost-subject")

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	const noSuchModerator = int64(999999)
	if ok, err := database.AssignReport(ctx, id, noSuchModerator, 0); err != nil || ok {
		t.Errorf("AssignReport to a nonexistent moderator = %v, %v, want false, nil", ok, err)
	}
}

// TestReportQueries_InsertReportNoteRefusesAnErasedModerator is
// AssignReport's sibling for notes.
func TestReportQueries_InsertReportNoteRefusesAnErasedModerator(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-note-ghost-reporter")
	subject := seedUser(t, database, "rq-note-ghost-subject")

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	const noSuchModerator = int64(999999)
	ok, err := database.InsertReportNote(ctx, id, noSuchModerator, "a note")
	if err != nil {
		t.Fatalf("InsertReportNote: %v", err)
	}
	if ok {
		t.Error("InsertReportNote by a nonexistent moderator = true, want false")
	}
	notes, err := database.ListReportNotes(ctx, id)
	if err != nil {
		t.Fatalf("ListReportNotes: %v", err)
	}
	if len(notes) != 0 {
		t.Errorf("notes after a refused insert = %d, want 0", len(notes))
	}
}

// TestReportQueries_FileReportRefusesAGoneReporterOrSubject pins the
// re-validation Codex review widened P1-4 to: the caller resolved the
// reporter/subject before this transaction opened, so an erasure racing
// that resolution must not let a since-erased principal's id land in the
// new row — the guarded INSERT ... SELECT ... WHERE EXISTS turns that into
// a zero-row RETURNING, mapped to db.ErrNotFound, and no report is created.
func TestReportQueries_FileReportRefusesAGoneReporterOrSubject(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	const noSuchUser = int64(999999)
	realUser := seedUser(t, database, "rq-revalidate-real")

	if _, err := database.FileReport(ctx, testPublicID(), noSuchUser, realUser, "user", "revalidate-reporter", nil, "spam", "", nil); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("FileReport with a gone reporter: err = %v, want ErrNotFound", err)
	}
	if _, err := database.FileReport(ctx, testPublicID(), realUser, noSuchUser, "user", "revalidate-subject", nil, "spam", "", nil); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("FileReport with a gone subject: err = %v, want ErrNotFound", err)
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM reports WHERE target_ref LIKE 'revalidate-%'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Errorf("reports rows from the refused filings = %d, want 0", rows)
	}
}

// TestReportQueries_FileReportDropsEvidenceFromAGoneAuthor pins the other
// half of the same widening: an evidence row whose author was erased in that
// same race window is silently dropped, not an abort of the whole report —
// the snapshot is simply short one context row.
func TestReportQueries_FileReportDropsEvidenceFromAGoneAuthor(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-drop-reporter")
	subject := seedUser(t, database, "rq-drop-subject")
	const noSuchAuthor = int64(999999)

	id, err := database.FileReport(ctx, testPublicID(), reporter, subject, "message", "drop-ref", nil, "spam", "", []db.ReportEvidenceInput{
		{Seq: 0, AuthorID: subject, Content: "centre, real author", AttachmentsJSON: "[]"},
		{Seq: -1, AuthorID: noSuchAuthor, Content: "context from a gone author", AttachmentsJSON: "[]"},
	})
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}
	evidence, err := database.ListReportEvidence(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 1 {
		t.Fatalf("evidence rows = %d, want 1 (the gone author's row silently dropped)", len(evidence))
	}
	if evidence[0].AuthorID != subject {
		t.Errorf("surviving evidence author = %d, want %d", evidence[0].AuthorID, subject)
	}
}

// TestReportQueries_InsertReportNoteRefusesOnClosedReport pins the second
// half of the review's InsertReportNote widening: a note may not land on a
// report that is not open/assigned, guarded atomically in the same INSERT
// as the EXISTS(users) check — not a separate read-then-write that a
// concurrent Close could slip between.
func TestReportQueries_InsertReportNoteRefusesOnClosedReport(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-note-closed-reporter")
	subject := seedUser(t, database, "rq-note-closed-subject")
	mod := seedUser(t, database, "rq-note-closed-mod")

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	if ok, err := database.CloseReport(ctx, id, "resolved", "actioned"); err != nil || !ok {
		t.Fatalf("CloseReport: %v, %v", ok, err)
	}
	ok, err := database.InsertReportNote(ctx, id, mod, "too late")
	if err != nil {
		t.Fatalf("InsertReportNote: %v", err)
	}
	if ok {
		t.Error("InsertReportNote on a closed report = true, want false")
	}
	notes, err := database.ListReportNotes(ctx, id)
	if err != nil {
		t.Fatalf("ListReportNotes: %v", err)
	}
	if len(notes) != 0 {
		t.Errorf("notes on a closed report = %d, want 0", len(notes))
	}
}

// TestReportQueries_AssignReportForced covers the tx-scoped outrank check
// (Codex review): success when the actor genuinely outranks the current
// assignee (read fresh, inside the same transaction as the write), and
// ErrForbidden when they do not.
func TestReportQueries_AssignReportForced(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-forced-reporter")
	subject := seedUser(t, database, "rq-forced-subject")
	lowMod := seedUser(t, database, "rq-forced-lowmod")
	highMod := seedUser(t, database, "rq-forced-highmod")
	lowerActor := seedUser(t, database, "rq-forced-loweractor")
	if _, err := database.ExecContext(ctx, `INSERT INTO roles (id, name, permissions, position) VALUES (5000, 'rq-forced-lower-role', 0, 5)`); err != nil {
		t.Fatalf("seed lower role: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO roles (id, name, permissions, position) VALUES (5001, 'rq-forced-low-role', 0, 10)`); err != nil {
		t.Fatalf("seed low role: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO roles (id, name, permissions, position) VALUES (5002, 'rq-forced-high-role', 0, 90)`); err != nil {
		t.Fatalf("seed high role: %v", err)
	}
	setRole(t, database, lowerActor, 5000)
	setRole(t, database, lowMod, 5001)
	setRole(t, database, highMod, 5002)

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	if ok, err := database.AssignReport(ctx, id, lowMod, 0); err != nil || !ok {
		t.Fatalf("first assign: %v, %v", ok, err)
	}

	// lowerActor (position 5, read fresh from their own real role — the
	// inherited-P2 fix: forceReassignGuarded takes an actor id, never a
	// caller-supplied position) does not outrank lowMod (position 10).
	if ok, err := database.AssignReportForced(ctx, id, highMod, lowMod, lowerActor); !errors.Is(err, db.ErrForbidden) || ok {
		t.Errorf("AssignReportForced without outranking = %v, %v, want false, ErrForbidden", ok, err)
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.AssigneeID != lowMod {
		t.Errorf("assignee after a refused force = %d, want %d (unchanged)", report.AssigneeID, lowMod)
	}

	// A caller who genuinely outranks the current (fresh-read) assignee
	// succeeds.
	if ok, err := database.AssignReportForced(ctx, id, highMod, lowMod, highMod); err != nil || !ok {
		t.Errorf("AssignReportForced outranking = %v, %v, want true, nil", ok, err)
	}
	report, err = database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.AssigneeID != highMod {
		t.Errorf("assignee after a successful force = %d, want %d", report.AssigneeID, highMod)
	}
}

// TestReportQueries_AssignReportForcedRefusesAnErasedCurrentAssignee covers
// AssignReportForced's other branch: the observed assignee no longer
// resolves to a role at all (erased mid-race) — nothing to outrank, so the
// call refuses rather than erroring.
func TestReportQueries_AssignReportForcedRefusesAnErasedCurrentAssignee(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-forced-ghost-reporter")
	subject := seedUser(t, database, "rq-forced-ghost-subject")
	newMod := seedUser(t, database, "rq-forced-ghost-newmod")
	const erasedAssignee = int64(999999)

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	if ok, err := database.AssignReportForced(ctx, id, newMod, erasedAssignee, newMod); err != nil || ok {
		t.Errorf("AssignReportForced with a gone current assignee = %v, %v, want false, nil", ok, err)
	}
}

// TestReportQueries_AssignReportForcedZeroRowsWhenReportClosed covers the
// n != 1 branch: the actor genuinely outranks, but the report is no longer
// open/assigned by the time the guarded UPDATE runs.
func TestReportQueries_AssignReportForcedZeroRowsWhenReportClosed(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-forced-closed-reporter")
	subject := seedUser(t, database, "rq-forced-closed-subject")
	lowMod := seedUser(t, database, "rq-forced-closed-lowmod")
	highMod := seedUser(t, database, "rq-forced-closed-highmod")
	if _, err := database.ExecContext(ctx, `INSERT INTO roles (id, name, permissions, position) VALUES (5003, 'rq-forced-closed-low-role', 0, 10)`); err != nil {
		t.Fatalf("seed low role: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO roles (id, name, permissions, position) VALUES (5004, 'rq-forced-closed-high-role', 0, 90)`); err != nil {
		t.Fatalf("seed high role: %v", err)
	}
	setRole(t, database, lowMod, 5003)
	setRole(t, database, highMod, 5004)

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	if ok, err := database.AssignReport(ctx, id, lowMod, 0); err != nil || !ok {
		t.Fatalf("first assign: %v, %v", ok, err)
	}
	if ok, err := database.CloseReport(ctx, id, "resolved", "actioned"); err != nil || !ok {
		t.Fatalf("close: %v, %v", ok, err)
	}
	if ok, err := database.AssignReportForced(ctx, id, highMod, lowMod, highMod); err != nil || ok {
		t.Errorf("AssignReportForced on a closed report = %v, %v, want false, nil", ok, err)
	}
}

// TestReportQueries_InsertAndListReportEvents exercises report_events
// directly at the db-package level (second Codex review) — the
// service-level test drives the same calls through a real *db.DB, but
// per-package coverage only counts a package's own tests.
func TestReportQueries_InsertAndListReportEvents(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-events-reporter")
	subject := seedUser(t, database, "rq-events-subject")
	mod := seedUser(t, database, "rq-events-mod")

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	// FileReport already wrote the "created" row; add the rest directly.
	if err := database.InsertReportEvent(ctx, id, mod, "assigned", ""); err != nil {
		t.Fatalf("InsertReportEvent(assigned): %v", err)
	}
	if err := database.InsertReportEvent(ctx, id, mod, "closed", "actioned"); err != nil {
		t.Fatalf("InsertReportEvent(closed): %v", err)
	}

	events, err := database.ListReportEvents(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvents: %v", err)
	}
	wantActions := []string{"created", "assigned", "closed"}
	if len(events) != len(wantActions) {
		t.Fatalf("events = %d rows, want %d", len(events), len(wantActions))
	}
	for i, action := range wantActions {
		if events[i].Action != action {
			t.Errorf("event[%d].Action = %q, want %q", i, events[i].Action, action)
		}
	}
	if events[0].ActorID != 0 {
		t.Errorf("created event actor = %d, want 0", events[0].ActorID)
	}
	if events[1].ActorID != mod || events[2].ActorID != mod {
		t.Error("assigned/closed events must carry the acting moderator")
	}
	if events[2].Detail != "actioned" {
		t.Errorf("closed event detail = %q, want %q", events[2].Detail, "actioned")
	}
}

func TestReportQueries_EvidenceAndNotes(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "rq-ev-reporter")
	subject := seedUser(t, database, "rq-ev-subject")
	author := seedUser(t, database, "rq-ev-author")

	id := fileReport(t, database, reporter, subject, "message", "5", nil, "spam", "")
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

	ok, err := database.InsertReportNote(ctx, id, author, "an internal note")
	if err != nil {
		t.Fatalf("InsertReportNote: %v", err)
	}
	if !ok {
		t.Fatal("InsertReportNote by a real user = false, want true")
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
// row): the evidence wrapper must return the underlying error, not swallow
// it, and the note wrapper's EXISTS guard on a missing report_id/author
// still inserts zero rows (no FK on report_notes.report_id's target check
// here — the EXISTS clause is on users, not reports — so this exercises
// the evidence FK error and the note author-existence guard together).
func TestReportQueries_EvidenceAndNoteErrorsPropagate(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	const noSuchReport = int64(999999)

	if err := database.InsertReportEvidence(ctx, noSuchReport, 0, nil, 0, "x", "[]"); err == nil {
		t.Error("InsertReportEvidence with no such report_id: want an error")
	}
	if ok, err := database.InsertReportNote(ctx, noSuchReport, 0, "x"); err != nil {
		t.Errorf("InsertReportNote with no such report_id: unexpected error %v", err)
	} else if ok {
		t.Error("InsertReportNote with author_id 0 (no such user): want false")
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
	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "")
	publicID, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := database.FileReport(ctx, testPublicID(), reporter, subject, "user", "2", nil, "spam", "", nil); err == nil {
		t.Error("FileReport on a closed db: want an error")
	}
	if _, err := database.GetReport(ctx, id); err == nil {
		t.Error("GetReport on a closed db: want an error")
	}
	if _, err := database.GetReportByPublicID(ctx, publicID.PublicID); err == nil {
		t.Error("GetReportByPublicID on a closed db: want an error")
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
	if _, err := database.AssignReport(ctx, id, reporter, 0); err == nil {
		t.Error("AssignReport on a closed db: want an error")
	}
	if _, err := database.CloseReport(ctx, id, "resolved", "actioned"); err == nil {
		t.Error("CloseReport on a closed db: want an error")
	}
	if _, err := database.ListReportEvidence(ctx, id); err == nil {
		t.Error("ListReportEvidence on a closed db: want an error")
	}
	if _, err := database.InsertReportNote(ctx, id, reporter, "x"); err == nil {
		t.Error("InsertReportNote on a closed db: want an error")
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

	id := fileReport(t, database, reporter, subject, "user", "1", nil, "spam", "kept until pruned")
	if err := database.InsertReportEvidence(ctx, id, 0, nil, 0, "content", "[]"); err != nil {
		t.Fatalf("InsertReportEvidence: %v", err)
	}
	if ok, err := database.InsertReportNote(ctx, id, reporter, "a note"); err != nil || !ok {
		t.Fatalf("InsertReportNote: %v, %v", ok, err)
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
	openID := fileReport(t, database, reporter, subject, "user", "2", nil, "spam", "still open")
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
