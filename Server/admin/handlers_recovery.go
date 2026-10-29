package admin

import (
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
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
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
			return
		}
		if authSvc == nil {
			// Fail closed rather than mint a credential without the service's checks.
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "recovery service unavailable")
			return
		}
		var req issueRecoveryCredentialRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		issue, err := authSvc.IssueRecoveryAssist(r.Context(), actorFromContext(r), id, req.Verification)
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
	// ErrAuthBusy and ErrRateLimited have no equivalent in writeSvcErr's four
	// cases, so they are checked first — the admission refusal before the
	// issuance budget it also matches — and everything else falls through.
	if errors.Is(err, service.ErrAuthBusy) {
		writeErr(w, http.StatusTooManyRequests, httperr.CodeAuthBusy, err.Error())
		return
	}
	if errors.Is(err, service.ErrRateLimited) {
		writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, err.Error())
		return
	}
	writeSvcErr(w, err, "", "", "failed to issue the recovery credential")
}
