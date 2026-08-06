package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
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

// sessionTouchInterval is the minimum time between last_used writes for the
// same session. last_used feeds the sessions list in account settings, where
// minute granularity is plenty — writing it on every request just serialized
// API traffic behind the single SQLite writer.
const sessionTouchInterval = 60 * time.Second

// touchThrottleMaxEntries bounds the throttle map before stale entries are
// pruned. Entries older than sessionTouchInterval are prunable — they no
// longer suppress anything.
const touchThrottleMaxEntries = 4096

// touchThrottle remembers when each session hash was last touched so
// TouchSession runs at most once per sessionTouchInterval per session.
type touchThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// shouldTouch reports whether the session's last_used write is due, and if so
// records now as the latest touch. Stale entries are pruned opportunistically
// once the map grows past touchThrottleMaxEntries.
func (t *touchThrottle) shouldTouch(hash string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if last, ok := t.seen[hash]; ok && now.Sub(last) < sessionTouchInterval {
		return false
	}
	if len(t.seen) >= touchThrottleMaxEntries {
		cutoff := now.Add(-sessionTouchInterval)
		for h, ts := range t.seen {
			if ts.Before(cutoff) {
				delete(t.seen, h)
			}
		}
	}
	t.seen[hash] = now
	return true
}

// AuthMiddleware reads the "Authorization: Bearer <token>" header, validates
// the session, and injects the user and session into the request context.
// Returns 401 if the token is missing, invalid, or the session is expired.
func AuthMiddleware(database *db.DB) func(http.Handler) http.Handler {
	touches := &touchThrottle{seen: make(map[string]time.Time)}
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
			// Resolve the bearer token to a principal. A login session is matched
			// first (existing behavior unchanged); an API token is the fallback.
			user, role, sess, err := auth.ResolveTokenHash(r.Context(), database, hash)
			switch {
			case errors.Is(err, auth.ErrTokenExpired):
				// Clean up the expired login session in the background. The request
				// ctx is cancelled once the 401 is written, so detach cancellation.
				cleanupCtx := context.WithoutCancel(r.Context())
				go func(h string) {
					if err := database.DeleteSession(cleanupCtx, h); err != nil {
						slog.WarnContext(cleanupCtx, "expired session cleanup failed", "error", err)
					}
				}(hash)
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "session has expired",
				})
				return
			case errors.Is(err, auth.ErrUserNotFound):
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "user not found",
				})
				return
			case errors.Is(err, auth.ErrRoleNotFound):
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "role not found",
				})
				return
			case err != nil:
				// ErrTokenNotFound or a wrapped DB error. A DB outage is not a bad
				// token — log it so it's distinguishable from ordinary 401s.
				if !errors.Is(err, auth.ErrTokenNotFound) {
					slog.ErrorContext(r.Context(), "auth: token resolution failed", "error", err)
				}
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "invalid or expired session",
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

			// Touch last-used — non-fatal. A login session is touched inline but
			// throttled to once per sessionTouchInterval per session, so hot API
			// traffic doesn't queue a write per request; an API-token principal
			// (sess == nil) is touched off the hot path so it never adds latency
			// to bot/CI traffic.
			if sess != nil {
				if touches.shouldTouch(hash, time.Now()) {
					if err := database.TouchSession(r.Context(), hash); err != nil {
						slog.Warn("failed to touch session", "error", err, "user_id", user.ID)
					}
				}
			} else {
				touchCtx := context.WithoutCancel(r.Context())
				go func(h string) {
					if err := database.TouchAPIToken(touchCtx, h); err != nil {
						slog.WarnContext(touchCtx, "failed to touch api token", "error", err)
					}
				}(hash)
			}

			ctx := context.WithValue(r.Context(), UserKey, user)
			ctx = context.WithValue(ctx, SessionKey, sess) // nil for API-token principals; consumers guard nil
			ctx = context.WithValue(ctx, RoleKey, role)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequirePermission returns middleware gating a route on SERVER-WIDE role
// permissions. Returns 403 if the user lacks them.
//
// Scope contract — this is the whole reason the middleware and the service
// layer look like two permission systems:
//   - It consults the role bitfield only. Channel overrides are NOT applied,
//     because a route reaching this middleware has no channel id to resolve
//     them against, and a per-channel allow must never open a server-wide gate.
//   - Anything channel-scoped belongs in the service layer behind
//     permissions.Checker (via svc.Permissions), which resolves overrides.
//   - ADMINISTRATOR bypasses; multi-bit masks require ALL bits.
//
// The rule itself lives in permissions.HasServerPerm so no call site can
// re-derive it.
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

			if !permissions.HasServerPerm(role.Permissions, perm) {
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
//
// prefix names the endpoint's bucket and must be non-empty in production
// mounts: the limiter records one timestamp per call regardless of the limit
// passed, so endpoints sharing a bare-IP key would cap each other at the
// MINIMUM limit of any of them (ordinary profile edits 429ing the password
// endpoint, NAT'd logins blocking register).
func RateLimitMiddleware(limiter *auth.RateLimiter, prefix string, limit int, window time.Duration, trustedProxies ...[]string) func(http.Handler) http.Handler {
	return rateLimitMiddlewareWithPrefix(limiter, prefix, limit, window, trustedProxies...)
}

func rateLimitMiddlewareWithPrefix(limiter *auth.RateLimiter, prefix string, limit int, window time.Duration, trustedProxies ...[]string) func(http.Handler) http.Handler {
	var proxies []string
	if len(trustedProxies) > 0 {
		proxies = trustedProxies[0]
	}
	proxyNets := parseCIDRList(proxies) // W3-3a: parse once at construction
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIPWithProxies(r, proxyNets)
			key := prefix + ip

			if !limiter.Allow(key, limit, window) {
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
//     one of the trustedNets. This prevents clients from forging their IP to
//     bypass rate limits.
//   - If trustedNets is empty (the default), RemoteAddr is always used.
//
// trustedNets is the pre-parsed trusted-proxy list — parse the configured CIDR
// strings ONCE at middleware/handler construction with parseCIDRList (W3-3a);
// never parse on the request path.
func clientIPWithProxies(r *http.Request, trustedNets []*net.IPNet) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		// RemoteAddr without port (e.g. Unix socket or test stub) — use as-is.
		remoteHost = r.RemoteAddr
	}

	if len(trustedNets) == 0 {
		return remoteHost
	}

	if !ipInNets(remoteHost, trustedNets) {
		return remoteHost
	}

	// Prefer X-Real-IP when coming from a trusted proxy.
	// BUG-112: Validate extracted IP to prevent spoofed rate-limit keys.
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if net.ParseIP(xri) != nil {
			return xri
		}
	}

	// Fall back to X-Forwarded-For, walking from the RIGHT and skipping entries
	// that are themselves trusted proxies. The first non-trusted, valid address
	// is the real client. Taking the leftmost entry (BUG-112) would trust a
	// client-supplied value: a client can prepend a spoofed IP
	// (`X-Forwarded-For: <spoofed>, <real>`) that the proxy then appends to,
	// letting it forge per-IP rate-limit and lockout keys.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		leftmostValid := ""
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := strings.TrimSpace(parts[i])
			if candidate == "" || net.ParseIP(candidate) == nil {
				continue
			}
			leftmostValid = candidate
			if ipInNets(candidate, trustedNets) {
				continue // our own proxy hop, keep walking left
			}
			return candidate
		}
		// Every entry fell inside trustedCIDRs — a config that covers client
		// networks too (e.g. trusted_proxies: 10.0.0.0/8 with LAN clients).
		// Falling back to RemoteAddr here would collapse ALL clients behind
		// the proxy into one rate-limit/lockout bucket, so one user's failed
		// logins would lock out everyone. The leftmost valid entry is the
		// furthest-upstream hop — the best distinct per-client key available
		// under such a config. trusted_proxies must list only proxy hops;
		// startup validation warns about entries that cannot be proxies.
		if leftmostValid != "" {
			return leftmostValid
		}
	}

	return remoteHost
}

// parseCIDRList parses CIDR strings into networks, skipping invalid entries
// with a warning — a misconfigured entry must not take the server down. It is
// called once per middleware/handler at construction (startup), never on the
// request path (W3-3a).
func parseCIDRList(cidrs []string) []*net.IPNet {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			slog.Warn("ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"cidr", c, "error", err)
			continue
		}
		nets = append(nets, n)
	}
	return nets
}

// ipInNets reports whether ipStr (a plain IP, no port) falls inside any of
// the parsed networks.
func ipInNets(ipStr string, nets []*net.IPNet) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// AdminIPRestrict returns middleware that blocks requests from IPs not in the
// allowed CIDR list. Returns 403 Forbidden for disallowed IPs. If the CIDR
// list is empty, all requests are allowed (no restriction).
//
// trustedProxyCIDRs specifies which connecting IPs are trusted reverse proxies.
// When the connecting IP matches a trusted proxy, the real client IP is read
// from X-Real-IP or X-Forwarded-For headers (BUG-116).
//
// Both lists are parsed once at construction (W3-3a); invalid entries are
// skipped with a warning. A non-empty allowedCIDRs list whose entries are all
// invalid yields zero networks — nothing matches, so access is denied (fail
// closed), same as before the hoist.
func AdminIPRestrict(allowedCIDRs, trustedProxyCIDRs []string) func(http.Handler) http.Handler {
	allowedNets := parseCIDRList(allowedCIDRs)
	proxyNets := parseCIDRList(trustedProxyCIDRs)
	restrict := len(allowedCIDRs) > 0
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !restrict {
				next.ServeHTTP(w, r)
				return
			}

			ip := clientIPWithProxies(r, proxyNets)
			if !ipInNets(ip, allowedNets) {
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
				h.Set("Strict-Transport-Security", fmt.Sprintf("max-age=%d; includeSubDomains", hstsMaxAgeSeconds))
			}
			next.ServeHTTP(w, r)
		})
	}
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

// MaxBodySizeUnless is like MaxBodySize but skips the limit for paths that
// match any of the given prefixes. Exempted paths apply their own limit via
// route-scoped middleware.
func MaxBodySizeUnless(maxBytes int64, exemptPrefixes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			exempt := false
			for _, prefix := range exemptPrefixes {
				if strings.HasPrefix(r.URL.Path, prefix) {
					exempt = true
					break
				}
			}
			if !exempt {
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
