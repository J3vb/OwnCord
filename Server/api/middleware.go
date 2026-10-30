package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

type contextKey int

const (
	// UserKey is the context key for the authenticated *db.User.
	UserKey contextKey = iota
	// SessionKey is the context key for the authenticated *db.Session.
	SessionKey
	// RoleKey is the context key for the *db.Role of the authenticated user.
	RoleKey
)

// sessionTouchInterval is the minimum time between last_used writes per session;
// minute granularity is plenty for the sessions list, and writing it on every
// request serialized API traffic behind the single SQLite writer.
const sessionTouchInterval = 60 * time.Second

const touchThrottleMaxEntries = 4096

var middlewareNow = time.Now

// touchThrottle remembers when each session hash was last touched so
// TouchSession runs at most once per sessionTouchInterval per session.
type touchThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

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

// principal returns the caller AuthMiddleware resolved for r as the shape
// the service layer takes. ok is false when the request carries no
// authenticated user; Session is nil for an API-token principal.
func principal(r *http.Request) (service.Principal, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		return service.Principal{}, false
	}
	sess, _ := r.Context().Value(SessionKey).(*db.Session)
	return service.Principal{User: user, Session: sess}, true
}

// requireUser resolves the authenticated user for a handler on a route mounted
// behind AuthMiddleware, refusing the request with the same 401
// writeNotAuthenticated sends when there is no usable one.
func requireUser(w http.ResponseWriter, r *http.Request) (*db.User, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		writeNotAuthenticated(w)
		return nil, false
	}
	return user, true
}

// backgroundWriteTimeout bounds AuthMiddleware's session writes that run when
// no connection-writes batch is installed (the expired-session delete and the
// API-token touch), so a wedged DB cannot hold a request forever. A var so tests can shorten it.
var backgroundWriteTimeout = 5 * time.Second

// authFailure is why a credential hash did not resolve to a usable principal,
// in the form both perimeters answer with.
type authFailure struct {
	status  int
	code    httperr.Code
	message string
	// after, when set, is work the caller runs once the response is written
	// (the expired-session cleanup).
	after func()
}

// resolvePrincipal resolves a bearer credential hash to the request context
// AuthMiddleware hands its handler (UserKey, SessionKey, RoleKey), applying
// expired-session cleanup, the ban check and the last-used touch. A non-nil
// failure carries the bearer perimeter's status; the file-link perimeter
// (file_link.go) maps it to its own refusal, so a link never outlives what a
// bearer request would be refused for.
func resolvePrincipal(ctx context.Context, sessions *service.SessionService, touches *touchThrottle, hash string) (context.Context, *authFailure) {
	// A login session is matched first; an API token is the fallback.
	user, role, sess, err := sessions.ResolveBearer(ctx, hash)
	switch {
	case errors.Is(err, auth.ErrTokenExpired):
		// Clean up the expired login session once the response is written. With
		// the server's batch installed this only queues the delete for the
		// connection-writes flush (no goroutine); without one (tests, the token
		// CLI) it deletes inline, bounded. The ctx is detached: the delete must
		// not die with the finished request.
		cleanup := func() {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), backgroundWriteTimeout)
			defer cancel()
			if err := sessions.DiscardSession(cleanupCtx, hash); err != nil {
				slog.WarnContext(cleanupCtx, "expired session cleanup failed", "error", err)
			}
		}
		return nil, &authFailure{http.StatusUnauthorized, httperr.CodeUnauthorized, "session has expired", cleanup}
	case errors.Is(err, auth.ErrUserNotFound):
		return nil, &authFailure{http.StatusUnauthorized, httperr.CodeUnauthorized, "user not found", nil}
	case errors.Is(err, auth.ErrRoleNotFound):
		return nil, &authFailure{http.StatusUnauthorized, httperr.CodeUnauthorized, "role not found", nil}
	case errors.Is(err, auth.ErrTokenNotFound):
		return nil, &authFailure{http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired session", nil}
	case err != nil:
		// A wrapped DB error, not a sentinel. A DB outage is not a bad token: a
		// 401 would make the client clear auth, disconnect the WS and delete the
		// stored credential. Log it and report a server-side fault.
		slog.ErrorContext(ctx, "auth: token resolution failed", "error", err)
		return nil, &authFailure{http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "authentication service temporarily unavailable", nil}
	}

	if auth.IsEffectivelyBanned(user) {
		return nil, &authFailure{http.StatusForbidden, httperr.CodeForbidden, "your account has been suspended", nil}
	}

	// Touch last-used, non-fatal. A login session is touched inline, throttled
	// to once per sessionTouchInterval. An API-token principal (sess == nil) is
	// touched off the hot path so bot/CI traffic gains no latency: with the
	// server's batch installed it is only queued (one write per token per
	// minute), otherwise written inline under backgroundWriteTimeout.
	if sess != nil {
		if touches.shouldTouch(hash, middlewareNow()) {
			if err := sessions.TouchSession(ctx, hash); err != nil {
				slog.Warn("failed to touch session", "error", err, "user_id", user.ID)
			}
		}
	} else {
		touchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), backgroundWriteTimeout)
		if err := sessions.TouchAPIToken(touchCtx, hash); err != nil {
			slog.WarnContext(touchCtx, "failed to touch api token", "error", err)
		}
		cancel()
	}

	ctx = context.WithValue(ctx, UserKey, user)
	ctx = context.WithValue(ctx, SessionKey, sess) // nil for API-token principals; consumers guard nil
	ctx = context.WithValue(ctx, RoleKey, role)
	return ctx, nil
}

// AuthMiddleware validates the "Authorization: Bearer <token>" session and
// injects user and session into the request context. 401 if the token is
// missing, invalid or expired.
func AuthMiddleware(sessions *service.SessionService) func(http.Handler) http.Handler {
	touches := &touchThrottle{seen: make(map[string]time.Time)}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := auth.ExtractBearerToken(r)
			if !ok {
				writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "missing or invalid authorization header")
				return
			}
			ctx, fail := resolvePrincipal(r.Context(), sessions, touches, auth.HashToken(token))
			if fail != nil {
				writeErr(w, fail.status, fail.code, fail.message)
				if fail.after != nil {
					fail.after()
				}
				return
			}
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
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "insufficient permissions")
				return
			}

			if !permissions.HasServerPerm(role.Permissions, perm) {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "insufficient permissions")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitMiddleware limits requests per IP with the RateLimiter, resolving the
// client IP through trustedProxies (nil = RemoteAddr). 429 with Retry-After when
// exceeded.
// prefix names the endpoint's bucket and must be non-empty in production: the
// limiter records one timestamp per call regardless of the limit, so endpoints
// sharing a bare-IP key would cap each other at the lowest limit (profile edits
// 429ing the password endpoint, NAT'd logins blocking register).
func RateLimitMiddleware(limiter *auth.RateLimiter, prefix string, limit int, window time.Duration, trustedProxies ...[]string) func(http.Handler) http.Handler {
	var proxies []string
	if len(trustedProxies) > 0 {
		proxies = trustedProxies[0]
	}
	proxyNets := parseCIDRList(proxies) // parse once at construction
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIPWithProxies(r, proxyNets)
			key := prefix + clientip.RateKey(ip)

			if !limiter.Allow(key, limit, window) {
				// The true remainder, not the full window: a client told to wait
				// the whole window retries too late.
				retry := limiter.RetryAfter(key, limit, window)
				// Round up so a 59.4s remainder does not report 59.
				secs := max(int(math.Ceil(retry.Seconds())), 1)
				w.Header().Set("Retry-After", fmt.Sprintf("%d", secs))
				writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many requests, please slow down")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// clientIP returns the connecting IP from RemoteAddr, ignoring proxy headers;
// use it for audit and lockout keys where proxy trust is not established, and
// clientIPWithProxies for rate limiting.
func clientIP(r *http.Request) string {
	return clientIPWithProxies(r, nil)
}

// clientIPWithProxies returns the real client IP for rate limiting. The
// algorithm lives in the clientip package because the WebSocket handshake needs
// the identical resolution and ws cannot import api.
func clientIPWithProxies(r *http.Request, trustedNets []*net.IPNet) string {
	return clientip.Resolve(r, trustedNets)
}

// parseCIDRList parses CIDR strings, skipping invalid entries with a warning so
// a misconfigured entry cannot take the server down. Call it at construction,
// never per request.
func parseCIDRList(cidrs []string) []*net.IPNet {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"cidr", c, "error", err)
		}
	}
	return clientip.ParseCIDRList(cidrs)
}

func ipInNets(ipStr string, nets []*net.IPNet) bool {
	return clientip.InNets(ipStr, nets)
}

// AdminIPRestrict blocks requests from IPs outside the allowed CIDR list with
// 403, naming settingName (the config key). An empty list allows all.
// trustedProxyCIDRs lists the connecting IPs trusted to forward the real client
// IP via X-Real-IP or X-Forwarded-For. Both lists are parsed once at
// construction; a non-empty allowedCIDRs whose entries are all invalid yields
// zero networks, so nothing matches and access is denied (fail closed).
func AdminIPRestrict(settingName string, allowedCIDRs, trustedProxyCIDRs []string) func(http.Handler) http.Handler {
	allowedNets := parseCIDRList(allowedCIDRs)
	proxyNets := parseCIDRList(trustedProxyCIDRs)
	restrict := len(allowedCIDRs) > 0
	var warnUndeclaredProxy sync.Once
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !restrict {
				next.ServeHTTP(w, r)
				return
			}

			ip := clientIPWithProxies(r, proxyNets)
			if !ipInNets(ip, allowedNets) {
				// Name the setting so a self-hoster can fix it without reading
				// the source: the default allowlist is private networks only, so
				// a remote operator is refused until they add their address or
				// use an SSH tunnel. The reply says nothing about which IP was
				// seen or which CIDRs are configured (no topology disclosure).
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden,
					"access denied by "+settingName+" — this address is not in its allowlist")
				return
			}
			// A local peer forwarding for someone else while no proxy is
			// trusted means the allowlist is judging the proxy, not the
			// client: every client inherits the proxy's private address.
			// Either header clientIPWithProxies reads marks a proxy.
			forwarded := r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Real-IP") != ""
			if len(proxyNets) == 0 && forwarded {
				if peer := net.ParseIP(ip); peer != nil && (peer.IsLoopback() || peer.IsPrivate()) {
					warnUndeclaredProxy.Do(func() {
						slog.Warn("admin_allowed_cidrs is checked against the connecting address and trusted_proxies is empty — "+
							"behind a reverse proxy or a container port relay that address is the relay's (loopback or bridge), "+
							"which the allowlist admits",
							"setting", settingName, "peer", ip, "fix", "set server.trusted_proxies to the proxy hop(s)")
					})
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeadersWithTLS sets the standard defensive response headers (nosniff,
// frame DENY, XSS filter off to rely on CSP, strict Referrer-Policy, CSP
// default-src self, Permissions-Policy, no-store); a non-empty tlsMode also sets
// Strict-Transport-Security.
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

// MaxBodySize wraps r.Body with http.MaxBytesReader so oversized bodies error
// rather than exhaust memory. Upload routes needing more apply their own limit.
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// MaxBodySizeUnless is like MaxBodySize but skips the limit for paths that
// match any of the given prefixes, or a POST whose escaped path matches
// exemptPOST (nil for none). Exempted paths apply their own limit via
// route-scoped middleware.
func MaxBodySizeUnless(maxBytes int64, exemptPOST *regexp.Regexp, exemptPrefixes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			exempt := exemptPOST != nil && r.Method == http.MethodPost && exemptPOST.MatchString(r.URL.EscapedPath())
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

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeErr(w http.ResponseWriter, status int, code httperr.Code, msg string) {
	writeJSON(w, status, errorResponse{Error: string(code), Message: msg})
}
