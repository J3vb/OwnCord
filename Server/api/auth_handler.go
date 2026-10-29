package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// maxLoginUsernameLen bounds the username accepted by handleLogin, mirroring
// auth.ValidateUsername's 32-rune cap on registered usernames. Enforced
// before the value is ever used to build a RateLimiter map key — see the
// check in loginReadRequest for why.
const maxLoginUsernameLen = 32

// registerRequest is the JSON body for POST /api/v1/auth/register.
type registerRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	InviteCode string `json:"invite_code"`
}

// loginRequest is the JSON body for POST /api/v1/auth/login.
type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// authSuccessResponse is returned on successful login/register.
type authSuccessResponse struct {
	Token        string        `json:"token,omitempty"`
	PartialToken string        `json:"partial_token,omitempty"`
	Requires2FA  bool          `json:"requires_2fa"`
	User         *userResponse `json:"user,omitempty"`
	// RecoveryCodesRemaining is present only when an emergency recovery
	// code completed the second step: how many the account has left.
	RecoveryCodesRemaining *int `json:"recovery_codes_remaining,omitempty"`
}

// MountAuthRoutes registers all auth endpoints on the given router. svc owns
// every decision below the transport (service.AuthService in production, see
// AuthService); requireAuth is the AuthMiddleware the authenticated routes
// mount, built by the caller because it needs the database handle this file
// no longer sees. Rate limiters are applied per-endpoint as specified;
// trustedProxies is the list of CIDRs whose X-Forwarded-For / X-Real-IP
// headers are honoured for rate-limiting IP resolution.
func MountAuthRoutes(r chi.Router, svc AuthService, requireAuth func(http.Handler) http.Handler, limiter *auth.RateLimiter, trustedProxies []string) {
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.With(RateLimitMiddleware(limiter, "register:", scaledAuthLimit(registerRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/register", handleRegister(svc, trustedProxies))

		r.With(RateLimitMiddleware(limiter, "login:", scaledAuthLimit(loginRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/login", handleLogin(svc, trustedProxies))

		r.With(RateLimitMiddleware(limiter, "totp_verify:", scaledAuthLimit(verifyTOTPRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/verify-totp", handleVerifyTOTP(svc))

		r.With(requireAuth).
			Post("/logout", handleLogout(svc))

		r.With(requireAuth).
			Get("/me", handleMe())

		r.With(requireAuth,
			RateLimitMiddleware(limiter, "del_account:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
			Delete("/account", handleDeleteAccount(svc))
	})

	r.With(requireAuth,
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/enable", handleEnableTOTP(svc))

	r.With(requireAuth,
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/confirm", handleConfirmTOTP(svc))

	r.With(requireAuth,
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Delete("/api/v1/users/me/totp", handleDisableTOTP(svc))

	r.With(requireAuth,
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/recovery-codes", handleRegenerateRecoveryCodes(svc))

	// The recovery kit: enrolment and status beside the credential
	// routes, redemption public and budgeted like login.
	r.With(requireAuth,
		RateLimitMiddleware(limiter, "kit:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/recovery-kit", handleEnrolRecoveryKit(svc))
	r.With(requireAuth).
		Get("/api/v1/users/me/recovery-kit", handleRecoveryKitStatus(svc))
	r.With(RateLimitMiddleware(limiter, "recover:", scaledAuthLimit(loginRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/auth/recover", handleRecover(svc, trustedProxies))
}

// handleRegister processes POST /api/v1/auth/register.
func handleRegister(svc AuthService, trustedProxies []string) http.HandlerFunc {
	proxyNets := parseCIDRList(trustedProxies) // parse once at construction
	return func(w http.ResponseWriter, r *http.Request) {
		// The policy gate runs before any credential is read: a closed
		// server refuses even a malformed body with the policy's 403.
		if err := svc.RegistrationPolicy(r.Context()); err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}

		req, ok := registerReadRequest(w, r)
		if !ok {
			return
		}

		res, err := svc.Register(r.Context(), service.RegisterInput{
			Username:   req.Username,
			Password:   req.Password,
			InviteCode: req.InviteCode,
			Device:     truncateDevice(r.Header.Get("User-Agent")),
			IP:         clientIPWithProxies(r, proxyNets),
		})
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		if res.PendingApproval {
			// Approval mode: the application is recorded and an admin
			// decides; there is no session to hand out yet.
			writeJSON(w, http.StatusAccepted, registrationPendingResponse{Status: "pending_approval"})
			return
		}
		writeJSON(w, http.StatusCreated, authResponse(res))
	}
}

// registrationPendingResponse is the 202 body of an approval-mode
// registration: the application exists, an admin decides, and the applicant
// signs in normally once approved.
type registrationPendingResponse struct {
	Status string `json:"status"`
}

// registerReadRequest decodes and validates the registration body, writing the
// rejection response itself when the input cannot be used.
func registerReadRequest(w http.ResponseWriter, r *http.Request) (registerRequest, bool) {
	var req registerRequest
	if !decodeJSON(w, r, &req) {
		return req, false
	}

	// Bound the raw field before it ever reaches the fixpoint
	// sanitizer below. sanitizeToFixpoint's cost is quadratic in input
	// length (nested HTML entities force roughly one extra pass per two
	// nesting levels), so an unauthenticated caller could otherwise pin a
	// core for minutes with one oversized username, all before
	// auth.ValidateUsername's 32-rune cap ever runs. This is a cheap
	// byte-length pre-check — *4 still admits any legitimate 32-rune UTF-8
	// username — mirroring sanitizeContent's raw-length bound in
	// service/message.go and loginReadRequest's username bound below.
	if len(req.Username) > maxLoginUsernameLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is too long")
		return req, false
	}

	// F: use the fixpoint sanitizer (service.SanitizeText), not a bare
	// bluemonday.StrictPolicy().Sanitize call — Sanitize's output is always HTML-escaped
	// (' -> &#39;, & -> &amp;, " -> &#34;), so a plain call here would store
	// a different string than what handleLogin looks up (which only
	// trims), permanently locking out any username containing one of
	// those characters. See service.SanitizeText's doc comment.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	req.InviteCode = strings.TrimSpace(req.InviteCode)

	// Whether an invite is needed depends on the registration mode,
	// which the service decides; only the credentials are required here.
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username and password are required")
		return req, false
	}

	// Validate username format (strict rules for a name being chosen).
	if err := auth.ValidateNewUsername(req.Username); err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
		return req, false
	}

	// Validate password strength before anything else.
	if err := auth.ValidatePasswordStrength(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
		return req, false
	}
	return req, true
}

// handleLogin processes POST /api/v1/auth/login.
func handleLogin(svc AuthService, trustedProxies []string) http.HandlerFunc {
	proxyNets := parseCIDRList(trustedProxies) // parse once at construction
	return func(w http.ResponseWriter, r *http.Request) {
		req, ok := loginReadRequest(w, r)
		if !ok {
			return
		}

		res, err := svc.Login(r.Context(), service.LoginInput{
			Username: req.Username,
			Password: req.Password,
			Device:   truncateDevice(r.Header.Get("User-Agent")),
			IP:       clientIPWithProxies(r, proxyNets),
		})
		if err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, authResponse(res))
	}
}

// loginReadRequest decodes and validates the login body, writing the rejection
// response itself when the input cannot be used.
func loginReadRequest(w http.ResponseWriter, r *http.Request) (loginRequest, bool) {
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return req, false
	}

	req.Username = strings.TrimSpace(req.Username)
	// Do NOT trim req.Password — passwords may intentionally contain
	// leading/trailing whitespace. Bcrypt handles arbitrary bytes.

	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username and password are required")
		return req, false
	}

	// F: reject an over-long username before it is ever used to build a
	// RateLimiter map key (unameKey, failKey, userFailKey, lockout keys in
	// service.AuthService). Unlike registration, login has no account to
	// validate against yet, so nothing else bounds this value — an
	// unauthenticated caller could otherwise pin an arbitrarily large,
	// body-sized string as a retained key (Cleanup only evicts it after
	// hours). Mirrors the same 32-rune cap auth.ValidateUsername enforces at
	// registration.
	if utf8.RuneCountInString(req.Username) > maxLoginUsernameLen {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is too long")
		return req, false
	}
	return req, true
}

// handleLogout processes POST /api/v1/auth/logout.
func handleLogout(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok || p.Session == nil {
			writeNotAuthenticated(w)
			return
		}
		if err := svc.Logout(r.Context(), p); err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleMe processes GET /api/v1/auth/me.
func handleMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}
		writeJSON(w, http.StatusOK, toUserResponse(p.User))
	}
}

// deleteAccountRequest is the JSON body for DELETE /api/v1/auth/account.
type deleteAccountRequest struct {
	Password string `json:"password"`
}

// handleDeleteAccount processes DELETE /api/v1/auth/account. The caller must
// supply their current password for confirmation; the lockout, the compare
// and the member_ban broadcast are the service's.
func handleDeleteAccount(svc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}

		var req deleteAccountRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		if err := svc.DeleteAccount(r.Context(), p, req.Password, clientIP(r)); err != nil {
			writeAuthError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// authResponse encodes a service result: a session, or the two-factor
// challenge Login started instead of one.
func authResponse(res *service.AuthResult) authSuccessResponse {
	if res.Requires2FA {
		return authSuccessResponse{
			PartialToken: res.PartialToken,
			Requires2FA:  true,
		}
	}
	return authSuccessResponse{
		Token:                  res.Token,
		Requires2FA:            false,
		User:                   toUserResponse(res.User),
		RecoveryCodesRemaining: res.RecoveryCodesRemaining,
	}
}

// writeNotAuthenticated is the refusal for a route mounted behind
// AuthMiddleware that still finds no usable principal on the request.
func writeNotAuthenticated(w http.ResponseWriter) {
	writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
}

// writeAuthError encodes a service.Err* refusal from the auth slice. Each
// named value's Error() is the public message; its category picks the
// status and code, and three values carry a code of their own. Anything that
// is not an auth refusal is a contract bug in the service, logged and
// answered as a generic 500 so no cause leaks to the client.
func writeAuthError(ctx context.Context, w http.ResponseWriter, err error) {
	var status int
	var code httperr.Code
	switch {
	case errors.Is(err, service.ErrRegistrationRejected):
		status, code = http.StatusBadRequest, httperr.CodeInvalidCredentials
	case errors.Is(err, service.ErrTOTPAlreadyEnabled):
		status, code = http.StatusConflict, httperr.CodeTOTPAlreadyEnabled
	case errors.Is(err, service.ErrConflict):
		status, code = http.StatusConflict, httperr.CodeConflict
	case errors.Is(err, service.ErrAuthBusy):
		writeAuthBusy(w, err)
		return
	case errors.Is(err, service.ErrRateLimited):
		status, code = http.StatusTooManyRequests, httperr.CodeRateLimited
	case errors.Is(err, service.ErrUnauthorized):
		status, code = http.StatusUnauthorized, httperr.CodeUnauthorized
	case errors.Is(err, service.ErrForbidden):
		status, code = http.StatusForbidden, httperr.CodeForbidden
	case errors.Is(err, service.ErrInvalidInput):
		status, code = http.StatusBadRequest, httperr.CodeInvalidInput
	case errors.Is(err, service.ErrBadRequest):
		status, code = http.StatusBadRequest, httperr.CodeBadRequest
	case errors.Is(err, service.ErrInternal):
		status, code = http.StatusInternalServerError, httperr.CodeInternalError
		if _, bare := err.(interface{ Is(error) bool }); !bare {
			slog.ErrorContext(ctx, "auth service returned a non-refusal error", "error", err)
			writeErr(w, status, code, "internal error")
			return
		}
	default:
		slog.ErrorContext(ctx, "auth service returned a non-refusal error", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal error")
		return
	}
	writeErr(w, status, code, err.Error())
}

// writeAuthBusy answers an admission refusal as 429 AUTH_BUSY, a code
// apart from the per-IP RATE_LIMITED so a client can tell the server's load
// from its own pace. A refusal from the queue (P5-S02) carries the budget's
// retry hint, sent as Retry-After in whole seconds.
func writeAuthBusy(w http.ResponseWriter, err error) {
	var hinted interface{ RetryAfter() time.Duration }
	if errors.As(err, &hinted) {
		secs := int((hinted.RetryAfter() + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(max(secs, 1)))
	}
	writeErr(w, http.StatusTooManyRequests, httperr.CodeAuthBusy, service.ErrAuthBusy.Error())
}

// truncateDevice truncates the User-Agent to prevent oversized session records.
const maxDeviceLen = 512

func truncateDevice(ua string) string {
	if len(ua) > maxDeviceLen {
		return ua[:maxDeviceLen]
	}
	return ua
}
