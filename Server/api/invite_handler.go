package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// createInviteRequest is the JSON body for POST /api/v1/invites.
type createInviteRequest struct {
	MaxUses        int `json:"max_uses"`
	ExpiresInHours int `json:"expires_in_hours"`
}

// inviteResponse is the API shape for an invite.
type inviteResponse struct {
	ID        int64   `json:"id"`
	Code      string  `json:"code"`
	MaxUses   *int    `json:"max_uses"`
	Uses      int     `json:"uses"`
	ExpiresAt *string `json:"expires_at"`
	Revoked   bool    `json:"revoked"`
	CreatedAt string  `json:"created_at"`
}

// MountInviteRoutes registers invite endpoints on the given router.
// All routes require authentication and MANAGE_INVITES permission.
func MountInviteRoutes(r chi.Router, database *db.DB) {
	r.Route("/api/v1/invites", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Use(RequirePermission(permissions.ManageInvites))

		r.Post("/", handleCreateInvite(database))
		r.Get("/", handleListInvites(database))
		r.Delete("/{code}", handleRevokeInvite(database))
	})
}

// handleCreateInvite processes POST /api/v1/invites.
func handleCreateInvite(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createInviteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			// An empty body is valid (all fields optional), but malformed
			// JSON must be rejected so callers notice typos.
			if err != io.EOF {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "malformed JSON body",
				})
				return
			}
			req = createInviteRequest{}
		}

		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var expiresAt *time.Time
		if req.ExpiresInHours > 0 {
			t := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
			expiresAt = &t
		}

		code, err := database.CreateInvite(user.ID, req.MaxUses, expiresAt)
		if err != nil {
			slog.Error("handleCreateInvite CreateInvite", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create invite",
			})
			return
		}

		inv, err := database.GetInvite(code)
		if err != nil || inv == nil {
			slog.Error("handleCreateInvite GetInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to retrieve invite",
			})
			return
		}

		writeJSON(w, http.StatusCreated, toInviteResponse(inv))
	}
}

// handleListInvites processes GET /api/v1/invites.
func handleListInvites(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invites, err := database.ListInvites()
		if err != nil {
			slog.Error("handleListInvites ListInvites", "err", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to list invites",
			})
			return
		}

		resp := make([]inviteResponse, 0, len(invites))
		for _, inv := range invites {
			resp = append(resp, toInviteResponse(inv))
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleRevokeInvite processes DELETE /api/v1/invites/:code.
func handleRevokeInvite(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := chi.URLParam(r, "code")

		inv, err := database.GetInvite(code)
		if err != nil {
			slog.Error("handleRevokeInvite GetInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to look up invite",
			})
			return
		}
		if inv == nil {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "invite not found",
			})
			return
		}

		if err := database.RevokeInvite(code); err != nil {
			slog.Error("handleRevokeInvite RevokeInvite", "err", err, "code", code)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to revoke invite",
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// toInviteResponse converts a db.Invite to the API response shape.
func toInviteResponse(inv *db.Invite) inviteResponse {
	var maxUses *int
	if inv.MaxUses != nil {
		v := *inv.MaxUses
		maxUses = &v
	}
	return inviteResponse{
		ID:        inv.ID,
		Code:      inv.Code,
		MaxUses:   maxUses,
		Uses:      inv.Uses,
		ExpiresAt: inv.ExpiresAt,
		Revoked:   inv.Revoked,
		CreatedAt: inv.CreatedAt,
	}
}
