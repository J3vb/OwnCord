package admin

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// POST /admin/api/users/{id}/recovery-credential (B4-6, BPR-045): the server
// owner, having verified the person out of band, receives a 15-minute,
// single-use recovery credential for the account, shown once. The route is
// owner-only (ownerOnlyMiddleware) and the service checks the role again.

type issueRecoveryCredentialRequest struct {
	// Verification is one of service.RecoveryVerifications: fixed wording,
	// never free text, so the audit row stays content-free.
	Verification string `json:"verification"`
}

type issueRecoveryCredentialResponse struct {
	Credential   string `json:"credential"`
	ExpiresAt    string `json:"expires_at"`
	Username     string `json:"username"`
	Verification string `json:"verification"`
}

func handleIssueRecoveryCredential(authSvc *service.AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}
		if authSvc == nil {
			// Fail closed rather than mint a credential without the service's checks.
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "recovery service unavailable")
			return
		}
		actor, ok := r.Context().Value(adminUserKey).(*db.User)
		if !ok || actor == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		var req issueRecoveryCredentialRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
			return
		}
		issue, err := authSvc.IssueRecoveryAssist(r.Context(), actor, id, req.Verification)
		if err != nil {
			writeRecoveryErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, issueRecoveryCredentialResponse{
			Credential: issue.Credential, ExpiresAt: issue.ExpiresAt, Username: issue.Username, Verification: issue.Verification,
		})
	}
}

func writeRecoveryErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	case errors.Is(err, service.ErrRateLimited):
		writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to issue the recovery credential")
	}
}
