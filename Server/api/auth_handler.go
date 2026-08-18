package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
)

// sanitizer strips all HTML from user-supplied strings before storage.
var sanitizer = bluemonday.StrictPolicy()

// maxLoginUsernameLen bounds the username accepted by handleLogin, mirroring
// auth.ValidateUsername's 32-rune cap on registered usernames. Enforced
// before the value is ever used to build a RateLimiter map key — see the
// check in handleLogin for why.
const maxLoginUsernameLen = 32

// genericAuthError is returned for all login/register failures to avoid
// revealing whether a username exists.
var genericAuthError = errorResponse{
	Error:   "INVALID_CREDENTIALS",
	Message: "invalid invite or credentials",
}

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

// userResponse is the user shape included in auth responses.
type userResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar,omitempty"`
	// DisplayName and About are always present (null = unset) so the settings
	// form can tell "cleared" from "the server does not know this field".
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// CustomStatus is the user's own free-text status line.
	CustomStatus *string `json:"custom_status"`
	// Status is the user's own true status, invisible included. This response
	// only ever describes the caller, so there is nothing to hide from them.
	Status      string `json:"status"`
	RoleID      int64  `json:"role_id"`
	TOTPEnabled bool   `json:"totp_enabled"`
	CreatedAt   string `json:"created_at"`
}

// authSuccessResponse is returned on successful login/register.
type authSuccessResponse struct {
	Token        string        `json:"token,omitempty"`
	PartialToken string        `json:"partial_token,omitempty"`
	Requires2FA  bool          `json:"requires_2fa"`
	User         *userResponse `json:"user,omitempty"`
}

// AuthBroadcaster is the interface handleDeleteAccount uses to notify
// connected WebSocket clients that an account is gone. Satisfied by *ws.Hub
// (which already implements BroadcastMemberBan for the admin ban path this
// mirrors).
type AuthBroadcaster interface {
	BroadcastMemberBan(userID int64)
}

// MountAuthRoutes registers all auth endpoints on the given router.
// Rate limiters are applied per-endpoint as specified. trustedProxies is the
// list of CIDRs whose X-Forwarded-For / X-Real-IP headers are honoured for
// rate-limiting IP resolution. totpKey is the AES-256 key used to encrypt
// TOTP secrets at rest (M1 security hardening).
//
// broadcaster is variadic and optional: MountAuthRoutes is called before the
// hub exists (router.go mounts auth routes first, and the hub needs the
// router to register its own webhook route), so a caller that cannot supply
// one yet may omit it entirely and self-deletion simply sends no event,
// exactly like today. A caller mounted after hub creation should pass it so
// DELETE /api/v1/auth/account can broadcast the same member_ban event the
// admin ban path already sends for the identical anonymise-and-ban DB state.
func MountAuthRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, trustedProxies []string, totpKey []byte, broadcaster ...AuthBroadcaster) {
	var ab AuthBroadcaster
	if len(broadcaster) > 0 {
		ab = broadcaster[0]
	}
	registerLimiter := limiter
	loginLimiter := limiter
	partialStore := auth.NewPartialAuthStore(partialAuthStoreTTL)
	pendingTOTPStore := auth.NewPendingTOTPStore(pendingTOTPStoreTTL)
	usedTOTPCodes := auth.NewUsedTOTPCodeStore()

	r.Route("/api/v1/auth", func(r chi.Router) {
		r.With(RateLimitMiddleware(registerLimiter, "register:", scaledAuthLimit(registerRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/register", handleRegister(database, trustedProxies))

		r.With(RateLimitMiddleware(loginLimiter, "login:", scaledAuthLimit(loginRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/login", handleLogin(database, limiter, partialStore, trustedProxies))

		r.With(RateLimitMiddleware(limiter, "totp_verify:", scaledAuthLimit(verifyTOTPRateLimitPerMinute), time.Minute, trustedProxies)).
			Post("/verify-totp", handleVerifyTOTP(database, partialStore, limiter, usedTOTPCodes, totpKey))

		r.With(AuthMiddleware(database)).
			Post("/logout", handleLogout(database))

		r.With(AuthMiddleware(database)).
			Get("/me", handleMe())

		r.With(AuthMiddleware(database),
			RateLimitMiddleware(limiter, "del_account:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
			Delete("/account", handleDeleteAccount(database, limiter, ab))
	})

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/enable", handleEnableTOTP(pendingTOTPStore, limiter))

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Post("/api/v1/users/me/totp/confirm", handleConfirmTOTP(database, pendingTOTPStore, usedTOTPCodes, limiter, totpKey))

	r.With(AuthMiddleware(database),
		RateLimitMiddleware(limiter, "totp:", scaledAuthLimit(sensitiveEndpointRateLimitPerMinute), time.Minute, trustedProxies)).
		Delete("/api/v1/users/me/totp", handleDisableTOTP(database, pendingTOTPStore, limiter))
}

// handleRegister processes POST /api/v1/auth/register.
func handleRegister(database *db.DB, trustedProxies []string) http.HandlerFunc {
	proxyNets := parseCIDRList(trustedProxies) // W3-3a: parse once at construction
	return func(w http.ResponseWriter, r *http.Request) {
		if !registerPolicyGate(w, r, database) {
			return
		}

		req, ok := registerReadRequest(w, r)
		if !ok {
			return
		}

		// Hash password before consuming the invite so that a hashing failure
		// does not burn a valid invite code.
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to process registration",
			})
			return
		}

		// Atomically consume the invite and create the user so failed
		// registrations do not burn a valid invite code.
		uid, err := database.CreateUserWithInvite(r.Context(), req.Username, hash, int(permissions.MemberRoleID), req.InviteCode)
		if err != nil {
			// UNIQUE constraint violation → duplicate username → 400.
			// Any other DB error → 500.
			switch {
			case db.IsUniqueConstraintError(err):
				writeJSON(w, http.StatusBadRequest, genericAuthError)
			case errors.Is(err, db.ErrNotFound):
				writeJSON(w, http.StatusBadRequest, genericAuthError)
			default:
				slog.Error("CreateUserWithInvite failed", "err", err, "username", req.Username)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "registration failed — please try again",
				})
			}
			return
		}

		ip := clientIPWithProxies(r, proxyNets)
		slog.Info("user registered", "username", req.Username, "user_id", uid, "ip", ip)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, uid, "user_register", "user", uid,
			"new account created via invite")

		// Issue session.
		token, err := auth.GenerateToken()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create session",
			})
			return
		}

		device := truncateDevice(r.Header.Get("User-Agent"))
		if _, err := database.CreateSession(r.Context(), uid, auth.HashToken(token), device, ip); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create session",
			})
			return
		}

		user, err := database.GetUserByID(r.Context(), uid)
		if err != nil || user == nil {
			slog.Error("failed to fetch user after registration", "user_id", uid, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "registration succeeded but user fetch failed",
			})
			return
		}
		writeJSON(w, http.StatusCreated, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

// registerPolicyGate reports whether registration is currently permitted,
// writing the refusal response itself when it is not.
func registerPolicyGate(w http.ResponseWriter, r *http.Request, database *db.DB) bool {
	registrationOpen, err := isRegistrationOpen(r.Context(), database)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "failed to load registration policy",
		})
		return false
	}
	if !registrationOpen {
		writeJSON(w, http.StatusForbidden, errorResponse{
			Error:   "FORBIDDEN",
			Message: "registration is currently closed",
		})
		return false
	}

	require2FA, err := isRequire2FAEnabled(r.Context(), database)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "failed to load registration policy",
		})
		return false
	}
	if require2FA {
		writeJSON(w, http.StatusForbidden, errorResponse{
			Error:   "FORBIDDEN",
			Message: "registration is unavailable while two-factor authentication is required",
		})
		return false
	}
	return true
}

// registerReadRequest decodes and validates the registration body, writing the
// rejection response itself when the input cannot be used.
func registerReadRequest(w http.ResponseWriter, r *http.Request) (registerRequest, bool) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: "malformed request body",
		})
		return req, false
	}

	// F: use the fixpoint sanitizer (service.SanitizeText), not the bare
	// sanitizer.Sanitize below — Sanitize's output is always HTML-escaped
	// (' -> &#39;, & -> &amp;, " -> &#34;), so a plain call here would store
	// a different string than what handleLogin looks up (which only
	// trims), permanently locking out any username containing one of
	// those characters. See service.SanitizeText's doc comment.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	req.InviteCode = strings.TrimSpace(req.InviteCode)

	if req.Username == "" || req.Password == "" || req.InviteCode == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: "username, password, and invite_code are required",
		})
		return req, false
	}

	// Validate username format (length, no control/invisible chars).
	if err := auth.ValidateUsername(req.Username); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: err.Error(),
		})
		return req, false
	}

	// Validate password strength before anything else.
	if err := auth.ValidatePasswordStrength(req.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: err.Error(),
		})
		return req, false
	}
	return req, true
}

// handleLogin processes POST /api/v1/auth/login.
func handleLogin(database *db.DB, limiter *auth.RateLimiter, partialStore *auth.PartialAuthStore, trustedProxies []string) http.HandlerFunc {
	proxyNets := parseCIDRList(trustedProxies) // W3-3a: parse once at construction
	return func(w http.ResponseWriter, r *http.Request) {
		req, ok := loginReadRequest(w, r)
		if !ok {
			return
		}

		ip := clientIPWithProxies(r, proxyNets)

		user, ok := loginAuthenticate(w, r, database, limiter, req, ip)
		if !ok {
			return
		}

		if auth.IsEffectivelyBanned(user) {
			slog.Warn("banned user login attempt", "username", user.Username, "user_id", user.ID, "ip", ip)
			db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "login_blocked_banned", "user", user.ID,
				"banned user attempted login from "+ip)
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "your account has been suspended",
			})
			return
		}

		require2FA, err := isRequire2FAEnabled(r.Context(), database)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to load authentication policy",
			})
			return
		}
		if user.TOTPSecret != nil {
			partialToken, err := partialStore.Issue(user.ID, truncateDevice(r.Header.Get("User-Agent")), ip)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "failed to start two-factor challenge",
				})
				return
			}
			writeJSON(w, http.StatusOK, authSuccessResponse{
				PartialToken: partialToken,
				Requires2FA:  true,
			})
			return
		}
		if require2FA {
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "two-factor authentication must be enabled on this account before login",
			})
			return
		}

		// Issue session.
		token, err := issueSession(r.Context(), database, user.ID, truncateDevice(r.Header.Get("User-Agent")), ip)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to create session",
			})
			return
		}

		// Don't set status to "online" here — the WebSocket connection in
		// serve.go does that when the user actually connects. Setting it here
		// would leave the user permanently "online" if they never open a WS
		// connection or if the client crashes before connecting.
		slog.Info("user logged in", "username", user.Username, "user_id", user.ID, "ip", ip)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "user_login", "user", user.ID,
			"logged in from "+ip)
		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token:       token,
			Requires2FA: false,
			User:        toUserResponse(user),
		})
	}
}

// loginReadRequest decodes and validates the login body, writing the rejection
// response itself when the input cannot be used.
func loginReadRequest(w http.ResponseWriter, r *http.Request) (loginRequest, bool) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: "malformed request body",
		})
		return req, false
	}

	req.Username = strings.TrimSpace(req.Username)
	// Do NOT trim req.Password — passwords may intentionally contain
	// leading/trailing whitespace. Bcrypt handles arbitrary bytes.

	if req.Username == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: "username and password are required",
		})
		return req, false
	}

	// F: reject an over-long username before it is ever used to build a
	// RateLimiter map key below (unameKey, failKey, userFailKey, lockout
	// keys). Unlike registration, login has no account to validate
	// against yet, so nothing else bounds this value — an unauthenticated
	// caller could otherwise pin an arbitrarily large, body-sized string
	// as a retained key (Cleanup only evicts it after hours). Mirrors the
	// same 32-rune cap auth.ValidateUsername enforces at registration.
	if utf8.RuneCountInString(req.Username) > maxLoginUsernameLen {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INVALID_INPUT",
			Message: "username is too long",
		})
		return req, false
	}
	return req, true
}

// loginAuthenticate runs the lockout gates, the constant-time password compare
// and the failure accounting for one login attempt. It returns the
// authenticated user, or false after writing the rejection response itself.
func loginAuthenticate(w http.ResponseWriter, r *http.Request, database *db.DB, limiter *auth.RateLimiter, req loginRequest, ip string) (*db.User, bool) {
	// Check per-IP lockout first.
	lockKey := "login_lock:" + ip
	if limiter.IsLockedOut(lockKey) {
		writeJSON(w, http.StatusTooManyRequests, errorResponse{
			Error:   "RATE_LIMITED",
			Message: "account temporarily locked due to too many failed attempts",
		})
		return nil, false
	}

	// BUG-110: Also check per-username lockout to prevent distributed brute force.
	// F1: canonicalize the username the same way GetUserByUsername does (COLLATE
	// NOCASE) before keying the lockout, so case variants of one account
	// (admin/Admin/ADMIN) share a single bucket instead of each getting its own.
	unameKey := strings.ToLower(req.Username)
	userLockKey := "login_user_lock:" + unameKey
	if limiter.IsLockedOut(userLockKey) {
		writeJSON(w, http.StatusTooManyRequests, errorResponse{
			Error:   "RATE_LIMITED",
			Message: "account temporarily locked due to too many failed attempts",
		})
		return nil, false
	}

	// Constant-time lookup: always attempt bcrypt compare even when user
	// does not exist to prevent timing-based username enumeration.
	user, err := database.GetUserByUsername(r.Context(), req.Username)

	// Distinguish DB errors from authentication failures. DB errors
	// should NOT increment the rate limiter — otherwise a transient
	// DB outage would lock out legitimate users.
	if err != nil && user == nil {
		// Could be a real DB error or simply "user not found".
		// GetUserByUsername returns (nil, nil) for not-found, so a
		// non-nil error here is a genuine DB failure.
		slog.Error("login: GetUserByUsername failed", "err", err, "ip", ip)
		writeJSON(w, http.StatusInternalServerError, errorResponse{
			Error:   "INTERNAL_ERROR",
			Message: "login temporarily unavailable",
		})
		return nil, false
	}

	failKey := "login_fail:" + ip
	userFailKey := "login_user_fail:" + unameKey
	// F3: atomically reserve this attempt BEFORE the bcrypt compare. The
	// read-only IsLockedOut gates above are check-then-act: N concurrent
	// requests all pass them before any failure is recorded below, so the
	// per-username cap — the only cross-IP brute-force defence — bound
	// only sequential attackers. Allow records the attempt under the
	// limiter's lock, capping a concurrent burst at the same budget a
	// sequential attacker gets. Sized at threshold+1 so the sequential
	// accepted-input set is unchanged: failures 1–10 still land, the 10th
	// still trips the lockout (via the Check below), and a correct
	// password on attempt 10 still succeeds — successful logins reset
	// both counters. The reservation sits after the DB-error return above
	// so a transient DB outage still does not consume attempts.
	if !limiter.Allow(failKey, scaledAuthLimit(loginFailureThreshold)+1, loginFailureWindow) ||
		!limiter.Allow(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
		writeJSON(w, http.StatusTooManyRequests, errorResponse{
			Error:   "RATE_LIMITED",
			Message: "account temporarily locked due to too many failed attempts",
		})
		return nil, false
	}
	// Always run the password check — with an empty hash when the user does
	// not exist. auth.CheckPassword performs a dummy bcrypt comparison for an
	// empty hash, so bcrypt executes on every path and response time stays
	// constant, preventing timing-based username enumeration. (A `user == nil
	// || CheckPassword(...)` short-circuit would skip bcrypt entirely for
	// unknown usernames, reintroducing the timing side-channel.)
	storedHash := ""
	if user != nil {
		storedHash = user.PasswordHash
	}
	if !auth.CheckPassword(storedHash, req.Password) {
		// The attempt was already recorded atomically up-front (F3); here
		// only decide the lockouts, at the same boundary as before: the
		// 10th in-window failure locks the key. Check is read-only, so
		// the reservation is not double-counted.
		if !limiter.Check(failKey, scaledAuthLimit(loginFailureThreshold)+1, loginFailureWindow) {
			limiter.Lockout(r.Context(), lockKey, loginLockoutDuration)
		}
		// BUG-110: per-username lockout on threshold.
		if !limiter.Check(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
			limiter.Lockout(r.Context(), userLockKey, loginUserLockoutDuration)
		}
		slog.Info("login failed", "ip", ip, "username_len", len(req.Username))
		writeJSON(w, http.StatusUnauthorized, errorResponse{
			Error:   "UNAUTHORIZED",
			Message: "invalid credentials",
		})
		return nil, false
	}

	// Reset failure counters on success.
	limiter.Reset(r.Context(), failKey)
	limiter.Reset(r.Context(), userFailKey)
	return user, true
}

// handleLogout processes POST /api/v1/auth/logout.
func handleLogout(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := r.Context().Value(SessionKey).(*db.Session)
		if !ok || sess == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// The client clears its token optimistically — once logout reaches the
		// server, the revocation must not die with a dropped connection.
		if err := database.DeleteSession(context.WithoutCancel(r.Context()), sess.TokenHash); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to logout",
			})
			return
		}

		// A custom status is a "what I am doing right now" note. Leaving it
		// standing after the user signed out states something about them that
		// is no longer true, so logout clears it — unlike the chosen presence
		// status, which is a preference and deliberately survives.
		if err := database.UpdateUserCustomStatus(context.WithoutCancel(r.Context()), sess.UserID, nil); err != nil {
			slog.Warn("failed to clear custom status on logout", "user_id", sess.UserID, "err", err)
		}

		slog.Info("user logged out", "user_id", sess.UserID)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, sess.UserID, "user_logout", "user", sess.UserID, "")

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleMe processes GET /api/v1/auth/me.
func handleMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}
		writeJSON(w, http.StatusOK, toUserResponse(user))
	}
}

// deleteAccountRequest is the JSON body for DELETE /api/v1/auth/account.
type deleteAccountRequest struct {
	Password string `json:"password"`
}

// handleDeleteAccount processes DELETE /api/v1/auth/account.
// The caller must supply their current password for confirmation.
// Progressive lockout mirrors the login handler: 3 failures → 15-min lock.
// broadcaster may be nil, in which case no event is sent and other connected
// clients converge on their next reconnect instead (same fallback every
// other broadcaster-optional handler in this package uses).
func handleDeleteAccount(database *db.DB, limiter *auth.RateLimiter, broadcaster AuthBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// Per-user lockout to prevent password brute-force on this destructive endpoint.
		lockKey := auth.Key("delete_lock", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		var req deleteAccountRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		if req.Password == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "password is required",
			})
			return
		}

		// Verify the supplied password matches the stored hash.
		failKey := auth.Key("delete_fail", user.ID)
		if !auth.CheckPassword(user.PasswordHash, req.Password) {
			if !limiter.Allow(failKey, deleteAccountFailureThreshold, deleteAccountFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, deleteAccountLockoutDuration)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "incorrect password",
			})
			return
		}
		limiter.Reset(r.Context(), failKey)

		if err := database.DeleteAccount(r.Context(), user.ID); err != nil {
			if errors.Is(err, db.ErrLastAdmin) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "cannot delete the last admin account",
				})
				return
			}
			slog.Error("DeleteAccount failed", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to delete account",
			})
			return
		}

		ip := clientIP(r)
		slog.Info("account deleted", "username", user.Username, "user_id", user.ID, "ip", ip)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "account_deleted", "user", user.ID,
			"account self-deleted from "+ip)

		// DeleteAccount left the row in exactly the state an admin ban does
		// (anonymised, banned, sessions revoked) — broadcast the same event so
		// every other connected client drops the deleted user immediately
		// instead of keeping their pre-deletion username until it reconnects.
		if broadcaster != nil {
			broadcaster.BroadcastMemberBan(user.ID)
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// toUserResponse converts a db.User to the API response shape.
func toUserResponse(u *db.User) *userResponse {
	avatar := ""
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	resp := &userResponse{
		ID:           u.ID,
		Username:     u.Username,
		Avatar:       avatar,
		DisplayName:  u.DisplayName,
		About:        u.About,
		CustomStatus: u.CustomStatus,
		Status:       u.Status,
		RoleID:       u.RoleID,
		TOTPEnabled:  u.TOTPSecret != nil,
		CreatedAt:    u.CreatedAt,
	}
	return resp
}

// truncateDevice truncates the User-Agent to prevent oversized session records.
const maxDeviceLen = 512

func truncateDevice(ua string) string {
	if len(ua) > maxDeviceLen {
		return ua[:maxDeviceLen]
	}
	return ua
}

func issueSession(ctx context.Context, database *db.DB, userID int64, device, ip string) (string, error) {
	token, err := auth.GenerateToken()
	if err != nil {
		return "", err
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), device, ip); err != nil {
		return "", err
	}
	return token, nil
}

func isRequire2FAEnabled(ctx context.Context, database *db.DB) (bool, error) {
	return getBooleanSetting(ctx, database, "require_2fa", false)
}

func isRegistrationOpen(ctx context.Context, database *db.DB) (bool, error) {
	return getBooleanSetting(ctx, database, "registration_open", true)
}

func getBooleanSetting(ctx context.Context, database *db.DB, key string, defaultValue bool) (bool, error) {
	value, err := database.GetSetting(ctx, key)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return defaultValue, nil
		}
		return false, err
	}
	return parseBooleanSettingValue(value)
}

func parseBooleanSettingValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean setting value %q", value)
	}
}

func requirePasswordConfirmation(user *db.User, password string) error {
	if password == "" {
		return fmt.Errorf("password is required")
	}
	if !auth.CheckPassword(user.PasswordHash, password) {
		return fmt.Errorf("password confirmation failed")
	}
	return nil
}
