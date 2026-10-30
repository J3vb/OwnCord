package admin

import (
	"errors"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

//
// These are the HTTP-panel equivalent of `server token create|list|revoke`
// (token_cli.go). Both are thin adapters over service.TokenService, which is
// what keeps them in sync — they used to wrap the same db.*APIToken calls
// twice and had already drifted apart. All three routes sit behind the
// owner-or-MANAGE_TOKENS gate in api.go: minting a long-lived bearer
// credential over the network is the one admin action that, via a hijacked
// session, would outlive a password change or an admin force-logout (API
// tokens deliberately live outside the session table; only sign-out-everywhere
// and account recovery revoke them), so it stays behind the Owner role or the
// explicit bit, never the broad ADMINISTRATOR bit. The owner sees and manages
// every token; a holder who is not the owner is confined to their own.

func handleListAPITokens(tokens *service.TokenService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// A MANAGE_TOKENS holder who is not the owner sees only the tokens
		// bound to them.
		list, err := tokens.ListFor(r.Context(), actorFromContext(r), isOwnerFromContext(r))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list tokens")
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
		if !decodeJSON(w, r, &req) {
			return
		}
		// expires_hours=0 means "never expires" (see createTokenRequest doc).
		// Negatives must not fall into that same never-expires branch, and the
		// upper bound is applied to the INT, before the multiply below can
		// overflow int64 nanoseconds into a past instant. 87600h = 10 years,
		// the same ceiling the service enforces on the duration it receives.
		if req.ExpiresHours < 0 || req.ExpiresHours > 24*365*10 {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "expires_hours must be between 0 and 87600")
			return
		}

		// A MANAGE_TOKENS holder who is not the owner mints for themself only;
		// another username is a 403.
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
			// Both are "there is nobody to bind this token to". The panel is
			// only reachable once an owner exists, so the bootstrap case is
			// unreachable here in practice; it is mapped rather than dropped
			// so a future caller cannot fall through to a 500.
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
