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

// ModQueueBroadcaster is the hub capability the report routes need: notify
// connected moderation-bit holders of a queue change. Satisfied by *ws.Hub.
type ModQueueBroadcaster interface {
	BroadcastModQueue(ctx context.Context, reportID int64, state string)
}

// fileReportRequest is POST /api/v1/reports' body.
type fileReportRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
}

// reportSummaryResponse is one row of GET /api/v1/reports/mine.
type reportSummaryResponse struct {
	ID         int64   `json:"id"`
	TargetType string  `json:"target_type"`
	Reason     string  `json:"reason"`
	State      string  `json:"state"`
	Outcome    string  `json:"outcome"`
	CreatedAt  string  `json:"created_at"`
	ClosedAt   *string `json:"closed_at"`
}

// MountReportRoutes registers the intake and the reporter's own view.
// The moderation queue itself is MountModerationQueueRoutes.
func MountReportRoutes(r chi.Router, svc *service.Services, hub ModQueueBroadcaster) {
	r.Route("/api/v1/reports", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Post("/", handleFileReport(svc, hub))
		r.Get("/mine", handleMyReports(svc))
	})
}

func handleFileReport(svc *service.Services, hub ModQueueBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		var req fileReportRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: "malformed JSON body"})
			return
		}

		id, err := svc.Reports.File(r.Context(), service.FileReportParams{
			ReporterID: user.ID, TargetType: req.TargetType, TargetID: req.TargetID,
			Reason: req.Reason, Detail: req.Detail,
		})
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		if hub != nil {
			hub.BroadcastModQueue(context.WithoutCancel(r.Context()), id, "open")
		}
		writeJSON(w, http.StatusCreated, map[string]int64{"id": id})
	}
}

func handleMyReports(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "UNAUTHORIZED", Message: "not authenticated"})
			return
		}
		rows, err := svc.Reports.Mine(r.Context(), user.ID)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		resp := make([]reportSummaryResponse, 0, len(rows))
		for _, row := range rows {
			resp = append(resp, reportSummaryResponse{
				ID: row.ID, TargetType: row.TargetType, Reason: row.Reason,
				State: row.State, Outcome: row.Outcome, CreatedAt: row.CreatedAt, ClosedAt: row.ClosedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// writeReportServiceError special-cases the two report-shaped errors this
// endpoint's wire contract names — validation as INVALID_INPUT (not the
// generic BAD_REQUEST) and duplicates as DUPLICATE_REPORT (not the generic
// CONFLICT) — falling through to writeServiceError for everything else.
func writeReportServiceError(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrDuplicateReport):
		writeJSON(w, http.StatusConflict, errorResponse{Error: "DUPLICATE_REPORT", Message: err.Error()})
	case errors.Is(err, service.ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "INVALID_INPUT", Message: err.Error()})
	default:
		writeServiceError(ctx, w, err)
	}
}
