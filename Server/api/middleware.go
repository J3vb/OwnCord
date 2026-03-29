package api

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
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
			token, ok := auth.ExtractBearerToken(r)
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
			if auth.IsSessionExpired(sess.ExpiresAt) {
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

			// Reject effectively-banned users before any further processing.
			if auth.IsEffectivelyBanned(user) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "your account has been suspended",
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
			if err := database.TouchSession(hash); err != nil {
				slog.Warn("failed to touch session", "error", err, "user_id", user.ID)
			}

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
			if permissions.HasAdmin(role.Permissions) {
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
// provided RateLimiter. The client IP is resolved via clientIPWithProxies using
// the supplied trustedProxies CIDRs — pass nil to always use RemoteAddr.
// Returns 429 with Retry-After when the limit is exceeded.
func RateLimitMiddleware(limiter *auth.RateLimiter, limit int, window time.Duration, trustedProxies ...[]string) func(http.Handler) http.Handler {
	var proxies []string
	if len(trustedProxies) > 0 {
		proxies = trustedProxies[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIPWithProxies(r, proxies)

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

// clientIP returns the connecting IP from RemoteAddr, ignoring any proxy
// headers. It is safe to use for audit logging and lockout keys where proxy
// header trust has not been established. For rate-limiting with proxy support
// use clientIPWithProxies.
func clientIP(r *http.Request) string {
	return clientIPWithProxies(r, nil)
}

// clientIPWithProxies returns the real client IP for rate-limiting purposes.
//
// Security model:
//   - Always parse the actual connecting address from r.RemoteAddr.
//   - Only honour X-Real-IP or X-Forwarded-For if the connecting address matches
//     one of the trustedCIDRs. This prevents clients from forging their IP to
//     bypass rate limits.
//   - If trustedCIDRs is empty (the default), RemoteAddr is always used.
//
// Invalid CIDR entries in trustedCIDRs are silently skipped so that a
// misconfigured entry cannot crash the server; the connecting IP is used as the
// fallback.
func clientIPWithProxies(r *http.Request, trustedCIDRs []string) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// RemoteAddr without port (e.g. Unix socket or test stub) — use as-is.
		remoteHost = r.RemoteAddr
	}

	if len(trustedCIDRs) == 0 {
		return remoteHost
	}

	trusted, _ := isTrustedProxy(remoteHost, trustedCIDRs)
	if !trusted {
		return remoteHost
	}

	// Prefer X-Real-IP when coming from a trusted proxy.
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}

	// Fall back to the leftmost (client) entry in X-Forwarded-For.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		if client := strings.TrimSpace(parts[0]); client != "" {
			return client
		}
	}

	return remoteHost
}

// isTrustedProxy reports whether remoteIP (a plain IP string, no port) falls
// within any of the provided CIDR ranges. It returns an error if any CIDR is
// malformed.
func isTrustedProxy(remoteIP string, cidrList []string) (bool, error) {
	ip := net.ParseIP(remoteIP)
	if ip == nil {
		return false, nil
	}
	for _, cidr := range cidrList {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			return false, fmt.Errorf("isTrustedProxy: invalid CIDR %q: %w", cidr, err)
		}
		if network.Contains(ip) {
			return true, nil
		}
	}
	return false, nil
}

// AdminIPRestrict returns middleware that blocks requests from IPs not in the
// allowed CIDR list. Returns 403 Forbidden for disallowed IPs. If the CIDR
// list is empty, all requests are allowed (no restriction).
func AdminIPRestrict(allowedCIDRs []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(allowedCIDRs) == 0 {
				next.ServeHTTP(w, r)
				return
			}

			ip := clientIP(r)
			allowed, _ := isTrustedProxy(ip, allowedCIDRs)
			if !allowed {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "access denied",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeadersWithTLS returns middleware that sets a standard suite of
// defensive HTTP response headers. When tlsMode is non-empty (TLS is enabled),
// the Strict-Transport-Security header is also set.
//
// Header choices:
//   - X-Content-Type-Options: nosniff          — prevent MIME-type sniffing
//   - X-Frame-Options: DENY                    — block clickjacking via iframes
//   - X-XSS-Protection: 0                      — disable legacy XSS filter; rely on CSP
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Content-Security-Policy: default-src 'self'
//   - Permissions-Policy: camera=(), microphone=(), geolocation=()
//   - Cache-Control: no-store                  — prevent sensitive data caching
//   - Strict-Transport-Security (when TLS enabled)
func SecurityHeadersWithTLS(tlsMode string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("X-XSS-Protection", "0")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Content-Security-Policy", "default-src 'self'")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			h.Set("Cache-Control", "no-store")
			if tlsMode != "" {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders is a convenience wrapper for SecurityHeadersWithTLS with TLS
// disabled (no HSTS header). Kept for backwards compatibility with tests.
func SecurityHeaders(next http.Handler) http.Handler {
	return SecurityHeadersWithTLS("")(next)
}

// MaxBodySize wraps r.Body with http.MaxBytesReader so that reads beyond
// maxBytes return an error. This prevents clients from exhausting server memory
// by sending arbitrarily large request bodies.
//
// Usage in the router:
//
//	r.Use(MaxBodySize(1 << 20)) // 1 MiB default for API endpoints
//
// Upload endpoints that need a higher limit should apply their own
// http.MaxBytesReader or a route-scoped middleware with a larger value.
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// MaxBodySizeUnless is like MaxBodySize but skips the limit for specific paths.
// Exempted paths apply their own limit via route-scoped middleware.
func MaxBodySizeUnless(maxBytes int64, exemptPaths ...string) func(http.Handler) http.Handler {
	exempt := make(map[string]bool, len(exemptPaths))
	for _, p := range exemptPaths {
		exempt[p] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !exempt[r.URL.Path] {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// errorResponse is the standard error JSON shape.
type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}
