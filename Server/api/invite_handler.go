package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
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
func MountInviteRoutes(r chi.Router, database *db.DB, svc *service.Services) {
	r.Route("/api/v1/invites", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Use(RequirePermission(permissions.ManageInvites))

		r.Post("/", handleCreateInvite(svc))
		r.Get("/", handleListInvites(svc))
		r.Delete("/{code}", handleRevokeInvite(svc))
	})
}

// handleCreateInvite processes POST /api/v1/invites.
func handleCreateInvite(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createInviteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			if err != io.EOF {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "BAD_REQUEST", Message: "malformed JSON body",
				})
				return
			}
			req = createInviteRequest{}
		}

		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		// H-4: Cap invite expiration to 30 days.
		if req.ExpiresInHours > service.MaxInviteExpiryHours() {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: fmt.Sprintf("expires_in_hours cannot exceed %d (30 days)", service.MaxInviteExpiryHours()),
			})
			return
		}

		inv, err := svc.Invites.CreateInvite(r.Context(), user.ID, req.MaxUses, req.ExpiresInHours)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, toInviteResponse(inv))
	}
}

// handleListInvites processes GET /api/v1/invites.
func handleListInvites(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invites, err := svc.Invites.ListInvites(r.Context())
		if err != nil {
			writeServiceError(r.Context(), w, err)
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
func handleRevokeInvite(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := chi.URLParam(r, "code")
		if err := svc.Invites.RevokeInvite(r.Context(), code); err != nil {
			writeServiceError(r.Context(), w, err)
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
