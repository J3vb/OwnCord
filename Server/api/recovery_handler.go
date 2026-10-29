package api

import (
	"net/http"
	"strings"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// The recovery kit's routes. Enrolment and status sit beside the
// other credential routes under /users/me; redemption is public, like login,
// and rate-limited the same way.

type enrolRecoveryKitRequest struct {
	Password string `json:"password"`
	// KitSecret is optional: a secret the client generated locally. Absent,
	// the server generates one and returns it once.
	KitSecret string `json:"kit_secret"`
}

type recoveryKitIssueResponse struct {
	// KitSecret is present only when the server generated the secret.
	KitSecret string `json:"kit_secret,omitempty"`
	CreatedAt string `json:"created_at"`
}

type recoveryKitStatusResponse struct {
	Enrolled  bool    `json:"enrolled"`
	CreatedAt string  `json:"created_at,omitempty"`
	UsedAt    *string `json:"used_at"`
}

type recoverRequest struct {
	Username  string `json:"username"`
	KitSecret string `json:"kit_secret"`
	// Credential is an owner-issued recovery credential; either
	// field carries the secret, told apart by shape.
	Credential  string `json:"credential"`
	NewPassword string `json:"new_password"`
}

// handleEnrolRecoveryKit processes POST /api/v1/users/me/recovery-kit.
func handleEnrolRecoveryKit(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}
		var req enrolRecoveryKitRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		issue, err := svc.EnrolRecoveryKit(r.Context(), p, req.Password, req.KitSecret)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, recoveryKitIssueResponse{KitSecret: issue.Secret, CreatedAt: issue.CreatedAt})
	}
}

// handleRecoveryKitStatus processes GET /api/v1/users/me/recovery-kit.
func handleRecoveryKitStatus(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}
		status, err := svc.RecoveryKitStatus(r.Context(), p)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, recoveryKitStatusResponse{Enrolled: status.Enrolled, CreatedAt: status.CreatedAt, UsedAt: status.UsedAt})
	}
}

// handleRecover processes POST /api/v1/auth/recover: a recovery secret — the
// kit's, or an owner-issued credential — plus a new password sign the
// account holder in without the second factor.
func handleRecover(svc AuthService, trustedProxies []string) http.HandlerFunc {
	proxyNets := parseCIDRList(trustedProxies)
	return func(w http.ResponseWriter, r *http.Request) {
		var req recoverRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		secret := req.KitSecret
		if secret == "" {
			secret = req.Credential
		}
		if req.Username == "" || secret == "" || req.NewPassword == "" {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username, kit_secret (or credential) and new_password are required")
			return
		}
		// Bound and normalise the username as login does: it becomes a limiter
		// key and, on the fifth failure, a lockout row, so it must stay small.
		if len(req.Username) > maxLoginUsernameLen*4 {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username too long")
			return
		}
		req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
		if err := auth.ValidateUsername(req.Username); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return
		}
		if err := auth.ValidatePasswordStrength(req.NewPassword); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return
		}
		res, err := svc.RecoverWithKit(r.Context(), service.RecoverInput{
			Username:    req.Username,
			KitSecret:   secret,
			NewPassword: req.NewPassword,
			Device:      truncateDevice(r.Header.Get("User-Agent")),
			IP:          clientIPWithProxies(r, proxyNets),
		})
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, authResponse(res))
	}
}
