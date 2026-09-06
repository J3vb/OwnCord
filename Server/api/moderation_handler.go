package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// warnRequest is POST /api/v1/moderation/users/{id}/warn's body.
type warnRequest struct {
	Reason string `json:"reason"`
}

// timeoutRequest is POST /api/v1/moderation/users/{id}/timeout's body.
type timeoutRequest struct {
	Reason          string `json:"reason"`
	DurationSeconds int64  `json:"duration_seconds"`
}

// moderationActionIDResponse is Warn's response body.
type moderationActionIDResponse struct {
	ID int64 `json:"id"`
}

// timeoutResponse is Timeout's response body: Voice is "applied" or
// "skipped" — decision 6, the actor lacked MUTE_MEMBERS.
type timeoutResponse struct {
	ID    int64  `json:"id"`
	Voice string `json:"voice"`
}

// moderationActionResponse is one row of GET .../users/{id}/actions and the
// queue detail's "actions taken" list. ReportID, when present, is the
// report's PUBLIC id (P2-9) — the sequential internal id never reaches a
// response.
type moderationActionResponse struct {
	ID             int64   `json:"id"`
	Kind           string  `json:"kind"`
	ActorID        int64   `json:"actor_id"`
	ReportID       *string `json:"report_id,omitempty"`
	Reason         string  `json:"reason"`
	ExpiresAt      *string `json:"expires_at,omitempty"`
	AcknowledgedAt *string `json:"acknowledged_at,omitempty"`
	LiftedAt       *string `json:"lifted_at,omitempty"`
	LiftedBy       int64   `json:"lifted_by,omitempty"`
	CreatedAt      string  `json:"created_at"`
}

// moderationActionResponses maps a ledger slice to the wire shape, resolving
// each row's internal report_id to its public one (P2-9) — the sequential
// id never reaches a response. viewerID authorizes each row's report link
// individually through the report's own confidentiality guard (P1-5, Codex
// review): a moderator who is the SUBJECT of a report linked from their own
// action ledger must not have that report's id surface here just because
// they still hold MODERATE_MEMBERS — the id is simply omitted (the rest of
// the row still renders) rather than the whole read failing.
func moderationActionResponses(ctx context.Context, svc *service.Services, viewerID int64, rows []db.ModerationAction) []moderationActionResponse {
	out := make([]moderationActionResponse, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		resp := moderationActionResponse{
			ID: r.ID, Kind: r.Kind, ActorID: r.ActorID, Reason: r.Reason,
			ExpiresAt: r.ExpiresAt, AcknowledgedAt: r.AcknowledgedAt, LiftedAt: r.LiftedAt,
			LiftedBy: r.LiftedBy, CreatedAt: r.CreatedAt,
		}
		if r.ReportID != nil {
			if pub, ok := svc.Reports.VisibleReportPublicID(ctx, viewerID, *r.ReportID); ok {
				resp.ReportID = &pub
			}
		}
		out = append(out, resp)
	}
	return out
}

// MountModerationRoutes registers the user-directed moderator actions
// (warning, timeout, untimeout, the ledger read) and the notice
// acknowledgement route. Authorization is enforced inside ModerationService
// (requirePerm/requireOutranks) so these handlers carry no permission check
// of their own.
func MountModerationRoutes(r chi.Router, svc *service.Services) {
	r.Route("/api/v1/moderation/users/{id}", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Post("/warn", handleModerationWarn(svc))
		r.Post("/timeout", handleModerationTimeout(svc))
		r.Post("/untimeout", handleModerationUntimeout(svc))
		r.Get("/actions", handleModerationActions(svc))
	})
	r.With(AuthMiddleware(svc.Sessions)).
		Post("/api/v1/users/me/notices/{id}/ack", handleModerationAckNotice(svc))
}

func moderationTargetIDParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	targetID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || targetID <= 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "BAD_REQUEST", Message: "id must be a positive integer"})
		return 0, false
	}
	return targetID, true
}

func handleModerationWarn(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		targetID, ok := moderationTargetIDParam(w, r)
		if !ok {
			return
		}
		var req warnRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		id, err := svc.Moderation.Warn(r.Context(), actorID, targetID, req.Reason, nil)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, moderationActionIDResponse{ID: id})
	}
}

func handleModerationTimeout(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		targetID, ok := moderationTargetIDParam(w, r)
		if !ok {
			return
		}
		var req timeoutRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}
		result, err := svc.Moderation.Timeout(r.Context(), actorID, targetID, req.Reason,
			time.Duration(req.DurationSeconds)*time.Second, nil)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		voice := "applied"
		if result.VoiceSkipped {
			voice = "skipped"
		}
		writeJSON(w, http.StatusCreated, timeoutResponse{ID: result.ID, Voice: voice})
	}
}

func handleModerationUntimeout(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		targetID, ok := moderationTargetIDParam(w, r)
		if !ok {
			return
		}
		if err := svc.Moderation.LiftTimeout(r.Context(), actorID, targetID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleModerationActions(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		targetID, ok := moderationTargetIDParam(w, r)
		if !ok {
			return
		}
		rows, err := svc.Moderation.ListActionsForTarget(r.Context(), actorID, targetID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, moderationActionResponses(r.Context(), svc, actorID, rows))
	}
}

func handleModerationAckNotice(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := currentUserID(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		actionID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || actionID <= 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "BAD_REQUEST", Message: "id must be a positive integer"})
			return
		}
		if err := svc.Moderation.AcknowledgeWarning(r.Context(), userID, actionID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
