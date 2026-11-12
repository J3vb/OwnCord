package api

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

type createInviteRequest struct {
	MaxUses        int `json:"max_uses"`
	ExpiresInHours int `json:"expires_in_hours"`
}

type inviteResponse struct {
	ID              int64   `json:"id"`
	Code            string  `json:"code"`
	MaxUses         *int    `json:"max_uses"`
	Uses            int     `json:"uses"`
	ExpiresAt       *string `json:"expires_at"`
	Revoked         bool    `json:"revoked"`
	CreatedAt       string  `json:"created_at"`
	CreatorUsername string  `json:"creator_username"`
}

// MountInviteRoutes registers invite endpoints on the given router.
// All routes require authentication and MANAGE_INVITES permission.
func MountInviteRoutes(r chi.Router, svc *service.Services, limiter *auth.RateLimiter) {
	r.Route("/api/v1/invites", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Use(RequirePermission(permissions.ManageInvites))

		r.Post("/", handleCreateInvite(svc, limiter))
		r.Get("/", handleListInvites(svc))
		r.Delete("/{code}", handleRevokeInvite(svc))
		r.Delete("/id/{id}", handleRevokeInviteByID(svc))
		r.Get("/{code}/redemptions", handleListInviteRedemptions(svc))
	})
}

func handleCreateInvite(svc *service.Services, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createInviteRequest
		if !decodeOptionalJSON(w, r, &req) {
			return
		}

		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		// Cap invite expiration to 30 days.
		if req.ExpiresInHours > service.MaxInviteExpiryHours() {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("expires_in_hours cannot exceed %d (30 days)", service.MaxInviteExpiryHours()))
			return
		}

		if req.MaxUses < 0 || req.ExpiresInHours < 0 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "max_uses and expires_in_hours must not be negative")
			return
		}

		// Last check before the write, so a request that fails validation does not spend the budget.
		if limiter != nil {
			key := auth.Key("invite_create", user.ID)
			if !limiter.Allow(key, inviteCreatePerHour, time.Hour) {
				secs := max(int(math.Ceil(limiter.RetryAfter(key, inviteCreatePerHour, time.Hour).Seconds())), 1)
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many invites created, please try again later")
				return
			}
		}

		inv, err := svc.Invites.CreateInvite(r.Context(), user.ID, req.MaxUses, req.ExpiresInHours)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusCreated, toInviteResponse(inv))
	}
}

// handleListInvites answers a plain array: live invites first, then the newest dead ones. The optional
// state=live|dead, before=<id> and limit=<n> query parameters page one list by id.
func handleListInvites(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		before, limit := int64(0), 0
		if v := q.Get("before"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "before must be a non-negative integer")
				return
			}
			before = n
		}
		if v := q.Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "limit must be a non-negative integer")
				return
			}
			limit = n
		}
		invites, err := svc.Invites.ListInvites(r.Context(), q.Get("state"), before, limit)
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

func handleRevokeInvite(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		code := chi.URLParam(r, "code")
		if err := svc.Invites.RevokeInvite(r.Context(), user.ID, code); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleRevokeInviteByID(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		id, ok := pathID(r, "id")
		if !ok {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "invite not found")
			return
		}
		if err := svc.Invites.RevokeInviteByID(r.Context(), user.ID, id); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type inviteRedemptionResponse struct {
	// UserID is null once the redeemer's account has been erased; Username is
	// then empty. A leaked invite can still be traced to when it was spent.
	UserID     *int64 `json:"user_id"`
	Username   string `json:"username"`
	RedeemedAt string `json:"redeemed_at"`
}

func handleListInviteRedemptions(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := chi.URLParam(r, "code")
		reds, err := svc.Invites.ListInviteRedemptions(r.Context(), code)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		resp := make([]inviteRedemptionResponse, 0, len(reds))
		for _, red := range reds {
			resp = append(resp, inviteRedemptionResponse{
				UserID:     red.UserID,
				Username:   red.Username,
				RedeemedAt: red.RedeemedAt,
			})
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func toInviteResponse(inv *db.Invite) inviteResponse {
	var maxUses *int
	if inv.MaxUses != nil {
		v := *inv.MaxUses
		maxUses = &v
	}
	return inviteResponse{
		ID:              inv.ID,
		Code:            inv.Code,
		MaxUses:         maxUses,
		Uses:            inv.Uses,
		ExpiresAt:       inv.ExpiresAt,
		Revoked:         inv.Revoked,
		CreatedAt:       inv.CreatedAt,
		CreatorUsername: inv.CreatorUsername,
	}
}
