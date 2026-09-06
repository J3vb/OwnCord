package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ReportService is the local report intake and moderator queue (B5-8,
// BPR-070, BPR-071's server half). It owns the report row, the immutable
// evidence snapshot taken at file time, assignment/status/notes, and the
// reporter's own status view. Every write is audited on the B2-6 foundation
// with B4-10-style actor tokens (db/erasure.go's erasureUnlinkReports).
type ReportService struct {
	st       Store
	perms    *PermissionService
	messages *MessageService
	uploads  *UploadService
	// moderation is reused for its outrank check ONLY (requireOutranksRole,
	// package-private — same package, not exported): the force-reassign path
	// needs the identical hierarchy rule ban/kick/timeout use, not a second
	// copy of it.
	moderation *ModerationService
	limiter    *auth.RateLimiter
}

// NewReportService creates a ReportService.
func NewReportService(st Store, perms *PermissionService, messages *MessageService, uploads *UploadService, moderation *ModerationService, limiter *auth.RateLimiter) *ReportService {
	return &ReportService{st: st, perms: perms, messages: messages, uploads: uploads, moderation: moderation, limiter: limiter}
}

// Valid target types, reasons and outcomes (the wire contract).
const (
	TargetMessage    = "message"
	TargetUser       = "user"
	TargetAttachment = "attachment"
)

var validReasons = map[string]bool{
	"spam": true, "harassment": true, "nsfw_unlabelled": true, "illegal": true, "other": true,
}

var validOutcomes = map[string]bool{
	"actioned": true, "no_action": true, "duplicate": true,
}

// outcomeState maps an outcome to the state machine's terminal state: an
// outcome is the moderator's decision, state is the queue's status column —
// two enumerations doing different jobs, so a report closed "actioned" is
// state=resolved (real content, actually addressed) and one closed
// "no_action" or "duplicate" is state=dismissed (nothing to enforce, or
// already covered elsewhere).
var outcomeState = map[string]string{
	"actioned":  "resolved",
	"no_action": "dismissed",
	"duplicate": "dismissed",
}

// maxDetailRunes and maxNoteRunes are the free-text bounds (S5 storage
// exhaustion, plan item 12).
const (
	maxDetailRunes = 2000
	maxNoteRunes   = 4000
	// reportContextWindow is decision 7/scorecard Question 3's N=5 either
	// side, plus the reported item itself: 11 rows, fixed in code.
	reportContextWindow = 11
)

// hasControlChar reports whether s contains a C0 control character or DEL —
// the same shape rule validateEmoji applies to reaction emoji.
func hasControlChar(s string) bool {
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

// FileReportParams is POST /api/v1/reports' validated input.
type FileReportParams struct {
	ReporterID int64
	TargetType string
	TargetID   string
	Reason     string
	Detail     string
}

// File intakes a report: rate limit, validation, visibility (the reporter
// must be able to see the target through the same chokepoint any other
// reader would), duplicate check, then the row, the evidence snapshot and
// one audit row. The subject is derived by the server from the target — the
// message's author, the attachment's uploader, or the user — never taken
// from the body.
func (s *ReportService) File(ctx context.Context, p FileReportParams) (int64, error) {
	if s.limiter != nil && !s.limiter.Allow(auth.Key("report", p.ReporterID), 5, 10*time.Minute) {
		return 0, ErrRateLimited
	}

	if err := validateFileParams(p); err != nil {
		return 0, err
	}

	channelID, subjectID, targetRef, evidence, err := s.resolveTarget(ctx, p)
	if err != nil {
		return 0, err
	}

	if existing, err := s.st.FindOpenOrAssignedReport(ctx, p.ReporterID, p.TargetType, targetRef); err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	} else if existing > 0 {
		return 0, ErrDuplicateReport
	}

	id, err := s.st.InsertReport(ctx, p.ReporterID, subjectID, p.TargetType, targetRef, channelID, p.Reason, p.Detail)
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	for _, e := range evidence {
		if err := s.st.InsertReportEvidence(ctx, id, e.seq, e.messageID, e.authorID, e.content, e.attachmentsJSON); err != nil {
			return 0, fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}

	// Detail is the reason word only — no names, no content (AssertSafeDetails
	// and the confidentiality tests both read this).
	db.WriteAudit(context.WithoutCancel(ctx), s.st, p.ReporterID, "report_create", "report", id, p.Reason)
	return id, nil
}

func validateFileParams(p FileReportParams) error {
	switch p.TargetType {
	case TargetMessage, TargetUser, TargetAttachment:
	default:
		return fmt.Errorf("%w: invalid target_type", ErrBadRequest)
	}
	if !validReasons[p.Reason] {
		return fmt.Errorf("%w: invalid reason", ErrBadRequest)
	}
	if p.TargetID == "" {
		return fmt.Errorf("%w: target_id is required", ErrBadRequest)
	}
	if len([]rune(p.Detail)) > maxDetailRunes {
		return fmt.Errorf("%w: detail is too long", ErrBadRequest)
	}
	if hasControlChar(p.Detail) {
		return fmt.Errorf("%w: detail contains control characters", ErrBadRequest)
	}
	return nil
}

// reportEvidenceRow is one evidence row queued for insertion, seq relative
// to the reported item (0).
type reportEvidenceRow struct {
	seq             int64
	messageID       *int64
	authorID        int64
	content         string
	attachmentsJSON string
}

// evidenceAttachmentRef is the by-reference shape a snapshot's attachments
// column carries: {id, filename, mime, size} — never bytes, never
// stored_as (decision 7/scorecard Question 3 decision 3).
type evidenceAttachmentRef struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
}

func marshalAttachmentRefs(refs []evidenceAttachmentRef) string {
	if refs == nil {
		refs = []evidenceAttachmentRef{}
	}
	b, err := json.Marshal(refs)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// resolveTarget is the visibility gate and the subject/evidence derivation,
// in one pass so a message target's context window is read once. Every
// refusal is ErrNotFound: an actor without visibility of the target learns
// nothing that distinguishes "cannot see it" from "does not exist" (S5,
// report confidentiality's reciprocal — the same rule BanUser applies to a
// missing user id, applied here to a missing or unreadable target).
func (s *ReportService) resolveTarget(ctx context.Context, p FileReportParams) (channelID *int64, subjectID int64, targetRef string, evidence []reportEvidenceRow, err error) {
	switch p.TargetType {
	case TargetMessage:
		return s.resolveMessageTarget(ctx, p)
	case TargetAttachment:
		return s.resolveAttachmentTarget(ctx, p)
	case TargetUser:
		return s.resolveUserTarget(ctx, p)
	default:
		return nil, 0, "", nil, fmt.Errorf("%w: invalid target_type", ErrBadRequest)
	}
}

func (s *ReportService) resolveMessageTarget(ctx context.Context, p FileReportParams) (*int64, int64, string, []reportEvidenceRow, error) {
	messageID, perr := strconv.ParseInt(p.TargetID, 10, 64)
	if perr != nil || messageID <= 0 {
		return nil, 0, "", nil, fmt.Errorf("%w: invalid target_id", ErrBadRequest)
	}
	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil || msg == nil || msg.Deleted {
		return nil, 0, "", nil, fmt.Errorf("%w: target not found", ErrNotFound)
	}

	window, err := s.messages.GetMessagesAround(ctx, p.ReporterID, msg.ChannelID, messageID, reportContextWindow)
	if err != nil {
		// requireChannelRead answers Forbidden for a role without READ and
		// NotFound for a non-participant DM; both become NotFound here so
		// the response carries no existence oracle.
		return nil, 0, "", nil, fmt.Errorf("%w: target not visible", ErrNotFound)
	}

	centreIdx := -1
	for i := range window.Messages {
		if window.Messages[i].ID == messageID {
			centreIdx = i
			break
		}
	}
	if centreIdx < 0 {
		return nil, 0, "", nil, fmt.Errorf("%w: target not found", ErrNotFound)
	}

	evidence := make([]reportEvidenceRow, 0, len(window.Messages))
	for i := range window.Messages {
		m := &window.Messages[i]
		refs := make([]evidenceAttachmentRef, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			refs = append(refs, evidenceAttachmentRef{ID: a.ID, Filename: a.Filename, Mime: a.Mime, Size: a.Size})
		}
		mid := m.ID
		evidence = append(evidence, reportEvidenceRow{
			seq: int64(i - centreIdx), messageID: &mid, authorID: m.User.ID,
			content: m.Content, attachmentsJSON: marshalAttachmentRefs(refs),
		})
	}

	chID := msg.ChannelID
	return &chID, msg.UserID, strconv.FormatInt(messageID, 10), evidence, nil
}

func (s *ReportService) resolveAttachmentTarget(ctx context.Context, p FileReportParams) (*int64, int64, string, []reportEvidenceRow, error) {
	aa, err := s.uploads.Resolve(ctx, p.TargetID)
	if err != nil {
		return nil, 0, "", nil, fmt.Errorf("%w: target not visible", ErrNotFound)
	}
	actor, _ := s.st.GetUserByID(ctx, p.ReporterID)
	role, _ := s.perms.GetRoleForUser(ctx, p.ReporterID)
	if err := s.uploads.Authorize(ctx, aa, actor, role); err != nil {
		return nil, 0, "", nil, fmt.Errorf("%w: target not visible", ErrNotFound)
	}

	var subjectID int64
	if aa.UploaderID != nil {
		subjectID = *aa.UploaderID
	}
	ref := evidenceAttachmentRef{ID: aa.ID, Filename: aa.Filename, Mime: aa.MimeType, Size: aa.Size}

	var content string
	var authorID int64
	var chID *int64
	if aa.MessageID != nil {
		if msg, _ := s.st.GetMessage(ctx, *aa.MessageID); msg != nil {
			content = msg.Content
			authorID = msg.UserID
		}
	}
	if aa.ChannelID != nil {
		chID = aa.ChannelID
	}
	evidence := []reportEvidenceRow{{
		seq: 0, messageID: aa.MessageID, authorID: authorID, content: content,
		attachmentsJSON: marshalAttachmentRefs([]evidenceAttachmentRef{ref}),
	}}
	return chID, subjectID, aa.ID, evidence, nil
}

func (s *ReportService) resolveUserTarget(ctx context.Context, p FileReportParams) (*int64, int64, string, []reportEvidenceRow, error) {
	userID, perr := strconv.ParseInt(p.TargetID, 10, 64)
	if perr != nil || userID <= 0 || userID == p.ReporterID {
		return nil, 0, "", nil, fmt.Errorf("%w: target not found", ErrNotFound)
	}
	target, err := s.st.GetUserByID(ctx, userID)
	if err != nil || target == nil {
		return nil, 0, "", nil, fmt.Errorf("%w: target not found", ErrNotFound)
	}
	return nil, userID, strconv.FormatInt(userID, 10), nil, nil
}

// Mine returns the reporter's own reports: id, target type, reason, state,
// outcome, created_at, closed_at — never the assignee, never the notes.
func (s *ReportService) Mine(ctx context.Context, reporterID int64) ([]db.ReportSummary, error) {
	rows, err := s.st.ListReportsMine(ctx, reporterID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// requireModerate loads actorID's role and checks the canonical predicate
// (permissions.CanModerate), returning the role for a follow-up hierarchy
// check. Runs before any report lookup, so an actor without the bit sees
// Forbidden regardless of whether the report id exists.
func (s *ReportService) requireModerate(ctx context.Context, actorID int64) (*db.Role, error) {
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load role", ErrForbidden)
	}
	if err := permissions.CanModerate(permissions.Subject{RolePerms: role.Permissions}); err != nil {
		return nil, fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	}
	return role, nil
}

// guardConfidentiality is the reciprocal of requireModerate: even a bit
// holder may not read or act on a report about themselves. Indistinguishable
// from a missing id (ErrNotFound), never Forbidden — the subject must not
// learn a report about them exists at all.
func guardConfidentiality(actorID int64, report *db.Report) error {
	if report.SubjectID != 0 && report.SubjectID == actorID {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return nil
}

// Queue lists reports for the moderator view: state is "open", "assigned",
// "closed" (every terminal state), or "" for the default open+assigned
// view. A report about the caller is excluded even when it would otherwise
// match — the confidentiality rule applies to the listing too, not only to
// GET by id.
func (s *ReportService) Queue(ctx context.Context, actorID int64, state string) ([]db.ReportQueueRow, error) {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
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

// ReportDetail is GET .../queue/{id}'s payload: the report, its evidence and
// its notes.
type ReportDetail struct {
	Report   db.Report
	Evidence []db.ReportEvidenceRow
	Notes    []db.ReportNoteRow
}

// Get returns one report with its evidence and notes. 404s — never 403 —
// both for a missing id and for the caller's own report, so the two are
// indistinguishable to the subject even if they hold the bit.
func (s *ReportService) Get(ctx context.Context, actorID, reportID int64) (*ReportDetail, error) {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
		return nil, err
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return nil, err
	}
	evidence, err := s.st.ListReportEvidence(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	notes, err := s.st.ListReportNotes(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &ReportDetail{Report: *report, Evidence: evidence, Notes: notes}, nil
}

// Assign assigns reportID to actorID. 409 if it is already assigned to
// someone else, unless force is set and the caller outranks the current
// assignee (requireOutranksRole — the same rule ban/kick/timeout use).
func (s *ReportService) Assign(ctx context.Context, actorID, reportID int64, force bool) error {
	actorRole, err := s.requireModerate(ctx, actorID)
	if err != nil {
		return err
	}
	report, err := s.st.GetReport(ctx, reportID)
	if err != nil {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	if err := guardConfidentiality(actorID, report); err != nil {
		return err
	}
	if report.AssigneeID != 0 && report.AssigneeID != actorID {
		if !force {
			return fmt.Errorf("%w: already assigned", ErrConflict)
		}
		if err := s.moderation.requireOutranksRole(ctx, actorRole, report.AssigneeID); err != nil {
			return err
		}
	}
	ok, err := s.st.AssignReport(ctx, reportID, actorID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: report is no longer open", ErrConflict)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "report_assign", "report", reportID, "")
	return nil
}

// Note adds an internal note, visible to bit-22 holders only — never to
// either party, the name is the contract.
func (s *ReportService) Note(ctx context.Context, actorID, reportID int64, body string) error {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
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
	if err := s.st.InsertReportNote(ctx, reportID, actorID, body); err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	// Never the body — "note added" is the whole detail, everywhere.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "report_note", "report", reportID, "note added")
	return nil
}

// Close closes reportID with outcome "actioned", "no_action" or "duplicate",
// returning the resulting state ("resolved" or "dismissed") for the caller's
// mod_queue frame. Guarded to open/assigned states; a report already closed
// by a concurrent call answers Conflict, never a second success.
func (s *ReportService) Close(ctx context.Context, actorID, reportID int64, outcome string) (string, error) {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
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
	state := outcomeState[outcome]
	ok, err := s.st.CloseReport(ctx, reportID, state, outcome)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return "", fmt.Errorf("%w: report is already closed", ErrConflict)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "report_close", "report", reportID, outcome)
	return state, nil
}

// ErrDuplicateReport is a 409: the same reporter already has an open or
// assigned report against this exact target.
var ErrDuplicateReport = fmt.Errorf("%w: a report for this target is already open or assigned", ErrConflict)
