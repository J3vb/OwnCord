package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// moderationQueueRowResponse is one row of GET /api/v1/moderation/queue.
type moderationQueueRowResponse struct {
	ID           int64   `json:"id"`
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

// moderationReportDetailResponse is GET /api/v1/moderation/queue/{id}.
type moderationReportDetailResponse struct {
	ID         int64                        `json:"id"`
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
}

type addNoteRequest struct {
	Body string `json:"body"`
}

type closeReportRequest struct {
	Outcome string `json:"outcome"`
}

// MountModerationQueueRoutes registers the moderator queue: read, assign,
// note, close. Authorization is enforced inside ReportService (CanModerate,
// the canonical predicate) so these handlers carry no permission check of
// their own.
func MountModerationQueueRoutes(r chi.Router, svc *service.Services, hub ModQueueBroadcaster) {
	r.Route("/api/v1/moderation/queue", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleModerationQueueList(svc))
		r.Get("/{id}", handleModerationQueueGet(svc))
		r.Post("/{id}/assign", handleModerationQueueAssign(svc, hub))
		r.Post("/{id}/notes", handleModerationQueueNote(svc))
		r.Post("/{id}/close", handleModerationQueueClose(svc, hub))
	})
}

func currentUserID(r *http.Request) (int64, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		return 0, false
	}
	return user.ID, true
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
				ID: row.ID, ReporterName: row.ReporterName, SubjectName: row.SubjectName,
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
		id, ok := parseIDParam(w, r, "id")
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
		writeJSON(w, http.StatusOK, moderationReportDetailResponse{
			ID: detail.Report.ID, ReporterID: detail.Report.ReporterID, SubjectID: detail.Report.SubjectID,
			TargetType: detail.Report.TargetType, TargetRef: detail.Report.TargetRef, ChannelID: detail.Report.ChannelID,
			Reason: detail.Report.Reason, Detail: detail.Report.Detail, State: detail.Report.State,
			AssigneeID: detail.Report.AssigneeID, Outcome: detail.Report.Outcome,
			CreatedAt: detail.Report.CreatedAt, UpdatedAt: detail.Report.UpdatedAt, ClosedAt: detail.Report.ClosedAt,
			Evidence: evidence, Notes: notes,
		})
	}
}

func handleModerationQueueAssign(svc *service.Services, hub ModQueueBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		id, ok := parseIDParam(w, r, "id")
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
		id, ok := parseIDParam(w, r, "id")
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
		id, ok := parseIDParam(w, r, "id")
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
