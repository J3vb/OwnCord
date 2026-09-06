package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
//
// Report ids returned and accepted by this type's methods are the INTERNAL
// sequential id — used for foreign keys, audit target_id, and everywhere
// inside the server. The externally-visible identifier is db.Report.PublicID
// (Codex review, P2-9): every API response, route parameter and mod_queue
// frame carries that instead, resolved to/from the internal id at the
// api/ws boundary (ResolveReportID, PublicIDFor) so a sequential id is never
// exposed for a bit holder to infer a neighbouring report's existence from.
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

// newPublicID mints the opaque, unguessable identifier every report is
// known by outside this package: 16 bytes from crypto/rand, hex-encoded
// (32 chars). Sequential ids leak order (P2-9); this does not.
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

// File intakes a report: rate limit, validation, visibility (the reporter
// must be able to see the target through the same chokepoint any other
// reader would), duplicate check, then the row, the evidence snapshot and
// one audit row — the row and its snapshot in one transaction (P1-4), so an
// erasure racing the intake cannot land content or an author id that
// EraseAccount's unlink pass already ran over. The subject is derived by
// the server from the target — the message's author, the attachment's
// uploader, or the user — never taken from the body. Returns the internal
// id (for this package's own use); PublicIDFor resolves the id an API
// response or a mod_queue frame is allowed to carry.
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

	// The fast path: saves building the evidence snapshot's already-resolved
	// window on the common, non-racing duplicate. idx_reports_active_unique
	// (migration 048) is what actually enforces this under concurrency —
	// see the FileReport error mapping below.
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
			// The reporter or subject was erased between resolveTarget's read
			// and this transaction's commit (Codex review, P1-4 widened) — the
			// same refusal a target that never existed gets, no existence
			// oracle for this vanishingly rare race either.
			return 0, errTargetNotFound
		}
		return 0, fmt.Errorf("%w: %w", ErrInternal, err)
	}

	// The opening report_events row is written inside FileReport's own
	// transaction (db/report_queries.go), not here — a second Codex review
	// moved every report lifecycle event off the shared audit_log entirely
	// (see report_events, migration 048 (12)): a VIEW_AUDIT_LOG holder who
	// lacks MODERATE_MEMBERS could still read a system-actor report_create
	// row's timestamp and reason there, and one who is ALSO the report's
	// subject could diff it against the queue they separately cannot see.
	// report_events is exposed nowhere except inside one report's own queue
	// detail (Get, gated exactly like the rest of it), so that channel no
	// longer exists at all.
	return id, nil
}

// PublicIDFor resolves id's public identifier. Not permission-gated: the
// public id is the credential a caller uses to reference one report, and
// resolving an id the caller already holds (their own File result, or a
// report they are about to be told to look up) discloses nothing new.
func (s *ReportService) PublicIDFor(ctx context.Context, id int64) (string, error) {
	r, err := s.st.GetReport(ctx, id)
	if err != nil {
		return "", fmt.Errorf("%w: report not found", ErrNotFound)
	}
	return r.PublicID, nil
}

// ResolveReportID translates a public id — the only identifier a route
// parameter ever carries — to the internal sequential id every other method
// on this type takes. 404s on an unknown public id.
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
// refusal is ErrNotFound with the SAME message ("target not found"),
// whether the target does not exist or the reporter cannot see it — a
// distinguishable message would itself be an existence oracle (P2-5): an
// actor without visibility learns nothing that tells "cannot see it" apart
// from "does not exist" (S5, report confidentiality's reciprocal — the same
// rule BanUser applies to a missing user id, applied here to a missing or
// unreadable target).
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

// errTargetNotFound is resolveTarget's one refusal message (P2-5): every
// branch of every resolve* function returns exactly this text, wrapping
// ErrNotFound, so the response body cannot distinguish "does not exist"
// from "exists but you may not see it".
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
		// requireChannelRead answers Forbidden for a role without READ and
		// NotFound for a non-participant DM; both become the same
		// errTargetNotFound here so the response carries no existence oracle.
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
	role, _ := s.perms.GetRoleForUser(ctx, p.ReporterID)
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

// Mine returns the reporter's own reports: id, target type, reason, state,
// outcome, created_at, closed_at — never the assignee, never the notes.
func (s *ReportService) Mine(ctx context.Context, reporterID int64) ([]db.ReportSummary, error) {
	rows, err := s.st.ListReportsMine(ctx, reporterID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// RequireModerate is requireModerate exported for a caller that must
// authorize BEFORE resolving anything else about the request — a route
// handler that translates a public id to the internal one, in particular
// (Codex review, P1): running that resolution first turns "unknown id" vs
// "real id, no permission" into two different status codes, an existence
// oracle through the handler's own order of operations. Call this before
// resolveReportIDParam, not after.
func (s *ReportService) RequireModerate(ctx context.Context, actorID int64) error {
	_, err := s.requireModerate(ctx, actorID)
	return err
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

// ErrSelfReview is a 403: a moderator may not act on, or read the internal
// notes of, a report they themselves filed. Named for reuse (B5-10 appeals
// hit the identical shape: the moderator who acted does not decide the
// appeal of their own action).
var ErrSelfReview = fmt.Errorf("%w: cannot act on your own report", ErrForbidden)

// guardSelfReview refuses a moderator acting on their own filed report —
// unlike guardConfidentiality, this is Forbidden, not NotFound: a reporter
// already knows their own report exists (it is in their Mine() view), so
// there is no existence oracle to protect against here, only the conflict
// of interest.
func guardSelfReview(actorID int64, report *db.Report) error {
	if report.ReporterID != 0 && report.ReporterID == actorID {
		return ErrSelfReview
	}
	return nil
}

// GuardSelfReviewFor exports guardSelfReview for a caller outside this
// package that already holds a *db.Report from another entry point (the
// queue's act route, from Get, P2-6 Codex review) and must apply the same
// self-review refusal before dispatching an action: Get allows a reporter to
// read their own filing, but acting on it is the identical conflict of
// interest Assign/Note/Close already refuse.
func GuardSelfReviewFor(actorID int64, report *db.Report) error {
	return guardSelfReview(actorID, report)
}

// VisibleReportPublicID resolves reportID's public id for viewerID, applying
// the same confidentiality guard Get uses (guardConfidentiality): the
// viewer's own report as SUBJECT never surfaces its id, even from a surface
// that already authorized the read on other grounds — a moderator who still
// holds MODERATE_MEMBERS reading their own moderation-action ledger, in
// particular (P1-5, Codex review: GET .../users/{id}/actions and the queue
// detail's action list both render a linked report's public id with no
// per-row check of their own). false also covers a report id that no longer
// resolves — a lookup failure is not itself a leak, so the caller renders
// the field absent rather than surfacing an internal error.
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

// ReportDetail is GET .../queue/{id}'s payload: the report, its evidence,
// its notes and its immutable history (report_events — second Codex
// review).
type ReportDetail struct {
	Report   db.Report
	Evidence []db.ReportEvidenceRow
	Notes    []db.ReportNoteRow
	Events   []db.ReportEvent
}

// Get returns one report with its evidence, notes and history. 404s — never
// 403 — both for a missing id and for the caller's own report as its
// SUBJECT, so the two are indistinguishable even if the subject holds the
// bit. A moderator who is the report's REPORTER may read it (it is their own
// filing, already visible via Mine()) but never its internal notes: Notes
// is always empty for them, and they may not act on it (guardSelfReview,
// Assign/Note/Close). report_events is exposed here and nowhere else — the
// same bit-plus-confidentiality gate this method already runs, no new one.
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
	events, err := s.st.ListReportEvents(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if report.ReporterID != 0 && report.ReporterID == actorID {
		return &ReportDetail{Report: *report, Evidence: evidence, Events: events}, nil
	}
	notes, err := s.st.ListReportNotes(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &ReportDetail{Report: *report, Evidence: evidence, Notes: notes, Events: events}, nil
}

// Assign assigns reportID to actorID. 409 if it is already assigned to
// someone else, unless force is set and the caller outranks the current
// assignee (the same rule ban/kick/timeout use). The plain write is guarded
// on the observed assignee (P2-8): a concurrent reassignment invalidates a
// stale verdict, so it can never be applied. The force path's outrank
// comparison runs INSIDE the same transaction as the write (Codex review,
// AssignReportForced): reading the assignee's role and writing the new one
// as two separate statements left a gap a role change could race; zero rows
// (or ErrForbidden, force only) covers a state that already left
// open/assigned, a moderator erased between requirePerm and the write, and
// (force only) failing to outrank, all as 409 except the last, which is 403.
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
	if err := guardSelfReview(actorID, report); err != nil {
		return err
	}
	observed := report.AssigneeID
	if observed != 0 && observed != actorID {
		if !force {
			return fmt.Errorf("%w: already assigned", ErrConflict)
		}
		ok, err := s.st.AssignReportForced(ctx, reportID, actorID, observed, int64(actorRole.Position))
		if err != nil {
			if errors.Is(err, db.ErrForbidden) {
				return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
			}
			return fmt.Errorf("%w: %w", ErrInternal, err)
		}
		if !ok {
			return fmt.Errorf("%w: report is no longer open", ErrConflict)
		}
		s.logReportEvent(ctx, reportID, actorID, "assigned", "")
		return nil
	}
	ok, err := s.st.AssignReport(ctx, reportID, actorID, observed)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: report is no longer open", ErrConflict)
	}
	s.logReportEvent(ctx, reportID, actorID, "assigned", "")
	return nil
}

// Note adds an internal note, visible to bit-22 holders only — never to
// either party (the reporter cannot read it either — guardSelfReview — and
// the subject cannot see the report at all), the name is the contract.
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
	if err := guardSelfReview(actorID, report); err != nil {
		return err
	}
	ok, err := s.st.InsertReportNote(ctx, reportID, actorID, body)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		// Zero rows now covers two causes (Codex review widened the guard to
		// the report's state too): the moderator account was erased, or the
		// report closed, between requirePerm's read and this write.
		return fmt.Errorf("%w: report is closed, or the moderator account no longer exists", ErrConflict)
	}
	// Never the body — action alone is the whole detail, everywhere.
	s.logReportEvent(ctx, reportID, actorID, "noted", "")
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
	if err := guardSelfReview(actorID, report); err != nil {
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
	s.logReportEvent(ctx, reportID, actorID, "closed", outcome)
	return state, nil
}

// ErrDuplicateReport is a 409: the same reporter already has an open or
// assigned report against this exact target.
var ErrDuplicateReport = fmt.Errorf("%w: a report for this target is already open or assigned", ErrConflict)

// logReportEvent appends one report_events row (second Codex review), never
// the shared audit_log. detail is the state or outcome word only — never
// free text, the same rule report_notes.body is exempt from. A write
// failure is logged and swallowed, the same fire-and-forget contract
// db.WriteAudit gives every other caller in this package: the mutation
// itself already succeeded, and a lost history row is not worth failing the
// caller's request over.
func (s *ReportService) logReportEvent(ctx context.Context, reportID, actorID int64, action, detail string) {
	if err := s.st.InsertReportEvent(context.WithoutCancel(ctx), reportID, actorID, action, detail); err != nil {
		slog.Warn("report event not recorded", "report_id", reportID, "action", action, "error", err)
	}
}
