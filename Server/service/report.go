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
	// links is the batched report-link read; nil (a store without it) resolves
	// each link with its own GetReport.
	links ReportLinkStore
}

// ReportLinkStore is the slice of the database VisibleReportPublicIDs reads
// beyond Store: many report links in one query. *db.DB satisfies it; declared
// here so Store, whose size is pinned, does not grow.
type ReportLinkStore interface {
	ListReportLinks(ctx context.Context, ids []int64) (map[int64]db.ReportLink, error)
}

var _ ReportLinkStore = (*db.DB)(nil)

// NewReportService creates a ReportService.
func NewReportService(st reportStore, perms *PermissionService, messages *MessageService, uploads *UploadService, moderation *ModerationService, limiter *auth.RateLimiter) *ReportService {
	links, _ := st.(ReportLinkStore)
	return &ReportService{st: st, perms: perms, messages: messages, uploads: uploads, moderation: moderation, limiter: limiter, links: links}
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

// isReportSubject is the confidentiality predicate itself, shared by the
// single and the batched lookups so they cannot drift.
func isReportSubject(actorID, subjectID int64) bool {
	return subjectID != 0 && subjectID == actorID
}

// VisibleReportPublicIDs is VisibleReportPublicID for a whole list, in one
// read: it maps each resolvable report id to its public id, leaving out ids
// that no longer resolve and reports about the viewer. A failed read hides
// every link, as a failed single lookup hides its one.
func (s *ReportService) VisibleReportPublicIDs(ctx context.Context, viewerID int64, reportIDs []int64) map[int64]string {
	out := make(map[int64]string, len(reportIDs))
	if len(reportIDs) == 0 {
		return out
	}
	if s.links == nil {
		for _, id := range reportIDs {
			if pub, ok := s.VisibleReportPublicID(ctx, viewerID, id); ok {
				out[id] = pub
			}
		}
		return out
	}
	links, err := s.links.ListReportLinks(ctx, reportIDs)
	if err != nil {
		return out
	}
	for id, link := range links {
		if isReportSubject(viewerID, link.SubjectID) {
			continue
		}
		out[id] = link.PublicID
	}
	return out
}

// ErrDuplicateReport is a 409: the reporter already has an open or assigned
// report against this exact target.
var ErrDuplicateReport = fmt.Errorf("%w: a report for this target is already open or assigned", ErrConflict)
