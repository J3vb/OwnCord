package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// InsertReportEvidence writes one snapshot row. attachmentsJSON is a JSON list
// of {id, filename, mime, size} references, never bytes or stored_as.
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

// InsertReportNote adds one internal note, guarded on EXISTS(users) so an
// erased moderator cannot land as author. It returns false when not inserted;
// the caller answers 409.
func (d *DB) InsertReportNote(ctx context.Context, reportID, authorID int64, body string) (bool, error) {
	return d.reportMutation(ctx, "InsertReportNote", reportID, authorID, "noted", "", func(q *dbgen.Queries) (int64, error) {
		return q.InsertReportNote(ctx, dbgen.InsertReportNoteParams{ReportID: reportID, AuthorID: authorID, Body: body})
	})
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

// InsertReportEvent appends a row to report_events, this feature's own
// immutable history, never the shared audit_log (which a VIEW_AUDIT_LOG holder
// can read without MODERATE_MEMBERS). detail is the state or outcome word only,
// never free text (AssertSafeDetails and
// TestReportEvents_EveryMutationWritesOne hold this).
func (d *DB) InsertReportEvent(ctx context.Context, reportID, actorID int64, action, detail string) error {
	if err := d.q.InsertReportEvent(ctx, dbgen.InsertReportEventParams{
		ReportID: reportID, ActorID: actorID, Action: action, Detail: detail,
	}); err != nil {
		return fmt.Errorf("InsertReportEvent: %w", err)
	}
	return nil
}

func eventFromRow(r dbgen.ReportEvent) ReportEvent {
	return ReportEvent{
		ID: r.ID, ReportID: r.ReportID, ActorID: r.ActorID, ActorToken: strOrEmpty(r.ActorToken),
		Action: r.Action, Detail: r.Detail, CreatedAt: r.CreatedAt,
	}
}

// ListReportEvents returns a report's immutable history, oldest first, exposed
// only inside the queue detail (MODERATE_MEMBERS plus ReportService.Get's
// confidentiality guard).
func (d *DB) ListReportEvents(ctx context.Context, reportID int64) ([]ReportEvent, error) {
	rows, err := d.q.ListReportEvents(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("ListReportEvents: %w", err)
	}
	out := make([]ReportEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, eventFromRow(r))
	}
	return out, nil
}

// PruneReportContentOlderThan deletes the evidence and notes, and clears the
// detail, of every report closed before cutoff ("YYYY-MM-DD HH:MM:SS" UTC,
// comparable with datetime('now')). The reports row is kept: content is
// bounded, the outcome indefinite. It returns the number of reports whose
// detail was cleared, 0 exactly when nothing in range had content left.
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
