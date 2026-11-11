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
	UserKey contextKey = iota
	SessionKey
	RoleKey
)

// Minimum time between last_used writes per session; writing on every request serialized API traffic behind
// the single SQLite writer.
const sessionTouchInterval = 60 * time.Second

var middlewareNow = time.Now

// Remembers when each session hash was last touched so TouchSession runs at most once per interval; one
// scan per interval drops stale entries, so the map stays small.
type touchThrottle struct {
	mu        sync.Mutex
	seen      map[string]time.Time
	lastSweep time.Time
}

func (t *touchThrottle) shouldTouch(hash string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.Sub(t.lastSweep) >= sessionTouchInterval {
		t.lastSweep = now
		cutoff := now.Add(-sessionTouchInterval)
		for h, ts := range t.seen {
			if ts.Before(cutoff) {
				delete(t.seen, h)
			}
		}
	}
	if last, ok := t.seen[hash]; ok && now.Sub(last) < sessionTouchInterval {
		return false
	}
	t.seen[hash] = now
	return true
}

// principal returns the caller AuthMiddleware resolved for r; Session is nil for an API-token principal.
func principal(r *http.Request) (service.Principal, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		return service.Principal{}, false
	}
	sess, _ := r.Context().Value(SessionKey).(*db.Session)
	return service.Principal{User: user, Session: sess}, true
}

// requireUser returns the authenticated user, refusing with the writeNotAuthenticated 401 when there is
// none.
func requireUser(w http.ResponseWriter, r *http.Request) (*db.User, bool) {
	user, ok := r.Context().Value(UserKey).(*db.User)
	if !ok || user == nil {
		writeNotAuthenticated(w)
		return nil, false
	}
	return user, true
}

// requireLoginSession admits only a login-session principal; an API-token principal gets 403
// LOGIN_SESSION_REQUIRED. It guards account-security routes and mounts after AuthMiddleware.
func requireLoginSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := principal(r)
		if !ok {
			writeNotAuthenticated(w)
			return
		}
		if p.Session == nil {
			writeLoginSessionRequired(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeLoginSessionRequired(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, httperr.CodeLoginSessionRequired, service.ErrLoginSessionRequired.Error())
}

// Bounds AuthMiddleware's session writes when no connection-writes batch is installed, so a wedged DB
// cannot hold a request forever. A var so tests can shorten it.
var backgroundWriteTimeout = 5 * time.Second

type authFailure struct {
	status  int
	code    httperr.Code
	message string
	// Work run once the response is written (expired-session cleanup).
	after func()
}

// resolvePrincipal resolves a bearer credential hash to the context AuthMiddleware hands its handler.
// A non-nil failure carries the bearer perimeter's status; file_link.go maps it to its own refusal so a
// link never outlives what a bearer request would be refused for.
func resolvePrincipal(ctx context.Context, sessions *service.SessionService, touches *touchThrottle, hash string) (context.Context, *authFailure) {
	user, role, sess, err := sessions.ResolveBearer(ctx, hash)
	switch {
	case errors.Is(err, auth.ErrTokenExpired):
		// With the server's batch installed this only queues the delete; without one (tests, token CLI) it
		// deletes inline, bounded. The ctx is detached so the delete does not die with the finished request.
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
		// A DB outage is not a bad token: a 401 would make the client clear auth, disconnect the WS and
		// delete the stored credential.
		slog.ErrorContext(ctx, "auth: token resolution failed", "error", err)
		return nil, &authFailure{http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "authentication service temporarily unavailable", nil}
	}

	if auth.IsEffectivelyBanned(user) {
		return nil, &authFailure{http.StatusForbidden, httperr.CodeForbidden, "your account has been suspended", nil}
	}

	// Non-fatal. An API-token principal is touched off the hot path so bot/CI traffic gains no latency:
	// queued with the batch installed, otherwise written inline under backgroundWriteTimeout.
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

// AuthMiddleware validates the "Authorization: Bearer <token>" session and injects user and session
// into the request context.
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

// RequirePermission gates a route on SERVER-WIDE role permissions; 403 if the user lacks them. It
// consults the role bitfield only: channel overrides are NOT applied, since a per-channel allow must never
// open a server-wide gate. Channel-scoped checks belong in the service layer behind permissions.Checker.
// ADMINISTRATOR bypasses; multi-bit masks require ALL bits. The rule lives in permissions.HasServerPerm.
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

// RateLimitMiddleware limits requests per IP, resolving the client IP through trustedProxies (nil =
// RemoteAddr); 429 with Retry-After when exceeded. prefix must be non-empty in production: the limiter
// records one timestamp per call, so endpoints sharing a bare-IP key would cap each other at the lowest
// limit.
func RateLimitMiddleware(limiter *auth.RateLimiter, prefix string, limit int, window time.Duration, trustedProxies ...[]string) func(http.Handler) http.Handler {
	var proxies []string
	if len(trustedProxies) > 0 {
		proxies = trustedProxies[0]
	}
	proxyNets := parseCIDRList(proxies) // parse once at construction
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientip.Resolve(r, proxyNets)
			key := prefix + clientip.RateKey(ip)

			if !limiter.Allow(key, limit, window) {
				// The true remainder, not the full window, which would make the client retry too late.
				retry := limiter.RetryAfter(key, limit, window)
				secs := max(int(math.Ceil(retry.Seconds())), 1)
				w.Header().Set("Retry-After", fmt.Sprintf("%d", secs))
				writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many requests, please slow down")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// parseCIDRList skips invalid entries with a warning. Call it at construction, never per request.
func parseCIDRList(cidrs []string) []*net.IPNet {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"cidr", c, "error", err)
		}
	}
	return clientip.ParseCIDRList(cidrs)
}

// AdminIPRestrict blocks requests from IPs outside the allowed CIDR list with 403, naming settingName.
// An empty list allows all; a non-empty list whose entries are all invalid denies everything (fail closed).
// trustedProxyCIDRs lists the peers trusted to forward the client IP via X-Real-IP or X-Forwarded-For.
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

			ip := clientip.Resolve(r, proxyNets)
			if !clientip.InNets(ip, allowedNets) {
				// Name the setting so a self-hoster can fix it; the reply discloses no topology (no IP seen,
				// no CIDRs).
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden,
					"access denied by "+settingName+" — this address is not in its allowlist")
				return
			}
			// A local peer forwarding for someone else while no proxy is trusted means the allowlist is
			// judging the proxy, not the client.
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

// SecurityHeadersWithTLS sets the defensive response headers; a non-empty tlsMode also sets
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

// MaxBodySize wraps r.Body with http.MaxBytesReader; upload routes needing more apply their own limit.
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// MaxBodySizeUnless is MaxBodySize skipping prefix matches, or a POST whose escaped path matches exemptPOST
// (nil for none).
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
