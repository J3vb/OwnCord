package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// reportStore is what ReportService reads and writes. *db.DB satisfies it.
type reportStore interface {
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
	// FileReport inserts the report row and its evidence snapshot in one writer
	// transaction, leaving no autocommit window for an erasure to land content or an
	// author id mid-intake. The caller generates publicID (crypto/rand).
	FileReport(ctx context.Context, publicID string, reporterID, subjectID int64, targetType, targetRef string, channelID *int64, reason, detail string, evidence []db.ReportEvidenceInput) (int64, error)
	GetReport(ctx context.Context, id int64) (*db.Report, error)
	GetReportByPublicID(ctx context.Context, publicID string) (*db.Report, error)
	FindOpenOrAssignedReport(ctx context.Context, reporterID int64, targetType, targetRef string) (int64, error)
	ListReportsQueue(ctx context.Context, state string) ([]db.ReportQueueRow, error)
	ListReportsMine(ctx context.Context, reporterID int64) ([]db.ReportSummary, error)
	// AssignReport is guarded on state, the caller's last-observed assignee
	// (optimistic concurrency) and EXISTS(users).
	AssignReport(ctx context.Context, id, assigneeID, observedAssigneeID int64) (bool, error)
	// AssignReportForced is the force-reassign path: BOTH principals' role positions
	// are read fresh inside the write's transaction. ErrForbidden means the caller
	// does not outrank the current assignee.
	AssignReportForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64) (bool, error)
	CloseReport(ctx context.Context, id int64, state, outcome string, actorID int64) (bool, error)
	ListReportEvidence(ctx context.Context, reportID int64) ([]db.ReportEvidenceRow, error)
	// InsertReportNote is guarded on EXISTS(users) and the report's state; false
	// means 409: the author was erased, or the report closed, before the write.
	InsertReportNote(ctx context.Context, reportID, authorID int64, body string) (bool, error)
	ListReportNotes(ctx context.Context, reportID int64) ([]db.ReportNoteRow, error)
	// ListReportEvents reads report_events, this feature's own immutable history
	// (never the shared audit_log), exposed only inside the queue detail. The
	// mutations above write their event in the same transaction.
	ListReportEvents(ctx context.Context, reportID int64) ([]db.ReportEvent, error)
	PruneReportContentOlderThan(ctx context.Context, cutoff string) (int64, error)
}

// ReportService is the local report intake and moderator queue: the report row,
// the immutable evidence snapshot taken at file time, assignment/status/notes
// and the reporter's status view. Every write is audited with the actor tokens
// db/erasure.go's erasureUnlinkReports writes. Ids on its methods are the
// INTERNAL sequential id; every API response, route parameter and mod_queue frame
// carries db.Report.PublicID, resolved at the api/ws boundary (ResolveReportID,
// PublicIDFor) so a sequential id never lets a bit holder infer a neighbouring
// report.
type ReportService struct {
	st       reportStore
	perms    *PermissionService
	messages *MessageService
	uploads  *UploadService
	// moderation is reused for its outrank check only (requireOutranksRole): the
	// force-reassign path needs the same hierarchy rule as ban/kick/timeout.
	moderation *ModerationService
	limiter    *auth.RateLimiter
}

// NewReportService creates a ReportService.
func NewReportService(st reportStore, perms *PermissionService, messages *MessageService, uploads *UploadService, moderation *ModerationService, limiter *auth.RateLimiter) *ReportService {
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

// outcomeState maps the moderator's outcome to the queue's terminal state:
// "actioned" is resolved (real content, addressed); "no_action" and "duplicate"
// are dismissed (nothing to enforce, or covered elsewhere).
var outcomeState = map[string]string{
	"actioned":  "resolved",
	"no_action": "dismissed",
	"duplicate": "dismissed",
}

// maxDetailRunes and maxNoteRunes bound the free text against storage exhaustion.
const (
	maxDetailRunes = 2000
	maxNoteRunes   = 4000
	// reportContextWindow is 5 rows either side plus the reported item: 11, fixed.
	reportContextWindow = 11
)

// hasControlChar reports whether s contains a C0 control character or DEL, the
// shape rule validateEmoji applies to reaction emoji.
func hasControlChar(s string) bool {
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

// newPublicID mints the opaque id reports are known by outside this package: 16
// crypto/rand bytes, hex (32 chars). Sequential ids leak order.
func newPublicID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("newPublicID: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// FileReportParams is POST /api/v1/reports' validated input.
type FileReportParams struct {
	ReporterID int64
	TargetType string
	TargetID   string
	Reason     string
	Detail     string
}

// File intakes a report: rate limit, validation, visibility (the reporter must
// see the target through the same chokepoint any reader would), duplicate check,
// then the row, evidence snapshot and one audit row. The row and snapshot share a
// transaction so an erasure racing the intake cannot land content or an author id
// that EraseAccount's unlink pass already ran over. The subject comes from the
// target (message author, attachment uploader, or the user), never the body.
// Returns the internal id; PublicIDFor resolves what an API response may carry.
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

	// Fast path for the common duplicate; idx_reports_active_unique (migration 048)
	// enforces it under concurrency (see the FileReport error mapping below).
	if existing, err := s.st.FindOpenOrAssignedReport(ctx, p.ReporterID, p.TargetType, targetRef); err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	} else if existing > 0 {
		return 0, ErrDuplicateReport
	}

	publicID, err := newPublicID()
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}

	dbEvidence := make([]db.ReportEvidenceInput, 0, len(evidence))
	for _, e := range evidence {
		dbEvidence = append(dbEvidence, db.ReportEvidenceInput{
			Seq: e.seq, MessageID: e.messageID, AuthorID: e.authorID,
			Content: e.content, AttachmentsJSON: e.attachmentsJSON,
		})
	}
	id, err := s.st.FileReport(ctx, publicID, p.ReporterID, subjectID, p.TargetType, targetRef, channelID, p.Reason, p.Detail, dbEvidence)
	if err != nil {
		if errors.Is(err, db.ErrConflict) {
			return 0, ErrDuplicateReport
		}
		if errors.Is(err, db.ErrNotFound) {
			// The reporter or subject was erased after resolveTarget's read: the same
			// refusal as a target that never existed, no existence oracle.
			return 0, errTargetNotFound
		}
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}

	// The opening report_events row is written inside FileReport's transaction
	// (db/report_queries.go), keeping report lifecycle events off the shared
	// audit_log: a VIEW_AUDIT_LOG holder lacking MODERATE_MEMBERS could read a
	// system-actor report_create row's timestamp and reason there, and the report's
	// own subject could diff it against the queue they cannot see. report_events is
	// exposed only inside one report's queue detail (Get, gated like the rest).
	return id, nil
}

// PublicIDFor resolves id's public identifier. Not permission-gated: resolving an
// id the caller already holds (their File result, or one they are told to look
// up) discloses nothing new.
func (s *ReportService) PublicIDFor(ctx context.Context, id int64) (string, error) {
	r, err := s.st.GetReport(ctx, id)
	if err != nil {
		return "", fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return r.PublicID, nil
}

// ResolveReportID translates a public id (the only identifier a route carries) to
// the internal id; 404 on an unknown one.
func (s *ReportService) ResolveReportID(ctx context.Context, publicID string) (int64, error) {
	r, err := s.st.GetReportByPublicID(ctx, publicID)
	if err != nil {
		return 0, fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return r.ID, nil
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

// reportEvidenceRow is one evidence row queued for insertion; seq is relative to
// the reported item (0).
type reportEvidenceRow struct {
	seq             int64
	messageID       *int64
	authorID        int64
	content         string
	attachmentsJSON string
}

// evidenceAttachmentRef is the by-reference shape of a snapshot's attachments
// column: {id, filename, mime, size}, never bytes or stored_as.
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

// resolveTarget is the visibility gate and subject/evidence derivation in one
// pass, so a message target's context window is read once. Every refusal is
// ErrNotFound with the SAME message: a distinguishable one would be an existence
// oracle telling "cannot see it" from "does not exist" (the rule BanUser applies
// to a missing user id).
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

// errTargetNotFound is resolveTarget's one refusal: every branch returns exactly
// this text so the body cannot tell "does not exist" from "may not see it".
var errTargetNotFound = fmt.Errorf("%w: target not found", ErrNotFound)

func (s *ReportService) resolveMessageTarget(ctx context.Context, p FileReportParams) (*int64, int64, string, []reportEvidenceRow, error) {
	messageID, perr := strconv.ParseInt(p.TargetID, 10, 64)
	if perr != nil || messageID <= 0 {
		return nil, 0, "", nil, fmt.Errorf("%w: invalid target_id", ErrBadRequest)
	}
	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil || msg == nil || msg.Deleted {
		return nil, 0, "", nil, errTargetNotFound
	}

	window, err := s.messages.GetMessagesAround(ctx, p.ReporterID, msg.ChannelID, messageID, reportContextWindow)
	if err != nil {
		// requireChannelRead answers Forbidden (no READ) or NotFound (non-participant
		// DM); both become errTargetNotFound.
		return nil, 0, "", nil, errTargetNotFound
	}

	centreIdx := -1
	for i := range window.Messages {
		if window.Messages[i].ID == messageID {
			centreIdx = i
			break
		}
	}
	if centreIdx < 0 {
		return nil, 0, "", nil, errTargetNotFound
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
		return nil, 0, "", nil, errTargetNotFound
	}
	actor, _ := s.st.GetUserByID(ctx, p.ReporterID)
	var role *db.Role
	if held, _ := s.perms.GetRoleForUser(ctx, p.ReporterID); held != nil {
		role = held.Effective()
	}
	if err := s.uploads.Authorize(ctx, aa, actor, role); err != nil {
		return nil, 0, "", nil, errTargetNotFound
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
		return nil, 0, "", nil, errTargetNotFound
	}
	target, err := s.st.GetUserByID(ctx, userID)
	if err != nil || target == nil {
		return nil, 0, "", nil, errTargetNotFound
	}
	return nil, userID, strconv.FormatInt(userID, 10), nil, nil
}

// Mine returns the reporter's own reports (id, target type, reason, state,
// outcome, timestamps), never the assignee or notes.
func (s *ReportService) Mine(ctx context.Context, reporterID int64) ([]db.ReportSummary, error) {
	rows, err := s.st.ListReportsMine(ctx, reporterID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// RequireModerate is requireModerate exported for a handler that must authorize
// BEFORE resolving anything else: resolving a public id first would make
// "unknown id" and "real id, no permission" different status codes, an existence
// oracle. Call it before resolveReportIDParam.
func (s *ReportService) RequireModerate(ctx context.Context, actorID int64) error {
	return requireModerate(ctx, s.perms, actorID)
}

// requireModerate loads actorID's role and checks permissions.CanModerate. It
// runs before any report or appeal lookup, so an actor without the bit sees
// Forbidden whether or not the id exists. It returns no role: force-reassign reads
// the actor's position fresh inside its write transaction (forceReassignGuarded).
// Package-level because ReportService and AppealService need the identical check;
// one predicate per security property cannot drift.
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

// guardConfidentiality is the reciprocal of requireModerate: even a bit holder
// may not read or act on a report about themselves. ErrNotFound, never Forbidden,
// so the subject cannot learn a report about them exists.
func guardConfidentiality(actorID int64, report *db.Report) error {
	if report.SubjectID != 0 && report.SubjectID == actorID {
		return fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return nil
}

// ErrSelfReview is a 403: a moderator may not act on, or read the notes of, a
// report they filed. Reused by appeals (the acting moderator does not decide the
// appeal of their own action).
var ErrSelfReview = fmt.Errorf("%w: cannot act on your own report", ErrForbidden)

// GuardSelfReviewFor refuses a moderator acting on their own filed report.
// Unlike guardConfidentiality it is Forbidden: a reporter knows their report
// exists (it is in Mine()), so only the conflict of interest remains. Exported for
// the queue's act route, which holds a *db.Report from Get: reading one's own
// filing is allowed, acting on it is the conflict Assign/Note/Close refuse.
func GuardSelfReviewFor(actorID int64, report *db.Report) error {
	if report.ReporterID != 0 && report.ReporterID == actorID {
		return ErrSelfReview
	}
	return nil
}

// VisibleReportPublicID resolves reportID's public id for viewerID under the
// same guard as Get: a report about the viewer never surfaces its id, even from a
// surface authorized on other grounds (a moderator reading their own action
// ledger, or the queue detail's action list, which check no per-row guard).
// false also covers an id that no longer resolves; the caller omits the field.
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

// Queue lists reports for the moderator view: state is "open", "assigned",
// "closed" (every terminal state) or "" for open+assigned. A report about the
// caller is excluded: confidentiality covers the listing too.
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
	// EvidenceWithheld is empty when Evidence is readable, else why it is empty:
	// EvidenceNSFWAcknowledgementRequired or EvidenceSourceChannelUnavailable.
	EvidenceWithheld string
}

// Get returns one report with evidence, notes and history. 404, never 403, for a
// missing id and for the caller's own report as SUBJECT, so they are
// indistinguishable. A moderator who is the REPORTER may read it but never its
// notes (Notes is empty), and may not act on it (GuardSelfReviewFor).
// report_events is exposed here and nowhere else.
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

// Assign assigns reportID to actorID. 409 if already assigned to someone else,
// unless force is set and the caller outranks the assignee (as ban/kick/timeout).
// The plain write is guarded on the observed assignee, so a concurrent
// reassignment invalidates a stale verdict. The force path's outrank comparison
// runs INSIDE the write's transaction (AssignReportForced), since separate
// statements left a gap a role change could race. Zero rows covers a state that
// left open/assigned or an erased moderator (409); failing to outrank is 403.
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

// Note adds an internal note visible to MODERATE_MEMBERS holders only: neither
// the reporter (GuardSelfReviewFor) nor the subject (cannot see the report) reads
// it.
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
		// Zero rows means the moderator account was erased, or the report closed,
		// between requirePerm's read and this write.
		return fmt.Errorf("%w: report is closed, or the moderator account no longer exists", ErrConflict)
	}
	return nil
}

// Close closes reportID with outcome "actioned", "no_action" or "duplicate" and
// returns the state ("resolved" or "dismissed") for the mod_queue frame. Guarded
// to open/assigned; a report closed concurrently answers Conflict.
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

// ErrDuplicateReport is a 409: the reporter already has an open or assigned
// report against this exact target.
var ErrDuplicateReport = fmt.Errorf("%w: a report for this target is already open or assigned", ErrConflict)
