package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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

func handleVerifyTOTP(database *db.DB, partialStore *auth.PartialAuthStore, limiter *auth.RateLimiter, usedTOTPCodes *auth.UsedTOTPCodeStore, totpKey []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		partialToken, ok := auth.ExtractBearerToken(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "missing or invalid authorization header",
			})
			return
		}

		challenge, ok := partialStore.Lookup(partialToken)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
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

		totpRateLimitKey := fmt.Sprintf("totp_fail:%d", challenge.UserID)
		if !limiter.Check(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		user, err := database.GetUserByID(challenge.UserID)
		if err != nil || user == nil || user.TOTPSecret == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		secret, decErr := auth.DecryptTOTPSecret(totpKey, *user.TOTPSecret)
		if decErr != nil {
			slog.Error("failed to decrypt TOTP secret", "user_id", user.ID, "error", decErr)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to verify two-factor code",
			})
			return
		}

		if !auth.VerifyTOTPCodeOnce(secret, strings.TrimSpace(req.Code), time.Now().UTC(), user.ID, usedTOTPCodes) {
			limiter.Allow(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow)
			partialStore.RegisterFailure(partialToken, partialAuthMaxFailures)
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid two-factor code",
			})
			return
		}

		limiter.Reset(totpRateLimitKey)

		if _, ok := partialStore.Consume(partialToken); !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		token, err := issueSession(database, user.ID, challenge.Device, challenge.IP)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create session",
			})
			return
		}

		slog.Info("totp verified", "user_id", user.ID, "ip", challenge.IP)
		_ = database.LogAudit(user.ID, "totp_verified", "user", user.ID,
			"two-factor verification completed from "+challenge.IP)

		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

func handleEnableTOTP(pendingStore *auth.PendingTOTPStore, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// BUG-111: Per-user lockout for password confirmation.
		lockKey := fmt.Sprintf("pw_confirm_lock:%d", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		if user.TOTPSecret != nil && *user.TOTPSecret != "" {
			writeJSON(w, http.StatusConflict, errorResponse{
				Error:   "TOTP_ALREADY_ENABLED",
				Message: "disable 2FA before re-enabling",
			})
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
		failKey := fmt.Sprintf("pw_confirm_fail:%d", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(failKey)

		secret, err := auth.GenerateTOTPSecret()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to generate two-factor secret",
			})
			return
		}

		pendingStore.Put(user.ID, secret)
		writeJSON(w, http.StatusOK, totpEnableResponse{
			QRURI:       auth.BuildTOTPURI(user.Username, secret, "OwnCord"),
			BackupCodes: []string{},
		})
	}
}

func handleConfirmTOTP(database *db.DB, pendingStore *auth.PendingTOTPStore, usedTOTPCodes *auth.UsedTOTPCodeStore, limiter *auth.RateLimiter, totpKey []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// BUG-111: Per-user lockout for password confirmation.
		lockKey := fmt.Sprintf("pw_confirm_lock:%d", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
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
		failKey := fmt.Sprintf("pw_confirm_fail:%d", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(failKey)

		secret, ok := pendingStore.Lookup(user.ID)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "no pending two-factor enrollment found",
			})
			return
		}

		if !auth.VerifyTOTPCodeOnce(secret, strings.TrimSpace(req.Code), time.Now().UTC(), user.ID, usedTOTPCodes) {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid two-factor code",
			})
			return
		}

		encryptedSecret, encErr := auth.EncryptTOTPSecret(totpKey, secret)
		if encErr != nil {
			slog.Error("failed to encrypt TOTP secret", "user_id", user.ID, "error", encErr)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to enable two-factor authentication",
			})
			return
		}

		if err := database.UpdateUserTOTPSecret(user.ID, &encryptedSecret); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to enable two-factor authentication",
			})
			return
		}
		pendingStore.Delete(user.ID)

		// BUG-108: Revoke all other sessions after 2FA state change.
		if sess, ok := r.Context().Value(SessionKey).(*db.Session); ok && sess != nil {
			n, _ := database.DeleteOtherSessions(user.ID, sess.ID)
			if n > 0 {
				slog.Info("revoked other sessions after totp enable", "user_id", user.ID, "revoked", n)
			}
		}

		slog.Info("totp enabled", "user_id", user.ID)
		_ = database.LogAudit(user.ID, "totp_enabled", "user", user.ID,
			"two-factor authentication enrolled")

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDisableTOTP(database *db.DB, pendingStore *auth.PendingTOTPStore, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// BUG-111: Per-user lockout for password confirmation.
		lockKey := fmt.Sprintf("pw_confirm_lock:%d", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
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
		failKey := fmt.Sprintf("pw_confirm_fail:%d", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(failKey)

		require2FA, err := isRequire2FAEnabled(database)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to load authentication policy",
			})
			return
		}
		if require2FA {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "two-factor authentication is required for this server",
			})
			return
		}

		pendingStore.Delete(user.ID)
		if err := database.UpdateUserTOTPSecret(user.ID, nil); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to disable two-factor authentication",
			})
			return
		}

		// BUG-108: Revoke all other sessions after 2FA state change.
		if sess, ok := r.Context().Value(SessionKey).(*db.Session); ok && sess != nil {
			n, _ := database.DeleteOtherSessions(user.ID, sess.ID)
			if n > 0 {
				slog.Info("revoked other sessions after totp disable", "user_id", user.ID, "revoked", n)
			}
		}

		slog.Info("totp disabled", "user_id", user.ID)
		_ = database.LogAudit(user.ID, "totp_disabled", "user", user.ID,
			"two-factor authentication disabled")

		w.WriteHeader(http.StatusNoContent)
	}
}
