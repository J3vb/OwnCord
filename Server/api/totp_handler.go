package api

import (
	"context"
	"encoding/json"
	"errors"
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

		totpRateLimitKey := auth.Key("totp_fail", challenge.UserID)
		// Atomically record this attempt and reject once the per-user failure cap
		// is reached. Recording up-front — rather than a read-only Check now and
		// Allow only on failure — closes a TOCTOU where many concurrent requests
		// reusing one valid partial token all pass the read-only check before any
		// failure is recorded, defeating the per-user brute-force cap (the only
		// cross-IP defence). A successful verification resets the counter below,
		// so legitimate retries are not penalised.
		// Deliberately NOT scaledAuthLimit: this cap is keyed per USER, and it
		// is the only cross-IP brute-force defence on TOTP codes. The
		// multiplier exists for shared-NAT per-IP limits; scaling a per-user
		// threshold with it would hand a distributed attacker more guesses.
		// Mirrors loginUserFailureThreshold staying unscaled in auth_handler.
		if !limiter.Allow(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		user, secret, ok := totpChallengeSecret(w, r, database, totpKey, challenge.UserID)
		if !ok {
			return
		}

		if !auth.VerifyTOTPCodeOnce(secret, strings.TrimSpace(req.Code), time.Now().UTC(), user.ID, usedTOTPCodes) {
			// The attempt was already recorded atomically up-front via
			// limiter.Allow; only the per-partial-token counter is advanced here.
			partialStore.RegisterFailure(partialToken, partialAuthMaxFailures)
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid two-factor code",
			})
			return
		}

		limiter.Reset(r.Context(), totpRateLimitKey)

		if _, ok := partialStore.Consume(partialToken); !ok {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid or expired two-factor challenge",
			})
			return
		}

		token, err := issueSession(r.Context(), database, user.ID, challenge.Device, challenge.IP)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create session",
			})
			return
		}

		slog.Info("totp verified", "user_id", user.ID, "ip", challenge.IP)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "totp_verified", "user", user.ID,
			"two-factor verification completed from "+challenge.IP)

		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

// totpChallengeSecret resolves the user behind a partial-auth challenge and
// returns their decrypted TOTP secret. It writes its own refusal, so a false
// third result means the response is already complete.
func totpChallengeSecret(w http.ResponseWriter, r *http.Request, database *db.DB, totpKey []byte, challengeUserID int64) (*db.User, string, bool) {
	user, err := database.GetUserByID(r.Context(), challengeUserID)
	if err != nil || user == nil || user.TOTPSecret == nil {
		writeJSON(w, http.StatusUnauthorized, errorResponse{
			Error:   "UNAUTHORIZED",
			Message: "invalid or expired two-factor challenge",
		})
		return nil, "", false
	}

	// A ban can land inside the partial-token window; the login path
	// refuses banned users right after the password compare, so the
	// second factor must refuse them too.
	if auth.IsEffectivelyBanned(user) {
		writeJSON(w, http.StatusForbidden, errorResponse{
			Error:   "FORBIDDEN",
			Message: "your account has been suspended",
		})
		return nil, "", false
	}

	secret, decErr := auth.DecryptTOTPSecret(totpKey, *user.TOTPSecret)
	if decErr != nil {
		slog.Error("failed to decrypt TOTP secret", "user_id", user.ID, "error", decErr)
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "failed to verify two-factor code",
		})
		return nil, "", false
	}

	return user, secret, true
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
		lockKey := auth.Key("pw_confirm_lock", user.ID)
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
		failKey := auth.Key("pw_confirm_fail", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(r.Context(), failKey)

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

// revokeOtherSessionsAfterAuthChange revokes every session for userID except
// keepSessionID as the security tail of a committed 2FA state change. It
// mirrors UserService.ChangePassword (service/user.go:262-274): a failure is
// logged and retried once (bounded compensating retry for transient write
// contention); if the retry also fails, revoked reports what did succeed and
// failed is true so the caller can report a partial success instead of
// silently claiming the other sessions were revoked when they were not.
func revokeOtherSessionsAfterAuthChange(ctx context.Context, database *db.DB, userID, keepSessionID int64, action string) (revoked int64, failed bool) {
	revoked, err := database.DeleteOtherSessions(ctx, userID, keepSessionID)
	if err != nil {
		slog.Error("DeleteOtherSessions after "+action, "err", err, "user_id", userID)
		revokedRetry, retryErr := database.DeleteOtherSessions(ctx, userID, keepSessionID)
		if retryErr != nil {
			slog.Error("DeleteOtherSessions retry after "+action, "err", retryErr, "user_id", userID)
			return revoked, true
		}
		revoked += revokedRetry
	}
	if revoked > 0 {
		slog.Info("revoked other sessions after "+action, "user_id", userID, "revoked", revoked)
	}
	return revoked, false
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
		lockKey := auth.Key("pw_confirm_lock", user.ID)
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
		failKey := auth.Key("pw_confirm_fail", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(r.Context(), failKey)

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

		if err := database.UpdateUserTOTPSecret(r.Context(), user.ID, &encryptedSecret); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to enable two-factor authentication",
			})
			return
		}
		pendingStore.Delete(user.ID)

		// BUG-108: Revoke all other sessions after 2FA state change. An
		// API-token principal has a nil session; keep=0 matches no row, so
		// every login session is revoked — same semantics as change-password.
		sess, _ := r.Context().Value(SessionKey).(*db.Session)
		keepSessionID := int64(0)
		if sess != nil {
			keepSessionID = sess.ID
		}
		// Security tail of the 2FA change: once the secret update committed,
		// revoking the other sessions must not be aborted by a dead request.
		tailCtx := context.WithoutCancel(r.Context())
		revoked, revokeFailed := revokeOtherSessionsAfterAuthChange(tailCtx, database, user.ID, keepSessionID, "totp enable")

		slog.Info("totp enabled", "user_id", user.ID)
		db.WriteAudit(tailCtx, database, user.ID, "totp_enabled", "user", user.ID,
			"two-factor authentication enrolled")

		if revokeFailed {
			// Partial success: 2FA IS enabled; only revoking the other
			// sessions failed. A 5xx here would be a lie — the state change
			// already committed — so mirror the ChangePassword contract
			// (api/profile_handler.go) and report 200 with an explicit warning
			// instead of a silent, unqualified 204.
			writeJSON(w, http.StatusOK, map[string]any{
				"warning":          "two-factor authentication enabled, but other sessions could not be revoked; revoke them from the sessions list",
				"sessions_revoked": revoked,
			})
			return
		}

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
		lockKey := auth.Key("pw_confirm_lock", user.ID)
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
		failKey := auth.Key("pw_confirm_fail", user.ID)
		if err := requirePasswordConfirmation(user, req.Password); err != nil {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}
		limiter.Reset(r.Context(), failKey)

		require2FA, err := isRequire2FAEnabled(r.Context(), database)
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
		if err := database.UpdateUserTOTPSecret(r.Context(), user.ID, nil); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to disable two-factor authentication",
			})
			return
		}

		// BUG-108: Revoke all other sessions after 2FA state change. An
		// API-token principal has a nil session; keep=0 matches no row, so
		// every login session is revoked — same semantics as change-password.
		sess, _ := r.Context().Value(SessionKey).(*db.Session)
		keepSessionID := int64(0)
		if sess != nil {
			keepSessionID = sess.ID
		}
		// Security tail of the 2FA change: once the secret update committed,
		// revoking the other sessions must not be aborted by a dead request.
		tailCtx := context.WithoutCancel(r.Context())
		revoked, revokeFailed := revokeOtherSessionsAfterAuthChange(tailCtx, database, user.ID, keepSessionID, "totp disable")

		slog.Info("totp disabled", "user_id", user.ID)
		db.WriteAudit(tailCtx, database, user.ID, "totp_disabled", "user", user.ID,
			"two-factor authentication disabled")

		if revokeFailed {
			// Partial success: 2FA IS disabled; only revoking the other
			// sessions failed. A 5xx here would be a lie — the state change
			// already committed — so mirror the ChangePassword contract
			// (api/profile_handler.go) and report 200 with an explicit warning
			// instead of a silent, unqualified 204.
			writeJSON(w, http.StatusOK, map[string]any{
				"warning":          "two-factor authentication disabled, but other sessions could not be revoked; revoke them from the sessions list",
				"sessions_revoked": revoked,
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
