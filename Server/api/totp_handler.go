package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── TOTP request/response types ─────────────────────────────────────────────

type verifyTotpRequest struct {
	Code string `json:"code"`
}

type passwordConfirmationRequest struct {
	Password string `json:"password"`
}

type totpConfirmationRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

type totpEnableResponse struct {
	QRURI       string   `json:"qr_uri"`
	BackupCodes []string `json:"backup_codes"`
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// handleVerifyTOTP processes POST /api/v1/auth/verify-totp: the bearer token
// is the partial-login challenge Login issued.
func handleVerifyTOTP(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		partialToken, ok := auth.ExtractBearerToken(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "missing or invalid authorization header",
			})
			return
		}

		var req verifyTotpRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		res, err := svc.VerifyTOTP(r.Context(), partialToken, req.Code)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, authResponse(res))
	}
}

// handleEnableTOTP processes POST /api/v1/users/me/totp/enable.
func handleEnableTOTP(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}

		var req passwordConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		enrolment, err := svc.EnableTOTP(r.Context(), p, req.Password)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, totpEnableResponse{
			QRURI:       enrolment.URI,
			BackupCodes: enrolment.RecoveryCodes,
		})
	}
}

// recoveryCodesResponse is the JSON shape returned by
// POST /api/v1/users/me/totp/recovery-codes. The field keeps the name the
// enrolment response has always used for the same codes.
type recoveryCodesResponse struct {
	BackupCodes []string `json:"backup_codes"`
}

// handleRegenerateRecoveryCodes processes
// POST /api/v1/users/me/totp/recovery-codes: password-confirmed, it replaces
// the account's emergency recovery codes and returns the new set once.
func handleRegenerateRecoveryCodes(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}

		var req passwordConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		codes, err := svc.RegenerateRecoveryCodes(r.Context(), p, req.Password)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, recoveryCodesResponse{BackupCodes: codes})
	}
}

// handleConfirmTOTP processes POST /api/v1/users/me/totp/confirm.
func handleConfirmTOTP(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}

		var req totpConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		res, err := svc.ConfirmTOTP(r.Context(), p, req.Password, req.Code)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeTOTPChange(w, res)
	}
}

// handleDisableTOTP processes DELETE /api/v1/users/me/totp. An empty body is
// accepted (and then refused by the service as a missing password); only a
// body that is present and not JSON is malformed.
func handleDisableTOTP(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}

		var req passwordConfirmationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		res, err := svc.DisableTOTP(r.Context(), p, req.Password)
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeTOTPChange(w, res)
	}
}

// writeTOTPChange answers a committed 2FA change: 204, or 200 with the
// warning when the caller's other sessions could not be revoked — a partial
// success the service reports instead of a 5xx, because the change is
// already durable.
func writeTOTPChange(w http.ResponseWriter, res *service.TOTPChangeResult) {
	if res.Warning != "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"warning":          res.Warning,
			"sessions_revoked": res.SessionsRevoked,
		})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
