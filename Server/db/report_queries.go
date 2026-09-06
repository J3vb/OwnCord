package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Report is a row of the reports table (migration 048, B5-8). ReporterToken
// and SubjectToken are filled by erasure (the audit_log two-token pattern,
// migrations 038/041): a zero id plus a non-empty token means that principal
// erased their account.
type Report struct {
	ID            int64
	ReporterID    int64
	ReporterToken string
	SubjectID     int64
	SubjectToken  string
	TargetType    string
	TargetRef     string
	ChannelID     *int64
	Reason        string
	Detail        string
	State         string
	AssigneeID    int64
	Outcome       string
	CreatedAt     string
	UpdatedAt     string
	ClosedAt      *string
}

// ReportQueueRow is one row of the moderation queue listing, with reporter
// and subject usernames resolved for display. Never carries the reason
// detail's free text or the evidence/notes.
type ReportQueueRow struct {
	ID           int64
	ReporterID   int64
	SubjectID    int64
	TargetType   string
	TargetRef    string
	ChannelID    *int64
	Reason       string
	State        string
	AssigneeID   int64
	Outcome      string
	CreatedAt    string
	UpdatedAt    string
	ClosedAt     *string
	ReporterName string
	SubjectName  string
}

// ReportSummary is one row of a reporter's own view (GET /api/v1/reports/mine):
// never the assignee, never the notes.
type ReportSummary struct {
	ID         int64
	TargetType string
	Reason     string
	State      string
	Outcome    string
	CreatedAt  string
	ClosedAt   *string
}

// ReportEvidenceRow is one row of a report's evidence snapshot.
type ReportEvidenceRow struct {
	ReportID    int64
	Seq         int64
	MessageID   *int64
	AuthorID    int64
	AuthorToken string
	Content     string
	Attachments string
	CapturedAt  string
}

// ReportNoteRow is one internal note on a report.
type ReportNoteRow struct {
	ID          int64
	ReportID    int64
	AuthorID    int64
	AuthorToken string
	Body        string
	CreatedAt   string
}

func reportFromRow(r dbgen.Report) Report {
	return Report{
		ID: r.ID, ReporterID: r.ReporterID, ReporterToken: strOrEmpty(r.ReporterToken),
		SubjectID: r.SubjectID, SubjectToken: strOrEmpty(r.SubjectToken),
		TargetType: r.TargetType, TargetRef: r.TargetRef, ChannelID: r.ChannelID,
		Reason: r.Reason, Detail: r.Detail, State: r.State, AssigneeID: r.AssigneeID,
		Outcome: r.Outcome, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, ClosedAt: r.ClosedAt,
	}
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// InsertReport creates a report row and returns its id. channelID is nil for
// a user target and for an attachment target with no owning message.
func (d *DB) InsertReport(ctx context.Context, reporterID, subjectID int64, targetType, targetRef string, channelID *int64, reason, detail string) (int64, error) {
	id, err := d.q.InsertReport(ctx, dbgen.InsertReportParams{
		ReporterID: reporterID, SubjectID: subjectID, TargetType: targetType,
		TargetRef: targetRef, ChannelID: channelID, Reason: reason, Detail: detail,
	})
	if err != nil {
		return 0, fmt.Errorf("InsertReport: %w", err)
	}
	return id, nil
}

// GetReport returns one report by id, or ErrNotFound.
func (d *DB) GetReport(ctx context.Context, id int64) (*Report, error) {
	r, err := d.q.GetReportByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetReport: %w", err)
	}
	rep := reportFromRow(r)
	return &rep, nil
}

// FindOpenOrAssignedReport is the duplicate-report check: the same reporter,
// same target, an open or assigned report already exists. Returns 0, nil
// when none does.
func (d *DB) FindOpenOrAssignedReport(ctx context.Context, reporterID int64, targetType, targetRef string) (int64, error) {
	id, err := d.q.FindOpenOrAssignedReport(ctx, dbgen.FindOpenOrAssignedReportParams{
		ReporterID: reporterID, TargetType: targetType, TargetRef: targetRef,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("FindOpenOrAssignedReport: %w", err)
	}
	return id, nil
}

func queueRowFrom(id, reporterID, subjectID int64, targetType, targetRef string, channelID *int64, reason, state string, assigneeID int64, outcome, createdAt, updatedAt string, closedAt *string, reporterName, subjectName string) ReportQueueRow {
	return ReportQueueRow{
		ID: id, ReporterID: reporterID, SubjectID: subjectID, TargetType: targetType,
		TargetRef: targetRef, ChannelID: channelID, Reason: reason, State: state,
		AssigneeID: assigneeID, Outcome: outcome, CreatedAt: createdAt, UpdatedAt: updatedAt,
		ClosedAt: closedAt, ReporterName: reporterName, SubjectName: subjectName,
	}
}

// ListReportsQueue returns the queue view for one state filter: "open",
// "assigned", "closed" (every terminal state), or "" for the default
// open+assigned view.
func (d *DB) ListReportsQueue(ctx context.Context, state string) ([]ReportQueueRow, error) {
	switch state {
	case "open", "assigned":
		rows, err := d.q.ListReportsByState(ctx, state)
		if err != nil {
			return nil, fmt.Errorf("ListReportsQueue: %w", err)
		}
		out := make([]ReportQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, queueRowFrom(r.ID, r.ReporterID, r.SubjectID, r.TargetType, r.TargetRef,
				r.ChannelID, r.Reason, r.State, r.AssigneeID, r.Outcome, r.CreatedAt, r.UpdatedAt,
				r.ClosedAt, r.ReporterName, r.SubjectName))
		}
		return out, nil
	case "closed":
		rows, err := d.q.ListReportsClosed(ctx)
		if err != nil {
			return nil, fmt.Errorf("ListReportsQueue: %w", err)
		}
		out := make([]ReportQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, queueRowFrom(r.ID, r.ReporterID, r.SubjectID, r.TargetType, r.TargetRef,
				r.ChannelID, r.Reason, r.State, r.AssigneeID, r.Outcome, r.CreatedAt, r.UpdatedAt,
				r.ClosedAt, r.ReporterName, r.SubjectName))
		}
		return out, nil
	default:
		rows, err := d.q.ListReportsOpenOrAssigned(ctx)
		if err != nil {
			return nil, fmt.Errorf("ListReportsQueue: %w", err)
		}
		out := make([]ReportQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, queueRowFrom(r.ID, r.ReporterID, r.SubjectID, r.TargetType, r.TargetRef,
				r.ChannelID, r.Reason, r.State, r.AssigneeID, r.Outcome, r.CreatedAt, r.UpdatedAt,
				r.ClosedAt, r.ReporterName, r.SubjectName))
		}
		return out, nil
	}
}

// ListReportsMine is the reporter's own view.
func (d *DB) ListReportsMine(ctx context.Context, reporterID int64) ([]ReportSummary, error) {
	rows, err := d.q.ListReportsMine(ctx, reporterID)
	if err != nil {
		return nil, fmt.Errorf("ListReportsMine: %w", err)
	}
	out := make([]ReportSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, ReportSummary{
			ID: r.ID, TargetType: r.TargetType, Reason: r.Reason, State: r.State,
			Outcome: r.Outcome, CreatedAt: r.CreatedAt, ClosedAt: r.ClosedAt,
		})
	}
	return out, nil
}

// AssignReport assigns assigneeID to report id, guarded to open/assigned
// states. Returns whether a row was affected; zero means CONFLICT.
func (d *DB) AssignReport(ctx context.Context, id, assigneeID int64) (bool, error) {
	n, err := d.q.AssignReport(ctx, dbgen.AssignReportParams{AssigneeID: assigneeID, ID: id})
	if err != nil {
		return false, fmt.Errorf("AssignReport: %w", err)
	}
	return n == 1, nil
}

// CloseReport closes report id with outcome, guarded to open/assigned
// states. state must be "resolved" or "dismissed". Returns whether a row
// was affected; zero means CONFLICT.
func (d *DB) CloseReport(ctx context.Context, id int64, state, outcome string) (bool, error) {
	n, err := d.q.CloseReport(ctx, dbgen.CloseReportParams{State: state, Outcome: outcome, ID: id})
	if err != nil {
		return false, fmt.Errorf("CloseReport: %w", err)
	}
	return n == 1, nil
}

// InsertReportEvidence writes one snapshot row. attachmentsJSON is a JSON
// list of {id, filename, mime, size} references, never bytes and never
// stored_as (S5, decision 7).
func (d *DB) InsertReportEvidence(ctx context.Context, reportID, seq int64, messageID *int64, authorID int64, content, attachmentsJSON string) error {
	if err := d.q.InsertReportEvidence(ctx, dbgen.InsertReportEvidenceParams{
		ReportID: reportID, Seq: seq, MessageID: messageID, AuthorID: authorID,
		Content: content, Attachments: attachmentsJSON,
	}); err != nil {
		return fmt.Errorf("InsertReportEvidence: %w", err)
	}
	return nil
}

// ListReportEvidence returns a report's snapshot, ordered by seq.
func (d *DB) ListReportEvidence(ctx context.Context, reportID int64) ([]ReportEvidenceRow, error) {
	rows, err := d.q.ListReportEvidence(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("ListReportEvidence: %w", err)
	}
	out := make([]ReportEvidenceRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ReportEvidenceRow{
			ReportID: r.ReportID, Seq: r.Seq, MessageID: r.MessageID, AuthorID: r.AuthorID,
			AuthorToken: strOrEmpty(r.AuthorToken), Content: r.Content, Attachments: r.Attachments,
			CapturedAt: r.CapturedAt,
		})
	}
	return out, nil
}

// InsertReportNote adds one internal note.
func (d *DB) InsertReportNote(ctx context.Context, reportID, authorID int64, body string) error {
	if err := d.q.InsertReportNote(ctx, dbgen.InsertReportNoteParams{ReportID: reportID, AuthorID: authorID, Body: body}); err != nil {
		return fmt.Errorf("InsertReportNote: %w", err)
	}
	return nil
}

// ListReportNotes returns a report's internal notes, oldest first.
func (d *DB) ListReportNotes(ctx context.Context, reportID int64) ([]ReportNoteRow, error) {
	rows, err := d.q.ListReportNotes(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("ListReportNotes: %w", err)
	}
	out := make([]ReportNoteRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ReportNoteRow{
			ID: r.ID, ReportID: r.ReportID, AuthorID: r.AuthorID,
			AuthorToken: strOrEmpty(r.AuthorToken), Body: r.Body, CreatedAt: r.CreatedAt,
		})
	}
	return out, nil
}

// PruneReportContentOlderThan deletes the evidence and notes, and clears the
// detail, of every report closed before cutoff (a "YYYY-MM-DD HH:MM:SS" UTC
// string comparable with SQLite's datetime('now')). The reports row itself
// is kept — content is bounded, the outcome is indefinite (S5-d). Returns
// the number of reports whose detail was cleared, which is 0 exactly when
// nothing in range had any content left to prune.
func (d *DB) PruneReportContentOlderThan(ctx context.Context, cutoff string) (int64, error) {
	if _, err := d.q.PruneReportEvidenceOlderThan(ctx, &cutoff); err != nil {
		return 0, fmt.Errorf("PruneReportContentOlderThan evidence: %w", err)
	}
	if _, err := d.q.PruneReportNotesOlderThan(ctx, &cutoff); err != nil {
		return 0, fmt.Errorf("PruneReportContentOlderThan notes: %w", err)
	}
	n, err := d.q.PruneReportDetailOlderThan(ctx, &cutoff)
	if err != nil {
		return 0, fmt.Errorf("PruneReportContentOlderThan detail: %w", err)
	}
	return n, nil
}
