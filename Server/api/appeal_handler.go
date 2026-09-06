package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// fileAppealRequest is POST /api/v1/appeals' body.
type fileAppealRequest struct {
	ActionID int64  `json:"action_id"`
	Body     string `json:"body"`
}

// appealMineResponse is one row of GET /api/v1/appeals/mine.
type appealMineResponse struct {
	ID           string  `json:"id"`
	ActionKind   string  `json:"action_kind"`
	ActionReason string  `json:"action_reason"`
	ActionAt     string  `json:"action_created_at"`
	State        string  `json:"state"`
	DecisionNote *string `json:"decision_note"`
	CreatedAt    string  `json:"created_at"`
	DecidedAt    *string `json:"decided_at"`
}

// appealQueueRowResponse is one row of GET /api/v1/moderation/appeals.
type appealQueueRowResponse struct {
	ID           string  `json:"id"`
	ActionID     int64   `json:"action_id"`
	AppellantID  int64   `json:"appellant_id"`
	Body         string  `json:"body"`
	State        string  `json:"state"`
	AssigneeID   int64   `json:"assignee_id"`
	DecidedBy    int64   `json:"decided_by"`
	DecisionNote string  `json:"decision_note"`
	CreatedAt    string  `json:"created_at"`
	DecidedAt    *string `json:"decided_at"`
}

// appealDetailResponse is GET /api/v1/moderation/appeals/{id}.
type appealDetailResponse struct {
	ID           string                   `json:"id"`
	ActionID     int64                    `json:"action_id"`
	AppellantID  int64                    `json:"appellant_id"`
	Body         string                   `json:"body"`
	State        string                   `json:"state"`
	AssigneeID   int64                    `json:"assignee_id"`
	DecidedBy    int64                    `json:"decided_by"`
	DecisionNote string                   `json:"decision_note"`
	CreatedAt    string                   `json:"created_at"`
	DecidedAt    *string                  `json:"decided_at"`
	Action       moderationActionResponse `json:"action"`
	ReportID     *string                  `json:"report_id,omitempty"`
}

type decideAppealRequest struct {
	Outcome string `json:"outcome"`
	Note    string `json:"note"`
}

// MountAppealRoutes registers appeal submission and the appellant's own
// status view. The moderation queue itself is MountModerationAppealRoutes.
func MountAppealRoutes(r chi.Router, svc *service.Services) {
	r.Route("/api/v1/appeals", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Post("/", handleFileAppeal(svc))
		r.Get("/mine", handleMyAppeals(svc))
		r.Post("/{id}/withdraw", handleWithdrawAppeal(svc))
	})
}

// MountModerationAppealRoutes registers the moderator appeal queue: read,
// assign, decide. Authorization is enforced inside AppealService
// (CanModerate, the canonical predicate) so these handlers carry no
// permission check of their own.
func MountModerationAppealRoutes(r chi.Router, svc *service.Services) {
	r.Route("/api/v1/moderation/appeals", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleAppealQueueList(svc))
		r.Get("/{id}", handleAppealQueueGet(svc))
		r.Post("/{id}/assign", handleAppealQueueAssign(svc))
		r.Post("/{id}/decide", handleAppealQueueDecide(svc))
	})
}

// handleFileAppeal: the mod_queue "open" broadcast is issued by
// AppealService.Submit itself (round 4 review), under the same per-appeal
// lock the other three transitions already use — it used to run here,
// after Submit returned, so it could arrive after a withdraw/assign frame
// for the same appeal filed moments later.
func handleFileAppeal(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		var req fileAppealRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		publicID, err := svc.Appeals.Submit(r.Context(), user.ID, req.ActionID, req.Body)
		if err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"id": publicID})
	}
}

func handleMyAppeals(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		rows, err := svc.Appeals.Mine(r.Context(), user.ID)
		if err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		resp := make([]appealMineResponse, 0, len(rows))
		for i := range rows {
			row := &rows[i]
			resp = append(resp, appealMineResponse{
				ID: row.PublicID, ActionKind: row.ActionKind, ActionReason: row.ActionReason,
				ActionAt: row.ActionCreatedAt, State: row.State, DecisionNote: row.DecisionNote,
				CreatedAt: row.CreatedAt, DecidedAt: row.DecidedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleWithdrawAppeal: N3's mod_queue "withdrawn" broadcast (a connected
// moderator should see a withdrawn appeal leave the queue without needing
// to re-poll GET /api/v1/moderation/appeals) is issued by AppealService.
// Withdraw itself now (F4 review) — under the same per-appeal lock as the
// appellant's own appeal_status frame, so the two can never race each
// other out of order. This handler carries no broadcast of its own.
func handleWithdrawAppeal(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		publicID := chi.URLParam(r, "id")
		if err := svc.Appeals.Withdraw(r.Context(), user.ID, publicID); err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleAppealQueueList(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		rows, err := svc.Appeals.Queue(r.Context(), actorID, r.URL.Query().Get("state"))
		if err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		resp := make([]appealQueueRowResponse, 0, len(rows))
		for i := range rows {
			row := &rows[i]
			resp = append(resp, appealQueueRowResponse{
				ID: row.PublicID, ActionID: row.ActionID, AppellantID: row.AppellantID, Body: row.Body,
				State: row.State, AssigneeID: row.AssigneeID, DecidedBy: row.DecidedBy,
				DecisionNote: row.DecisionNote, CreatedAt: row.CreatedAt, DecidedAt: row.DecidedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func handleAppealQueueGet(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		publicID := chi.URLParam(r, "id")
		detail, err := svc.Appeals.Get(r.Context(), actorID, publicID)
		if err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		resp := appealDetailResponse{
			ID: detail.Appeal.PublicID, ActionID: detail.Appeal.ActionID, AppellantID: detail.Appeal.AppellantID,
			Body: detail.Appeal.Body, State: detail.Appeal.State, AssigneeID: detail.Appeal.AssigneeID,
			DecidedBy: detail.Appeal.DecidedBy, DecisionNote: detail.Appeal.DecisionNote,
			CreatedAt: detail.Appeal.CreatedAt, DecidedAt: detail.Appeal.DecidedAt,
			Action: moderationActionResponses(r.Context(), svc, actorID, []db.ModerationAction{detail.Action})[0],
		}
		if detail.Action.ReportID != nil {
			if pub, ok := svc.Reports.VisibleReportPublicID(r.Context(), actorID, *detail.Action.ReportID); ok {
				resp.ReportID = &pub
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleAppealQueueAssign: the mod_queue "assigned" broadcast is issued by
// AppealService.Assign itself (F4 review), under the same per-appeal lock
// as the appellant's own appeal_status frame.
func handleAppealQueueAssign(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		publicID := chi.URLParam(r, "id")
		force := r.URL.Query().Get("force") == "1"
		if err := svc.Appeals.Assign(r.Context(), actorID, publicID, force); err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleAppealQueueDecide: the mod_queue outcome broadcast is issued by
// AppealService.Decide itself (F4 review), under the same per-appeal lock
// as the appellant's own appeal_status frame.
func handleAppealQueueDecide(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		publicID := chi.URLParam(r, "id")
		var req decideAppealRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		if err := svc.Appeals.Decide(r.Context(), actorID, publicID, req.Outcome, req.Note); err != nil {
			writeAppealServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// writeAppealServiceError special-cases the appeal-shaped errors this
// endpoint's wire contract names — an already-appealed action as
// ALREADY_APPEALED (not the generic CONFLICT) and the deciding-moderator
// rule as SELF_REVIEW (reused from the report queue's identical shape) —
// falling through to writeServiceError for everything else.
func writeAppealServiceError(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrAlreadyAppealed):
		writeJSON(w, http.StatusConflict, errorResponse{Error: "ALREADY_APPEALED", Message: err.Error()})
	case errors.Is(err, service.ErrSelfReview):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "SELF_REVIEW", Message: err.Error()})
	case errors.Is(err, service.ErrReversalFailed):
		// F1 review: the decision's effect could not be applied, so neither
		// it nor the decision itself committed.
		writeJSON(w, http.StatusConflict, errorResponse{Error: "REVERSAL_FAILED", Message: err.Error()})
	default:
		writeServiceError(ctx, w, err)
	}
}
