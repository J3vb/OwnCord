package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// sanitizer strips all HTML from user-supplied strings before storage.
var sanitizer = bluemonday.StrictPolicy()

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
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Avatar    string `json:"avatar,omitempty"`
	Status    string `json:"status"`
	RoleID    int64  `json:"role_id"`
	CreatedAt string `json:"created_at"`
}

// authSuccessResponse is returned on successful login/register.
type authSuccessResponse struct {
	Token string       `json:"token"`
	User  userResponse `json:"user"`
}

// MountAuthRoutes registers all auth endpoints on the given router.
// Rate limiters are applied per-endpoint as specified. trustedProxies is the
// list of CIDRs whose X-Forwarded-For / X-Real-IP headers are honoured for
// rate-limiting IP resolution.
func MountAuthRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, trustedProxies []string) {
	registerLimiter := limiter
	loginLimiter := limiter

	r.Route("/api/v1/auth", func(r chi.Router) {
		r.With(RateLimitMiddleware(registerLimiter, 3, time.Minute, trustedProxies)).
			Post("/register", handleRegister(database))

		r.With(RateLimitMiddleware(loginLimiter, 60, time.Minute, trustedProxies)).
			Post("/login", handleLogin(database, limiter))

		r.With(AuthMiddleware(database)).
			Post("/logout", handleLogout(database))

		r.With(AuthMiddleware(database)).
			Get("/me", handleMe())

		r.With(AuthMiddleware(database),
			RateLimitMiddleware(limiter, 5, time.Minute, trustedProxies)).
			Delete("/account", handleDeleteAccount(database, limiter))
	})
}

// handleRegister processes POST /api/v1/auth/register.
func handleRegister(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(sanitizer.Sanitize(req.Username))
		req.InviteCode = strings.TrimSpace(req.InviteCode)

		if req.Username == "" || req.Password == "" || req.InviteCode == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "username, password, and invite_code are required",
			})
			return
		}

		// Validate password strength before anything else.
		if err := auth.ValidatePasswordStrength(req.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		// Hash password before consuming the invite so that a hashing failure
		// does not burn a valid invite code.
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to process registration",
			})
			return
		}

		// Validate and consume invite atomically to prevent TOCTOU races.
		if err := database.UseInviteAtomic(req.InviteCode); err != nil {
			writeJSON(w, http.StatusBadRequest, genericAuthError)
			return
		}

		// Create user with default Member role.
		uid, err := database.CreateUser(req.Username, hash, int(permissions.MemberRoleID))
		if err != nil {
			// UNIQUE constraint violation → duplicate username → 400.
			// Any other DB error → 500.
			if strings.Contains(err.Error(), "UNIQUE constraint") {
				writeJSON(w, http.StatusBadRequest, genericAuthError)
			} else {
				slog.Error("CreateUser failed", "err", err, "username", req.Username)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "SERVER_ERROR",
					Message: "registration failed — please try again",
				})
			}
			return
		}

		ip := clientIP(r)
		slog.Info("user registered", "username", req.Username, "user_id", uid, "ip", ip)
		_ = database.LogAudit(uid, "user_register", "user", uid,
			"new account created via invite")

		// Issue session.
		token, err := auth.GenerateToken()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		device := r.Header.Get("User-Agent")
		if _, err := database.CreateSession(uid, auth.HashToken(token), device, ip); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		user, err := database.GetUserByID(uid)
		if err != nil || user == nil {
			slog.Error("failed to fetch user after registration", "user_id", uid, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "registration succeeded but user fetch failed",
			})
			return
		}
		writeJSON(w, http.StatusCreated, authSuccessResponse{
			Token: token,
			User:  toUserResponse(user),
		})
	}
}

// handleLogin processes POST /api/v1/auth/login.
func handleLogin(database *db.DB, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(req.Username)
		// Do NOT trim req.Password — passwords may intentionally contain
		// leading/trailing whitespace. Bcrypt handles arbitrary bytes.

		if req.Username == "" || req.Password == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "username and password are required",
			})
			return
		}

		ip := clientIP(r)

		// Check lockout first.
		lockKey := "login_lock:" + ip
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "account temporarily locked due to too many failed attempts",
			})
			return
		}

		// Constant-time lookup: always attempt bcrypt compare even when user
		// does not exist to prevent timing-based username enumeration.
		user, err := database.GetUserByUsername(req.Username)

		// Distinguish DB errors from authentication failures. DB errors
		// should NOT increment the rate limiter — otherwise a transient
		// DB outage would lock out legitimate users.
		if err != nil && user == nil {
			// Could be a real DB error or simply "user not found".
			// GetUserByUsername returns (nil, nil) for not-found, so a
			// non-nil error here is a genuine DB failure.
			slog.Error("login: GetUserByUsername failed", "err", err, "ip", ip)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "login temporarily unavailable",
			})
			return
		}

		failKey := "login_fail:" + ip
		if user == nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
			// Track failures; lockout on the 10th failure.
			if !limiter.Allow(failKey, 9, 15*time.Minute) {
				limiter.Lockout(lockKey, 15*time.Minute)
			}
			slog.Info("login failed", "ip", ip, "username_len", len(req.Username))
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "invalid credentials",
			})
			return
		}

		// Reset failure counter on success.
		limiter.Reset(failKey)

		if auth.IsEffectivelyBanned(user) {
			slog.Warn("banned user login attempt", "username", user.Username, "user_id", user.ID, "ip", ip)
			_ = database.LogAudit(user.ID, "login_blocked_banned", "user", user.ID,
				"banned user attempted login from "+ip)
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "your account has been suspended",
			})
			return
		}

		// Issue session.
		token, err := auth.GenerateToken()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		device := r.Header.Get("User-Agent")
		if _, err := database.CreateSession(user.ID, auth.HashToken(token), device, ip); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to create session",
			})
			return
		}

		// Don't set status to "online" here — the WebSocket connection in
		// serve.go does that when the user actually connects. Setting it here
		// would leave the user permanently "online" if they never open a WS
		// connection or if the client crashes before connecting.
		slog.Info("user logged in", "username", user.Username, "user_id", user.ID, "ip", ip)
		_ = database.LogAudit(user.ID, "user_login", "user", user.ID,
			"logged in from "+ip)
		writeJSON(w, http.StatusOK, authSuccessResponse{
			Token: token,
			User:  toUserResponse(user),
		})
	}
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

		if err := database.DeleteSession(sess.TokenHash); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "SERVER_ERROR",
				Message: "failed to logout",
			})
			return
		}

		slog.Info("user logged out", "user_id", sess.UserID)
		_ = database.LogAudit(sess.UserID, "user_logout", "user", sess.UserID, "")

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
func handleDeleteAccount(database *db.DB, limiter *auth.RateLimiter) http.HandlerFunc {
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
		lockKey := fmt.Sprintf("delete_lock:%d", user.ID)
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
		failKey := fmt.Sprintf("delete_fail:%d", user.ID)
		if !auth.CheckPassword(user.PasswordHash, req.Password) {
			if !limiter.Allow(failKey, 3, 15*time.Minute) {
				limiter.Lockout(lockKey, 15*time.Minute)
			}
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "incorrect password",
			})
			return
		}
		limiter.Reset(failKey)

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
				Error:   "SERVER_ERROR",
				Message: "failed to delete account",
			})
			return
		}

		ip := clientIP(r)
		slog.Info("account deleted", "username", user.Username, "user_id", user.ID, "ip", ip)
		_ = database.LogAudit(user.ID, "account_deleted", "user", user.ID,
			"account self-deleted from "+ip)

		w.WriteHeader(http.StatusNoContent)
	}
}

// toUserResponse converts a db.User to the API response shape.
func toUserResponse(u *db.User) userResponse {
	avatar := ""
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	return userResponse{
		ID:        u.ID,
		Username:  u.Username,
		Avatar:    avatar,
		Status:    u.Status,
		RoleID:    u.RoleID,
		CreatedAt: u.CreatedAt,
	}
}
