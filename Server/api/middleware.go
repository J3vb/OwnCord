package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// contextKey is an unexported type for context keys in this package.
type contextKey int

const (
	// UserKey is the context key for the authenticated *db.User.
	UserKey contextKey = iota
	// SessionKey is the context key for the authenticated *db.Session.
	SessionKey
	// RoleKey is the context key for the *db.Role of the authenticated user.
	RoleKey
)

// AuthMiddleware reads the "Authorization: Bearer <token>" header, validates
// the session, and injects the user and session into the request context.
// Returns 401 if the token is missing, invalid, or the session is expired.
func AuthMiddleware(database *db.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractBearerToken(r)
			if !ok {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "missing or invalid authorization header",
				})
				return
			}

			hash := auth.HashToken(token)
			sess, err := database.GetSessionByTokenHash(hash)
			if err != nil || sess == nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "invalid or expired session",
				})
				return
			}

			// Check expiry.
			if isSessionExpired(sess.ExpiresAt) {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "session has expired",
				})
				return
			}

			// Load user.
			user, err := database.GetUserByID(sess.UserID)
			if err != nil || user == nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "user not found",
				})
				return
			}

			// Load role for permission checks.
			role, err := database.GetRoleByID(user.RoleID)
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "role not found",
				})
				return
			}

			// Touch session in background — non-fatal if it fails.
			_ = database.TouchSession(hash)

			ctx := context.WithValue(r.Context(), UserKey, user)
			ctx = context.WithValue(ctx, SessionKey, sess)
			ctx = context.WithValue(ctx, RoleKey, role)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequirePermission returns middleware that checks the authenticated user's
// role permissions. Returns 403 if the user lacks the required permission.
// The ADMINISTRATOR bit (0x40000000) bypasses all checks.
func RequirePermission(perm int64) func(http.Handler) http.Handler {
	const administrator = int64(0x40000000)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, ok := r.Context().Value(RoleKey).(*db.Role)
			if !ok || role == nil {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "insufficient permissions",
				})
				return
			}

			// ADMINISTRATOR bypasses all permission checks.
			if role.Permissions&administrator != 0 {
				next.ServeHTTP(w, r)
				return
			}

			if role.Permissions&perm == 0 {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "insufficient permissions",
				})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitMiddleware returns middleware that limits requests per IP using the
// provided RateLimiter. The IP is taken from X-Real-IP header when present,
// falling back to RemoteAddr. Returns 429 with Retry-After when exceeded.
func RateLimitMiddleware(limiter *auth.RateLimiter, limit int, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)

			if !limiter.Allow(ip, limit, window) {
				w.Header().Set("Retry-After", fmt.Sprintf("%d", int(window.Seconds())))
				writeJSON(w, http.StatusTooManyRequests, errorResponse{
					Error:   "RATE_LIMITED",
					Message: "too many requests, please slow down",
				})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// extractBearerToken parses "Authorization: Bearer <token>" and returns the
// token and true, or "", false if the header is missing or malformed.
func extractBearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// clientIP returns the client IP from X-Real-IP or RemoteAddr (without port).
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	// RemoteAddr is "host:port"; strip the port.
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		return addr[:idx]
	}
	return addr
}

// isSessionExpired returns true when expiresAt string represents a past time.
// Handles both "2006-01-02 15:04:05" (SQLite) and "2006-01-02T15:04:05Z" formats.
func isSessionExpired(expiresAt string) bool {
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05Z"} {
		t, err := time.Parse(layout, expiresAt)
		if err == nil {
			return time.Now().UTC().After(t.UTC())
		}
	}
	// Unparseable expiry — treat as expired for safety.
	return true
}

// errorResponse is the standard error JSON shape.
type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}
