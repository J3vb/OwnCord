package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// RequireModerate is requireModerate exported for a handler that must authorize BEFORE resolving anything
// else: resolving a public id first would make "unknown id" and "real id, no permission" different status
// codes, an existence oracle.
func (s *ReportService) RequireModerate(ctx context.Context, actorID int64) error {
	return requireModerate(ctx, s.perms, actorID)
}

// requireModerate loads actorID's role and checks permissions.CanModerate before any report or appeal lookup,
// so an actor without the bit sees Forbidden whether or not the id exists. Returns no role: force-reassign
// reads the actor's position fresh in its write transaction. Package-level because ReportService and
// AppealService need the identical check; one predicate per security property cannot drift.
func requireModerate(ctx context.Context, perms *PermissionService, actorID int64) error {
	role, err := perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return fmt.Errorf("%w: failed to load role", ErrForbidden)
	}
	if err := permissions.CanModerate(permissions.Subject{RolePerms: role.Perms}); err != nil {
		return fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	}
	return nil
}

// guardConfidentiality is the reciprocal of requireModerate: even a bit holder may not read or act on a
// report about themselves. ErrNotFound, never Forbidden, so the subject cannot learn a report about them
// exists.
func guardConfidentiality(actorID int64, report *db.Report) error {
	if isReportSubject(actorID, report.SubjectID) {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return nil
}

// ErrSelfReview is a 403: a moderator may not act on, or read the notes of, a report they filed. Reused by
// appeals.
var ErrSelfReview = fmt.Errorf("%w: cannot act on your own report", ErrForbidden)

// GuardSelfReviewFor refuses a moderator acting on their own filed report. Unlike guardConfidentiality it is
// Forbidden: a reporter knows their report exists (it is in Mine()), so only the conflict of interest
// remains. Exported for the queue's act route: reading one's own filing is allowed, acting on it is not.
func GuardSelfReviewFor(actorID int64, report *db.Report) error {
	if report.ReporterID != 0 && report.ReporterID == actorID {
		return ErrSelfReview
	}
	return nil
}

// VisibleReportPublicID resolves reportID's public id for viewerID under the same guard as Get: a report
// about the viewer never surfaces its id, even from a surface authorized on other grounds. false also covers
// an id that no longer resolves.
func (s *ReportService) VisibleReportPublicID(ctx context.Context, viewerID, reportID int64) (string, bool) {
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return "", false
	}
	if guardConfidentiality(viewerID, report) != nil {
		return "", false
	}
	return report.PublicID, true
}

// Queue lists reports for the moderator view: state is "open", "assigned", "closed" (every terminal state) or
// "" for open+assigned. A report about the caller is excluded.
func (s *ReportService) Queue(ctx context.Context, actorID int64, state string) ([]db.ReportQueueRow, error) {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return nil, err
	}
	switch state {
	case "", "open", "assigned", "closed":
	default:
		return nil, fmt.Errorf("%w: invalid state", ErrBadRequest)
	}
	rows, err := s.st.ListReportsQueue(ctx, state)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]db.ReportQueueRow, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		if r.SubjectID != 0 && r.SubjectID == actorID {
			continue
		}
		out = append(out, *r)
	}
	return out, nil
}

// ReportDetail is GET .../queue/{id}'s payload.
type ReportDetail struct {
	Report   db.Report
	Evidence []db.ReportEvidenceRow
	Notes    []db.ReportNoteRow
	Events   []db.ReportEvent
	// EvidenceWithheld is empty when Evidence is readable, else why:
	// EvidenceNSFWAcknowledgementRequired or EvidenceSourceChannelUnavailable.
	EvidenceWithheld string
}

// Get returns one report with evidence, notes and history. 404, never 403, for a missing id and for the
// caller's own report as SUBJECT. A moderator who is the REPORTER may read it but never its notes, and may
// not act on it (GuardSelfReviewFor). report_events is exposed here and nowhere else.
func (s *ReportService) Get(ctx context.Context, actorID, reportID int64) (*ReportDetail, error) {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return nil, err
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return nil, err
	}
	var evidence []db.ReportEvidenceRow
	withheld := s.evidenceWithheld(ctx, actorID, report)
	if withheld == "" {
		if evidence, err = s.st.ListReportEvidence(ctx, reportID); err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}
	events, err := s.st.ListReportEvents(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if report.ReporterID != 0 && report.ReporterID == actorID {
		return &ReportDetail{Report: *report, Evidence: evidence, Events: events, EvidenceWithheld: withheld}, nil
	}
	notes, err := s.st.ListReportNotes(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &ReportDetail{Report: *report, Evidence: evidence, Notes: notes, Events: events, EvidenceWithheld: withheld}, nil
}

// Assign assigns reportID to actorID. 409 if already assigned to someone else, unless force is set and the
// caller outranks the assignee. The plain write is guarded on the observed assignee, so a concurrent
// reassignment invalidates a stale verdict. The force path's outrank comparison runs INSIDE the write's
// transaction (AssignReportForced), since separate statements left a gap a role change could race. Zero rows
// is 409; failing to outrank is 403.
func (s *ReportService) Assign(ctx context.Context, actorID, reportID int64, force bool) error {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return err
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return err
	}
	if err := GuardSelfReviewFor(actorID, report); err != nil {
		return err
	}
	observed := report.AssigneeID
	if observed != 0 && observed != actorID {
		if !force {
			return fmt.Errorf("%w: already assigned", ErrConflict)
		}
		ok, err := s.st.AssignReportForced(ctx, reportID, actorID, observed, actorID)
		if err != nil {
			if errors.Is(err, db.ErrForbidden) {
				return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
			}
			return fmt.Errorf("%w: %w", ErrInternal, err)
		}
		if !ok {
			return fmt.Errorf("%w: report is no longer open", ErrConflict)
		}
		return nil
	}
	ok, err := s.st.AssignReport(ctx, reportID, actorID, observed)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: report is no longer open", ErrConflict)
	}
	return nil
}

// Note adds an internal note visible to MODERATE_MEMBERS holders only: neither the reporter nor the subject
// reads it.
func (s *ReportService) Note(ctx context.Context, actorID, reportID int64, body string) error {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return err
	}
	if body == "" || len([]rune(body)) > maxNoteRunes {
		return fmt.Errorf("%w: invalid note body", ErrBadRequest)
	}
	if hasControlChar(body) {
		return fmt.Errorf("%w: note contains control characters", ErrBadRequest)
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return err
	}
	if err := GuardSelfReviewFor(actorID, report); err != nil {
		return err
	}
	ok, err := s.st.InsertReportNote(ctx, reportID, actorID, body)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		// Zero rows means the moderator account was erased, or the report closed, since requirePerm's read.
		return fmt.Errorf("%w: report is closed, or the moderator account no longer exists", ErrConflict)
	}
	return nil
}

// Close closes reportID with outcome "actioned", "no_action" or "duplicate" and returns the state ("resolved"
// or "dismissed") for the mod_queue frame. Guarded to open/assigned; a concurrent close answers Conflict.
func (s *ReportService) Close(ctx context.Context, actorID, reportID int64, outcome string) (string, error) {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return "", err
	}
	if !validOutcomes[outcome] {
		return "", fmt.Errorf("%w: invalid outcome", ErrBadRequest)
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return "", fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return "", err
	}
	if err := GuardSelfReviewFor(actorID, report); err != nil {
		return "", err
	}
	state := outcomeState[outcome]
	ok, err := s.st.CloseReport(ctx, reportID, state, outcome, actorID)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return "", fmt.Errorf("%w: report is already closed", ErrConflict)
	}
	return state, nil
}
