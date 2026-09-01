package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// ─── API Token Handlers ──────────────────────────────────────────────────────
//
// These are the HTTP-panel equivalent of `server token create|list|revoke`
// (token_cli.go). Both are thin adapters over service.TokenService, which is
// what keeps them in sync — they used to wrap the same db.*APIToken calls
// twice and had already drifted apart. All three routes are Owner-gated in
// api.go: minting a long-lived bearer credential over the network is the one
// admin action that, via a hijacked session, would outlive a password change
// and bulk logout (API tokens deliberately live outside the session table), so
// it stays behind the Owner role rather than the broad ADMINISTRATOR bit.

func handleListAPITokens(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := tokens.List(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list tokens")
			return
		}
		writeJSON(w, http.StatusOK, list)
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

func handleCreateAPIToken(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		// expires_hours=0 means "never expires" (see createTokenRequest doc).
		// Negatives must not fall into that same never-expires branch, and the
		// upper bound is applied to the INT, before the multiply below can
		// overflow int64 nanoseconds into a past instant. 87600h = 10 years,
		// the same ceiling the service enforces on the duration it receives.
		if req.ExpiresHours < 0 || req.ExpiresHours > 24*365*10 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "expires_hours must be between 0 and 87600")
			return
		}

		minted, err := tokens.Create(r.Context(), actorFromContext(r),
			req.Username, req.Label, time.Duration(req.ExpiresHours)*time.Hour)
		switch {
		case errors.Is(err, service.ErrBadRequest):
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		case errors.Is(err, service.ErrNotFound), errors.Is(err, service.ErrNoOwnerAccount):
			// Both are "there is nobody to bind this token to". The panel is
			// only reachable once an owner exists, so the bootstrap case is
			// unreachable here in practice; it is mapped rather than dropped
			// so a future caller cannot fall through to a 500.
			writeErr(w, http.StatusBadRequest, "NOT_FOUND", "user not found")
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create token")
			return
		}

		writeJSON(w, http.StatusCreated, createTokenResponse{
			ID: minted.ID, Token: minted.Raw, Label: minted.Label, User: minted.User.Username,
		})
	}
}

func handleRevokeAPIToken(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid token id")
			return
		}
		switch err := tokens.Revoke(r.Context(), actorFromContext(r), id); {
		case errors.Is(err, service.ErrNotFound):
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "no active token with that id")
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to revoke token")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
