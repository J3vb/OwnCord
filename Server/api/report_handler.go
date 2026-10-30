package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ModQueueBroadcaster is the hub capability the report routes need: notify
// connected moderation-bit holders of a queue change (satisfied by *ws.Hub). It
// takes the INTERNAL report id; the hub resolves the public id
// (db.Report.PublicID).
// BroadcastMemberBan/BroadcastChatBulkDeleted are the transport broadcasts the
// queue's act route sends after a report-linked ban or removal commits, the same
// calls the direct admin PATCH and purge routes make. Ban and removal have no
// live-target notifier of their own (unlike Warn/Timeout's
// ModerationService.notifyModAction), so without these acting through the queue
// silently dropped both.
type ModQueueBroadcaster interface {
	BroadcastModQueue(ctx context.Context, reportID int64, state string)
	BroadcastMemberBan(userID int64)
	BroadcastChatBulkDeleted(channelID int64, messageIDs []int64)
}

type fileReportRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
}

// reportSummaryResponse is one row of GET /api/v1/reports/mine. ID is the
// PUBLIC id — the sequential internal id never reaches a response.
type reportSummaryResponse struct {
	ID         string  `json:"id"`
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
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
			return
		}
		var req fileReportRequest
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if !decodeJSON(w, r, &req) {
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
		publicID, err := svc.Reports.PublicIDFor(r.Context(), id)
		if err != nil {
			writeReportServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"id": publicID})
	}
}

func handleMyReports(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
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
				ID: row.PublicID, TargetType: row.TargetType, Reason: row.Reason,
				State: row.State, Outcome: row.Outcome, CreatedAt: row.CreatedAt, ClosedAt: row.ClosedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// writeReportServiceError maps report-shaped errors to this endpoint's wire
// contract (INVALID_INPUT, DUPLICATE_REPORT, and SELF_REVIEW for a moderator
// acting on their own report) and falls through to writeServiceError otherwise.
func writeReportServiceError(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrDuplicateReport):
		writeErr(w, http.StatusConflict, httperr.CodeDuplicateReport, err.Error())
	case errors.Is(err, service.ErrSelfReview):
		writeErr(w, http.StatusForbidden, httperr.CodeSelfReview, err.Error())
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
	default:
		writeServiceError(ctx, w, err)
	}
}
