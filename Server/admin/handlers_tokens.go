package admin

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── API Token Handlers ──────────────────────────────────────────────────────
//
// These are the HTTP-panel equivalent of `server token create|list|revoke`
// (token_cli.go). They wrap the same db.*APIToken calls, so behaviour stays in
// sync with the CLI. All three routes are Owner-gated in api.go: minting a
// long-lived bearer credential over the network is the one admin action that,
// via a hijacked session, would outlive a password change and bulk logout
// (API tokens deliberately live outside the session table), so it stays behind
// the Owner role rather than the broad ADMINISTRATOR bit.

func handleListAPITokens(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokens, err := database.ListAPITokens(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list tokens")
			return
		}
		writeJSON(w, http.StatusOK, tokens)
	}
}

// createTokenRequest is the JSON body for POST /admin/api/tokens. Username empty
// binds the token to the owner account (the CLI default); ExpiresHours 0 means
// never expires.
type createTokenRequest struct {
	Label        string `json:"label"`
	Username     string `json:"username"`
	ExpiresHours int    `json:"expires_hours"`
}

// createTokenResponse carries the raw token — shown exactly once, never
// recoverable — plus enough context for the UI to display what was minted.
type createTokenResponse struct {
	ID    int64  `json:"id"`
	Token string `json:"token"`
	Label string `json:"label"`
	User  string `json:"user"`
}

func handleCreateAPIToken(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		req.Label = strings.TrimSpace(req.Label)
		if req.Label == "" {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "label is required")
			return
		}
		// expires_hours=0 means "never expires" (see createTokenRequest doc).
		// Negatives must not fall into that same nil-expiresAt branch, and the
		// upper bound keeps time.Duration(hours)*time.Hour from overflowing
		// int64 nanoseconds into a past timestamp. 87600h = 10 years.
		if req.ExpiresHours < 0 || req.ExpiresHours > 24*365*10 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "expires_hours must be between 0 and 87600")
			return
		}

		var user *db.User
		var err error
		if req.Username != "" {
			user, err = database.GetUserByUsername(r.Context(), req.Username)
		} else {
			user, err = database.GetOwnerUser(r.Context())
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to look up user")
			return
		}
		if user == nil {
			writeErr(w, http.StatusBadRequest, "NOT_FOUND", "user not found")
			return
		}

		raw, err := auth.GenerateToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate token")
			return
		}
		var expiresAt *time.Time
		if req.ExpiresHours > 0 {
			t := time.Now().Add(time.Duration(req.ExpiresHours) * time.Hour)
			expiresAt = &t
		}
		id, err := database.CreateAPIToken(r.Context(), user.ID, auth.HashToken(raw), req.Label, expiresAt)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create token")
			return
		}

		actor := actorFromContext(r)
		slog.Info("api token created", "actor_id", actor, "token_id", id, "label", req.Label, "bound_user", user.Username)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "api_token_create", "api_token", id, req.Label)

		writeJSON(w, http.StatusCreated, createTokenResponse{ID: id, Token: raw, Label: req.Label, User: user.Username})
	}
}

func handleRevokeAPIToken(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid token id")
			return
		}
		affected, err := database.RevokeAPIToken(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to revoke token")
			return
		}
		if affected == 0 {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "no active token with that id")
			return
		}
		actor := actorFromContext(r)
		slog.Warn("api token revoked", "actor_id", actor, "token_id", id)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "api_token_revoke", "api_token", id, "")
		w.WriteHeader(http.StatusNoContent)
	}
}
