package admin

import (
	"errors"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

//
// The HTTP-panel equivalent of `server token create|list|revoke` (token_cli.go); both are thin adapters over
// service.TokenService, which keeps them in sync (they had drifted when each wrapped db.*APIToken calls). All
// three routes sit behind the owner-or-MANAGE_TOKENS gate in api.go: minting a long-lived bearer credential
// is the one admin action that, via a hijacked session, would outlive a password change or force-logout (API
// tokens live outside the session table; only sign-out-everywhere and account recovery revoke them), so it
// stays behind the Owner role or the explicit bit, never broad ADMINISTRATOR. The owner manages every token;
// other holders are confined to their own.

func handleListAPITokens(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// A MANAGE_TOKENS holder who is not the owner sees only their own tokens.
		list, err := tokens.ListFor(r.Context(), actorFromContext(r), isOwnerFromContext(r))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list tokens")
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// createTokenRequest is the body for POST /admin/api/tokens. Empty Username binds the owner (the CLI
// default); ExpiresHours 0 never expires.
type createTokenRequest struct {
	Label        string `json:"label"`
	Username     string `json:"username"`
	ExpiresHours int    `json:"expires_hours"`
}

// createTokenResponse carries the raw token, shown exactly once and never recoverable.
type createTokenResponse struct {
	ID    int64  `json:"id"`
	Token string `json:"token"`
	Label string `json:"label"`
	User  string `json:"user"`
}

func handleCreateAPIToken(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createTokenRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		// expires_hours=0 means never expires, so negatives must not fall into that branch, and the upper bound
		// (87600h = 10 years, the service's ceiling) applies to the int before the multiply can overflow int64
		// nanoseconds into a past instant.
		if req.ExpiresHours < 0 || req.ExpiresHours > 24*365*10 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "expires_hours must be between 0 and 87600")
			return
		}

		// A MANAGE_TOKENS holder who is not the owner mints only for themself; another username is a 403.
		minted, err := tokens.CreateFor(r.Context(), actorUserFromContext(r), isOwnerFromContext(r),
			req.Username, req.Label, time.Duration(req.ExpiresHours)*time.Hour)
		switch {
		case errors.Is(err, service.ErrForbidden):
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "you can only create tokens for your own account")
			return
		case errors.Is(err, service.ErrBadRequest):
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
			return
		case errors.Is(err, service.ErrNotFound), errors.Is(err, service.ErrNoOwnerAccount):
			// Both mean nobody to bind the token to. The panel needs an owner to exist, so bootstrap is unreachable in
			// practice; mapped rather than dropped so a future caller cannot fall through to a 500.
			writeErr(w, http.StatusBadRequest, httperr.CodeNotFound, "user not found")
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to create token")
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
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid token id")
			return
		}
		// A holder who is not the owner revokes only their own.
		switch err := tokens.RevokeFor(r.Context(), actorFromContext(r), id, isOwnerFromContext(r)); {
		case errors.Is(err, service.ErrNotFound):
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "no active token with that id")
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to revoke token")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
