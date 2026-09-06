package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// moderationQueueRowResponse is one row of GET /api/v1/moderation/queue. ID
// is the PUBLIC id (P2-9) — the sequential internal id never reaches a
// response, a route parameter or the mod_queue frame.
type moderationQueueRowResponse struct {
	ID           string  `json:"id"`
	ReporterName string  `json:"reporter_name"`
	SubjectName  string  `json:"subject_name"`
	TargetType   string  `json:"target_type"`
	TargetRef    string  `json:"target_ref"`
	ChannelID    *int64  `json:"channel_id,omitempty"`
	Reason       string  `json:"reason"`
	State        string  `json:"state"`
	AssigneeID   int64   `json:"assignee_id"`
	Outcome      string  `json:"outcome"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	ClosedAt     *string `json:"closed_at,omitempty"`
}

// moderationEvidenceResponse is one row of a report's evidence snapshot.
type moderationEvidenceResponse struct {
	Seq         int64  `json:"seq"`
	AuthorID    int64  `json:"author_id"`
	Content     string `json:"content"`
	Attachments string `json:"attachments"`
	CapturedAt  string `json:"captured_at"`
}

// moderationNoteResponse is one internal note.
type moderationNoteResponse struct {
	ID        int64  `json:"id"`
	AuthorID  int64  `json:"author_id"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// moderationEventResponse is one row of report_events (second Codex review):
// this feature's own immutable history, never the shared audit_log.
type moderationEventResponse struct {
	ActorID   int64  `json:"actor_id"`
	Action    string `json:"action"`
	Detail    string `json:"detail"`
	CreatedAt string `json:"created_at"`
}

// moderationReportDetailResponse is GET /api/v1/moderation/queue/{id}. ID is
// the PUBLIC id (P2-9).
type moderationReportDetailResponse struct {
	ID         string                       `json:"id"`
	ReporterID int64                        `json:"reporter_id"`
	SubjectID  int64                        `json:"subject_id"`
	TargetType string                       `json:"target_type"`
	TargetRef  string                       `json:"target_ref"`
	ChannelID  *int64                       `json:"channel_id,omitempty"`
	Reason     string                       `json:"reason"`
	Detail     string                       `json:"detail"`
	State      string                       `json:"state"`
	AssigneeID int64                        `json:"assignee_id"`
	Outcome    string                       `json:"outcome"`
	CreatedAt  string                       `json:"created_at"`
	UpdatedAt  string                       `json:"updated_at"`
	ClosedAt   *string                      `json:"closed_at,omitempty"`
	Evidence   []moderationEvidenceResponse `json:"evidence"`
	Notes      []moderationNoteResponse     `json:"notes"`
	Events     []moderationEventResponse    `json:"events"`
	// Actions is the immutable history of moderator actions taken against
	// this report (plan item 7).
	Actions []moderationActionResponse `json:"actions"`
}

type addNoteRequest struct {
	Body string `json:"body"`
}

type closeReportRequest struct {
	Outcome string `json:"outcome"`
}

// actOnReportRequest is POST /api/v1/moderation/queue/{id}/act's body (plan
// item 7). MessageID is required for kind="removal" unless the report's own
// target is a message, in which case it defaults to that message.
type actOnReportRequest struct {
	Kind            string `json:"kind"`
	Reason          string `json:"reason"`
	DurationSeconds int64  `json:"duration_seconds,omitempty"`
	MessageID       string `json:"message_id,omitempty"`
}

// MountModerationQueueRoutes registers the moderator queue: read, assign,
// note, close. Authorization is enforced inside ReportService (CanModerate,
// the canonical predicate) so these handlers carry no permission check of
// their own. The {id} route parameter is the PUBLIC id (P2-9); every
// handler resolves it to the internal id via ResolveReportID before calling
// into ReportService.
func MountModerationQueueRoutes(r chi.Router, svc *service.Services, hub ModQueueBroadcaster) {
	r.Route("/api/v1/moderation/queue", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleModerationQueueList(svc))
		r.Get("/{id}", handleModerationQueueGet(svc))
		r.Post("/{id}/assign", handleModerationQueueAssign(svc, hub))
		r.Post("/{id}/notes", handleModerationQueueNote(svc))
		r.Post("/{id}/close", handleModerationQueueClose(svc, hub))
		r.Post("/{id}/act", handleModerationQueueAct(svc))
	})
}

func currentUserID(r *http.Request) (int64, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		return 0, false
	}
	return user.ID, true
}

// resolveReportIDParam reads the {id} route parameter (the report's PUBLIC
// id) and resolves it to the internal id ReportService's methods take.
// Writes the response and returns ok=false on any failure. Callers MUST run
// requireModerateOrWrite first (P1, Codex review): resolving a route
// parameter before checking authorization turns "unknown id" (404) and
// "real id, no permission" (403) into an existence oracle through the
// handler's own order of operations, even though every ReportService method
// itself checks CanModerate before touching a report.
func resolveReportIDParam(w http.ResponseWriter, r *http.Request, svc *service.Services) (int64, bool) {
	publicID := chi.URLParam(r, "id")
	id, err := svc.Reports.ResolveReportID(r.Context(), publicID)
	if err != nil {
		writeReportServiceError(r.Context(), w, err)
		return 0, false
	}
	return id, true
}

// requireModerateOrWrite is authorization-before-existence's front door: the
// permission check every route below the queue index needs, run before the
// route's {id} is ever resolved.
func requireModerateOrWrite(w http.ResponseWriter, r *http.Request, svc *service.Services, actorID int64) bool {
	if err := svc.Reports.RequireModerate(r.Context(), actorID); err != nil {
		writeReportServiceError(r.Context(), w, err)
		return false
	}
	return true
}

func handleModerationQueueList(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		rows, err := svc.Reports.Queue(r.Context(), actorID, r.URL.Query().Get("state"))
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		resp := make([]moderationQueueRowResponse, 0, len(rows))
		for i := range rows {
			row := &rows[i]
			resp = append(resp, moderationQueueRowResponse{
				ID: row.PublicID, ReporterName: row.ReporterName, SubjectName: row.SubjectName,
				TargetType: row.TargetType, TargetRef: row.TargetRef, ChannelID: row.ChannelID,
				Reason: row.Reason, State: row.State, AssigneeID: row.AssigneeID, Outcome: row.Outcome,
				CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, ClosedAt: row.ClosedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func handleModerationQueueGet(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		if !requireModerateOrWrite(w, r, svc, actorID) {
			return
		}
		id, ok := resolveReportIDParam(w, r, svc)
		if !ok {
			return
		}
		detail, err := svc.Reports.Get(r.Context(), actorID, id)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		evidence := make([]moderationEvidenceResponse, 0, len(detail.Evidence))
		for _, e := range detail.Evidence {
			evidence = append(evidence, moderationEvidenceResponse{
				Seq: e.Seq, AuthorID: e.AuthorID, Content: e.Content,
				Attachments: e.Attachments, CapturedAt: e.CapturedAt,
			})
		}
		notes := make([]moderationNoteResponse, 0, len(detail.Notes))
		for _, n := range detail.Notes {
			notes = append(notes, moderationNoteResponse{ID: n.ID, AuthorID: n.AuthorID, Body: n.Body, CreatedAt: n.CreatedAt})
		}
		events := make([]moderationEventResponse, 0, len(detail.Events))
		for _, e := range detail.Events {
			events = append(events, moderationEventResponse{ActorID: e.ActorID, Action: e.Action, Detail: e.Detail, CreatedAt: e.CreatedAt})
		}
		actionRows, err := svc.Moderation.ListActionsForReport(r.Context(), id)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, moderationReportDetailResponse{
			ID: detail.Report.PublicID, ReporterID: detail.Report.ReporterID, SubjectID: detail.Report.SubjectID,
			TargetType: detail.Report.TargetType, TargetRef: detail.Report.TargetRef, ChannelID: detail.Report.ChannelID,
			Reason: detail.Report.Reason, Detail: detail.Report.Detail, State: detail.Report.State,
			AssigneeID: detail.Report.AssigneeID, Outcome: detail.Report.Outcome,
			CreatedAt: detail.Report.CreatedAt, UpdatedAt: detail.Report.UpdatedAt, ClosedAt: detail.Report.ClosedAt,
			Evidence: evidence, Notes: notes, Events: events,
			Actions: moderationActionResponses(r.Context(), svc, actionRows),
		})
	}
}

// handleModerationQueueAct performs a moderator action against a report's
// subject (or its reported message, for removal), with report_id set (plan
// item 7). svc.Reports.Get both authorizes the read (MODERATE_MEMBERS,
// confidentiality, self-review) and resolves the subject/target this
// dispatches against.
func handleModerationQueueAct(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		if !requireModerateOrWrite(w, r, svc, actorID) {
			return
		}
		id, ok := resolveReportIDParam(w, r, svc)
		if !ok {
			return
		}
		var req actOnReportRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		detail, err := svc.Reports.Get(r.Context(), actorID, id)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		params := service.ActOnReportParams{
			ActorID: actorID, Kind: req.Kind, Reason: req.Reason,
			DurationSeconds: req.DurationSeconds, TargetID: detail.Report.SubjectID, ReportID: id,
		}
		if req.Kind == "removal" {
			msgIDStr := req.MessageID
			if msgIDStr == "" && detail.Report.TargetType == service.TargetMessage {
				msgIDStr = detail.Report.TargetRef
			}
			msgID, perr := strconv.ParseInt(msgIDStr, 10, 64)
			if perr != nil || msgID <= 0 {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "BAD_REQUEST", Message: "message_id is required for removal"})
				return
			}
			params.MessageID = msgID
		}
		if err := svc.Moderation.ActOnReport(r.Context(), params); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleModerationQueueAssign(svc *service.Services, hub ModQueueBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		if !requireModerateOrWrite(w, r, svc, actorID) {
			return
		}
		id, ok := resolveReportIDParam(w, r, svc)
		if !ok {
			return
		}
		force := r.URL.Query().Get("force") == "1"
		if err := svc.Reports.Assign(r.Context(), actorID, id, force); err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		if hub != nil {
			hub.BroadcastModQueue(context.WithoutCancel(r.Context()), id, "assigned")
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleModerationQueueNote(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		if !requireModerateOrWrite(w, r, svc, actorID) {
			return
		}
		id, ok := resolveReportIDParam(w, r, svc)
		if !ok {
			return
		}
		var req addNoteRequest
		r.Body = http.MaxBytesReader(w, r.Body, 16384)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		if err := svc.Reports.Note(r.Context(), actorID, id, req.Body); err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleModerationQueueClose(svc *service.Services, hub ModQueueBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		if !requireModerateOrWrite(w, r, svc, actorID) {
			return
		}
		id, ok := resolveReportIDParam(w, r, svc)
		if !ok {
			return
		}
		var req closeReportRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		state, err := svc.Reports.Close(r.Context(), actorID, id, req.Outcome)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		if hub != nil {
			hub.BroadcastModQueue(context.WithoutCancel(r.Context()), id, state)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
