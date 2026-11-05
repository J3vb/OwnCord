package api_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"go.uber.org/goleak"
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

func newAPITestDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, apiTestSchema)
}

// ok is a trivial handler that responds 200 OK to confirm the middleware
// passed the request through.
func ok(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// bearerToken wraps an HTTP handler with an Authorization header bearing token.
func withBearer(req *http.Request, token string) *http.Request {
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

// ─── AuthMiddleware tests ─────────────────────────────────────────────────────

func TestAuthMiddleware_ValidToken(t *testing.T) {
	database := newAPITestDB(t)
	_, token, _ := seedLoginSession(t, database, "alice", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	if rr.Code != http.StatusOK {
		t.Errorf("AuthMiddleware valid token status = %d, want %d", rr.Code, http.StatusOK)
	}
}

// TestAuthMiddleware_TouchSessionThrottled verifies the last_used write is
// throttled per session: the first authenticated request touches the row, and
// an immediate second request through the same middleware instance does not —
// a hot session costs at most one write per interval instead of one per
// request.
func TestAuthMiddleware_TouchSessionThrottled(t *testing.T) {
	database := newAPITestDB(t)
	_, token, hash := seedLoginSession(t, database, "touchy", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))

	const sentinel = "2000-01-01 00:00:00"
	backdate := func() {
		t.Helper()
		if _, err := database.ExecContext(context.Background(),
			`UPDATE sessions SET last_used = ? WHERE token = ?`, sentinel, hash); err != nil {
			t.Fatalf("backdating last_used: %v", err)
		}
	}
	lastUsed := func() string {
		t.Helper()
		sess, err := database.GetSessionByTokenHash(context.Background(), hash)
		if err != nil || sess == nil {
			t.Fatalf("GetSessionByTokenHash: %v (sess=%v)", err, sess)
		}
		return sess.LastUsed
	}
	do := func() {
		t.Helper()
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token))
		requireStatus(t, rr, http.StatusOK)
	}

	// First request: the session has never been touched by this middleware
	// instance, so last_used must be written.
	backdate()
	do()
	if lastUsed() == sentinel {
		t.Fatal("first request did not touch last_used")
	}

	// Second request inside the throttle interval: no write.
	backdate()
	do()
	if lastUsed() != sentinel {
		t.Error("second request within the throttle interval touched last_used; want it skipped")
	}
}

// TestAuthMiddleware_TouchSlidesExpiry pins DP-05 through the REST path: a
// request after the throttle interval slides expires_at, and a second request
// inside the interval writes nothing.
func TestAuthMiddleware_TouchSlidesExpiry(t *testing.T) {
	database := newAPITestDB(t)
	_, token, hash := seedLoginSession(t, database, "slider", 4)

	t0 := time.Now()
	clock := t0
	api.SetMiddlewareClockForTest(t, func() time.Time { return clock })
	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))

	// A near-expiry sentinel: still valid, but well short of a fresh window.
	sentinel := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05Z")
	backdate := func() {
		t.Helper()
		if _, err := database.ExecContext(context.Background(),
			`UPDATE sessions SET expires_at = ? WHERE token = ?`, sentinel, hash); err != nil {
			t.Fatalf("backdating expires_at: %v", err)
		}
	}
	expiresAt := func() string {
		t.Helper()
		sess, err := database.GetSessionByTokenHash(context.Background(), hash)
		if err != nil || sess == nil {
			t.Fatalf("GetSessionByTokenHash: %v (sess=%v)", err, sess)
		}
		return sess.ExpiresAt
	}
	do := func() {
		t.Helper()
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token))
		requireStatus(t, rr, http.StatusOK)
	}

	backdate()
	do()
	if expiresAt() <= sentinel {
		t.Fatal("first request did not slide expires_at")
	}

	backdate()
	clock = t0.Add(30 * time.Second)
	do()
	if expiresAt() != sentinel {
		t.Error("request within the throttle interval wrote expires_at; want it skipped")
	}

	clock = t0.Add(61 * time.Second)
	do()
	if expiresAt() <= sentinel {
		t.Error("request 61s after the last touch did not slide expires_at")
	}
}

func TestAuthMiddleware_MissingToken(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestAuthMiddleware_ValidAPIToken(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "botuser", "hash", 4)
	token, _ := auth.GenerateToken()
	if _, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(token), "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	var gotUserID int64
	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, ok := r.Context().Value(api.UserKey).(*db.User); ok && u != nil {
			gotUserID = u.ID
		}
		// An API-token principal has no login session: SessionKey must be nil.
		if s, ok := r.Context().Value(api.SessionKey).(*db.Session); ok && s != nil {
			t.Errorf("expected nil session for API-token principal, got %+v", s)
		}
		w.WriteHeader(http.StatusOK)
	}))
	req := withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token)
	rr := serveRequest(h, req)

	requireStatus(t, rr, http.StatusOK)
	if gotUserID != uid {
		t.Errorf("API token authenticated as user %d, want %d", gotUserID, uid)
	}
}

func TestAuthMiddleware_RevokedAPIToken(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "botuser2", "hash", 4)
	token, _ := auth.GenerateToken()
	id, _ := database.CreateAPIToken(context.Background(), uid, auth.HashToken(token), "ci", nil)
	if _, err := database.RevokeAPIToken(context.Background(), id); err != nil {
		t.Fatalf("RevokeAPIToken: %v", err)
	}

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	req := withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token)
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestAuthMiddleware_InvalidToken(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, "notarealtoken")
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestAuthMiddleware_ExpiredSession(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "bob", "hash", 4)
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)

	// Insert an already-expired session.
	pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, hash, "test", "127.0.0.1", pastTime,
	)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestAuthMiddleware_MalformedAuthHeader(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))

	cases := []string{
		"Token abc", // wrong scheme
		"Bearer",    // missing token after Bearer
		"abc",       // no space
	}
	for _, header := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", header)
		rr := serveRequest(h, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("AuthMiddleware header=%q status = %d, want 401", header, rr.Code)
		}
	}
}

// TestAuthMiddleware_DanglingRoleUnauthorized pins the `role == nil` guard:
// GetRoleByID returns (nil, nil) for a role_id with no roles row, so without
// the guard a nil role reached the request context and the request only died
// later, at RequirePermission's own nil check (403) — or not at all on routes
// that have no RequirePermission.
func TestAuthMiddleware_DanglingRoleUnauthorized(t *testing.T) {
	database := newAPITestDB(t)

	// users.role_id has a FK to roles(id), so the dangling row can only be
	// created with FK enforcement momentarily off (db.Open pins the pool to a
	// single connection, so the pragma applies to the inserts that follow).
	if _, err := database.ExecContext(context.Background(), `PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO users (username, password, role_id) VALUES ('dangling', '$2a$12$fake', 999)`)
	if err != nil {
		t.Fatalf("insert dangling user: %v", err)
	}
	uid, _ := res.LastInsertId()
	if _, err := database.ExecContext(context.Background(), `PRAGMA foreign_keys=ON`); err != nil {
		t.Fatalf("re-enable foreign keys: %v", err)
	}

	token, _ := auth.GenerateToken()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, auth.HashToken(token),
	); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// TestAuthMiddleware_DBErrorIsNotUnauthorized pins OC-0202: a transient DB
// read error while resolving the bearer token (auth.ResolveTokenHash returns
// it WRAPPED, never as a sentinel) must not be reported as 401 UNAUTHORIZED.
// The desktop client treats every 401 as "session expired": it clears auth,
// disconnects the WS, and deletes the stored OS-keyring credential. A DB
// outage is not a bad token, so it must surface as a server-side failure
// (503) instead of tearing down a perfectly valid session.
func TestAuthMiddleware_DBErrorIsNotUnauthorized(t *testing.T) {
	database := newAPITestDB(t)
	_, token, _ := seedLoginSession(t, database, "erin", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))

	// Close the underlying DB so the next GetSessionByTokenHash call fails
	// with a wrapped "database is closed" error rather than sql.ErrNoRows —
	// standing in for a transient outage (locked DB, disk I/O error, a
	// restore swapping the file underneath the running server).
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	req := withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token)
	rr := serveRequest(h, req)

	if rr.Code == http.StatusUnauthorized {
		t.Errorf("AuthMiddleware DB error status = %d, want non-401 (503)", rr.Code)
	}
	expectStatus(t, rr, http.StatusServiceUnavailable)
}

// blockingSessionStore is the real DB with AuthMiddleware's two background
// writes held until their ctx ends, reporting how each one ended — a wedged
// DB, as far as those goroutines can tell.
type blockingSessionStore struct {
	*db.DB
	ended chan error
}

func (s *blockingSessionStore) DeleteSession(ctx context.Context, _ string) error {
	<-ctx.Done()
	s.ended <- ctx.Err()
	return ctx.Err()
}

func (s *blockingSessionStore) TouchAPIToken(ctx context.Context, _ string) error {
	<-ctx.Done()
	s.ended <- ctx.Err()
	return ctx.Err()
}

// The expired-session delete and the API-token touch run after the response
// on a goroutine detached from the request. Against a wedged DB each must give
// up at its deadline instead of parking a goroutine per request forever.
func TestAuthMiddleware_BackgroundWritesAreBounded(t *testing.T) {
	api.SetBackgroundWriteTimeoutForTest(t, 20*time.Millisecond)

	tests := []struct {
		name string
		seed func(t *testing.T, database *db.DB) string
	}{
		{"expired session delete", func(t *testing.T, database *db.DB) string {
			uid := mustCreateUser(t, database, "wedge-expired", "hash", 4)
			token, _ := auth.GenerateToken()
			pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
			if _, err := database.ExecContext(context.Background(),
				`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
				uid, auth.HashToken(token), "test", "127.0.0.1", pastTime,
			); err != nil {
				t.Fatalf("insert expired session: %v", err)
			}
			return token
		}},
		{"api token touch", func(t *testing.T, database *db.DB) string {
			uid := mustCreateUser(t, database, "wedge-bot", "hash", 4)
			token, _ := auth.GenerateToken()
			if _, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(token), "ci", nil); err != nil {
				t.Fatalf("CreateAPIToken: %v", err)
			}
			return token
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			database := newAPITestDB(t)
			token := tt.seed(t, database)
			store := &blockingSessionStore{DB: database, ended: make(chan error, 1)}
			h := api.AuthMiddleware(service.NewSessionService(store))(http.HandlerFunc(ok))

			h.ServeHTTP(httptest.NewRecorder(), withBearer(httptest.NewRequest(http.MethodGet, "/", nil), token))

			select {
			case err := <-store.ended:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Errorf("background write ended with %v, want context.DeadlineExceeded", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("background write never ended: its ctx has no deadline")
			}
		})
	}
}

// ─── RequirePermission tests ──────────────────────────────────────────────────

func TestRequirePermission_Allowed(t *testing.T) {
	database := newAPITestDB(t)
	_, token, _ := seedLoginSession(t, database, "carol", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(
		api.RequirePermission(permissions.SendMessages)(http.HandlerFunc(ok)),
	)
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusOK)
}

func TestRequirePermission_Forbidden(t *testing.T) {
	database := newAPITestDB(t)
	_, token, _ := seedLoginSession(t, database, "dave", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(
		api.RequirePermission(permissions.ManageRoles)(http.HandlerFunc(ok)),
	)
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusForbidden)
}

func TestRequirePermission_Administrator_Bypass(t *testing.T) {
	database := newAPITestDB(t)
	// Owner role (id=1) has permissions 0x7FFFFFFF which includes ADMINISTRATOR (0x40000000)
	_, token, _ := seedLoginSession(t, database, "owner", 1)

	// Any permission should pass for ADMINISTRATOR
	h := api.AuthMiddleware(service.NewSessionService(database))(
		api.RequirePermission(permissions.ManageRoles)(http.HandlerFunc(ok)),
	)
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusOK)
}

// TestRequirePermission_MultiBitRequiresAllBits pins the one behaviour the
// HasServerPerm consolidation changed: a multi-bit mask is ALL-of, not any-of.
// The previous raw `role.Permissions&perm == 0` test returned 200 here because
// Member holds SendMessages, which was enough to make the mask non-zero.
func TestRequirePermission_MultiBitRequiresAllBits(t *testing.T) {
	database := newAPITestDB(t)
	_, token, _ := seedLoginSession(t, database, "multibit", 4)

	h := api.AuthMiddleware(service.NewSessionService(database))(
		api.RequirePermission(permissions.SendMessages | permissions.ManageRoles)(http.HandlerFunc(ok)),
	)
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusForbidden)
}

// TestRequirePermission_NoRoleInContext pins the fail-closed branch: the
// server-wide authz chokepoint must deny when the request context carries no
// usable *db.Role. Every other RequirePermission test composes AuthMiddleware,
// which always installs a non-nil role, so without this the guard could be
// rewritten to `if !ok { next.ServeHTTP(w, r); return }` and stay green.
func TestRequirePermission_NoRoleInContext(t *testing.T) {
	var nilRole *db.Role

	tests := []struct {
		name string
		ctx  func(context.Context) context.Context
	}{
		{"missing key", func(ctx context.Context) context.Context { return ctx }},
		{"typed nil role", func(ctx context.Context) context.Context {
			return context.WithValue(ctx, api.RoleKey, nilRole)
		}},
		{"wrong type", func(ctx context.Context) context.Context {
			return context.WithValue(ctx, api.RoleKey, "administrator")
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			downstream := false
			h := api.RequirePermission(permissions.ManageServer)(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					downstream = true
					ok(w, r)
				}),
			)
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req = req.WithContext(tt.ctx(req.Context()))
			rr := serveRequest(h, req)

			expectStatus(t, rr, http.StatusForbidden)
			if downstream {
				t.Error("RequirePermission without role ran the downstream handler")
			}
		})
	}
}

// ─── RateLimitMiddleware tests ────────────────────────────────────────────────

func TestRateLimitMiddleware_UnderLimit(t *testing.T) {
	limiter := auth.NewRateLimiter()

	h := api.RateLimitMiddleware(limiter, "test:", 5, time.Minute)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestRateLimitMiddleware_OverLimit(t *testing.T) {
	limiter := auth.NewRateLimiter()
	limit := 3

	h := api.RateLimitMiddleware(limiter, "test:", limit, time.Minute)(http.HandlerFunc(ok))

	for range limit {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.2:1234"
		serveRequest(h, req)
	}

	// This next request should be rate-limited.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.2:1234"
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusTooManyRequests)
}

func TestRateLimitMiddleware_RetryAfterHeader(t *testing.T) {
	limiter := auth.NewRateLimiter()

	h := api.RateLimitMiddleware(limiter, "test:", 1, time.Minute)(http.HandlerFunc(ok))

	// Exhaust limit.
	for range 2 {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.3:1234"
		serveRequest(h, req)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.3:1234"
	rr := serveRequest(h, req)

	if rr.Header().Get("Retry-After") == "" {
		t.Error("RateLimitMiddleware: missing Retry-After header on 429 response")
	}
}

func TestRateLimitMiddleware_XRealIPIgnoredWithoutTrustedProxy(t *testing.T) {
	// Without trusted proxies configured, X-Real-IP must be ignored.
	// Each request with the same RemoteAddr host counts as the same IP regardless
	// of what the X-Real-IP header says.
	limiter := auth.NewRateLimiter()
	limit := 2

	h := api.RateLimitMiddleware(limiter, "test:", limit, time.Minute)(http.HandlerFunc(ok))

	// Two requests from RemoteAddr 10.0.0.99 with an attacker-supplied X-Real-IP.
	for range limit {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Real-IP", "192.168.1.1") // forged; must be ignored
		req.RemoteAddr = "10.0.0.99:9999"
		serveRequest(h, req)
	}

	// Third request from the same RemoteAddr should be blocked — rate key is
	// 10.0.0.99, not the forged 192.168.1.1.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Real-IP", "192.168.1.1")
	req.RemoteAddr = "10.0.0.99:9999"
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusTooManyRequests)
}

// lockedBuffer is a goroutine-safe writer for capturing log output.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestRateLimitMiddleware_InvalidCIDRWarnsAtConstructionNotPerRequest locks
// the W3-3a hoist: the trusted-proxy CIDR list is parsed once when the
// middleware is constructed — warning about invalid entries there — never on
// the per-request path.
func TestRateLimitMiddleware_InvalidCIDRWarnsAtConstructionNotPerRequest(t *testing.T) {
	logBuf := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logBuf, nil)))
	defer slog.SetDefault(prev)

	limiter := auth.NewRateLimiter()
	h := api.RateLimitMiddleware(limiter, "test:", 100, time.Minute,
		[]string{"not-a-cidr", "10.0.0.0/8"})(http.HandlerFunc(ok))

	const warnMsg = "ignoring invalid CIDR entry"
	if got := strings.Count(logBuf.String(), warnMsg); got != 1 {
		t.Fatalf("invalid-CIDR warnings at construction = %d, want 1 (log: %q)",
			got, logBuf.String())
	}

	// The valid entry still works: X-Real-IP honoured from the trusted proxy.
	for range 3 {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.1:9999"
		req.Header.Set("X-Real-IP", "203.0.113.77")
		rr := serveRequest(h, req)
		requireStatus(t, rr, http.StatusOK)
	}

	if got := strings.Count(logBuf.String(), warnMsg); got != 1 {
		t.Fatalf("invalid-CIDR warnings after 3 requests = %d, want 1 — CIDRs re-parsed on the request path (log: %q)",
			got, logBuf.String())
	}
}

func TestRateLimitMiddleware_XRealIPHonouredFromTrustedProxy(t *testing.T) {
	// With a trusted proxy configured, X-Real-IP from that proxy is used.
	limiter := auth.NewRateLimiter()
	limit := 2
	trustedCIDRs := []string{"10.0.0.0/8"}

	h := api.RateLimitMiddleware(limiter, "test:", limit, time.Minute, trustedCIDRs)(http.HandlerFunc(ok))

	// Two requests coming through trusted proxy 10.0.0.1, client IP 203.0.113.5.
	for range limit {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Real-IP", "203.0.113.5")
		req.RemoteAddr = "10.0.0.1:9999"
		serveRequest(h, req)
	}

	// Third request with same X-Real-IP from same trusted proxy — should be blocked.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Real-IP", "203.0.113.5")
	req.RemoteAddr = "10.0.0.1:9999"
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusTooManyRequests)
}

// ─── Fix 2.10: Ban expiry in AuthMiddleware ───────────────────────────────────

// TestAuthMiddleware_BannedUserBlocked verifies that an actively banned user
// with no expiry cannot pass the auth middleware.
func TestAuthMiddleware_BannedUserBlocked(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "banneduser", "hash", 4)
	_ = database.BanUser(context.Background(), uid, "rule violation", nil) // permanent ban
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	_, _ = database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1")

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusForbidden)
}

// TestAuthMiddleware_ExpiredBanAllowed verifies that a user whose ban has
// expired in the past can pass the auth middleware.
func TestAuthMiddleware_ExpiredBanAllowed(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "expbanned", "hash", 4)

	// Set ban with an expiry time in the past.
	past := time.Now().UTC().Add(-time.Hour)
	_ = database.BanUser(context.Background(), uid, "temp ban", &past)

	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	_, _ = database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1")

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusOK)
}

// TestAuthMiddleware_ActiveTemporaryBanBlocked verifies that a user with a
// temporary ban whose expiry is in the future is still blocked.
func TestAuthMiddleware_ActiveTemporaryBanBlocked(t *testing.T) {
	database := newAPITestDB(t)
	uid := mustCreateUser(t, database, "tempbanned", "hash", 4)

	// Set ban with an expiry time in the future.
	future := time.Now().UTC().Add(time.Hour)
	_ = database.BanUser(context.Background(), uid, "temp ban", &future)

	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	_, _ = database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1")

	h := api.AuthMiddleware(service.NewSessionService(database))(http.HandlerFunc(ok))
	rr := serveBearerGET(h, token)

	expectStatus(t, rr, http.StatusForbidden)
}

// ─── SecurityHeaders tests ───────────────────────────────────────────────────

func TestSecurityHeaders_AllHeadersPresent(t *testing.T) {
	h := api.SecurityHeaders(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	want := map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"X-Xss-Protection":        "0",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
		"Content-Security-Policy": "default-src 'self'",
		"Permissions-Policy":      "camera=(), microphone=(), geolocation=()",
		"Cache-Control":           "no-store",
	}
	for header, expected := range want {
		if got := rr.Header().Get(header); got != expected {
			t.Errorf("SecurityHeaders: %s = %q, want %q", header, got, expected)
		}
	}
}

func TestSecurityHeaders_PassesThrough(t *testing.T) {
	// Middleware must not swallow the response — downstream handler must be called.
	called := false
	h := api.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	if !called {
		t.Error("SecurityHeaders: downstream handler was not called")
	}
	if rr.Code != http.StatusTeapot {
		t.Errorf("SecurityHeaders: status = %d, want 418", rr.Code)
	}
}

func TestSecurityHeaders_DoesNotOverrideExistingHeaders(t *testing.T) {
	// If a downstream handler sets its own CSP, SecurityHeaders should not clobber it
	// because it runs before the handler writes. The middleware sets headers first,
	// the handler can then override them — that is the correct layering.
	// This test just confirms the middleware itself sets all seven headers.
	h := api.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Handler overrides CSP after SecurityHeaders has already set it.
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	// The handler's override wins because it runs after the middleware sets the header.
	if got := rr.Header().Get("Content-Security-Policy"); got != "default-src 'none'" {
		t.Errorf("SecurityHeaders: handler CSP override = %q, want \"default-src 'none'\"", got)
	}
}

// ─── MaxBodySize tests ────────────────────────────────────────────────────────

func TestMaxBodySize_UnderLimit(t *testing.T) {
	// A body smaller than the limit must be read successfully by the handler.
	const limit = 10                   // bytes
	body := strings.NewReader("hello") // 5 bytes — under limit

	h := api.MaxBodySize(limit)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := make([]byte, 20)
		n, _ := r.Body.Read(data)
		if n != 5 {
			t.Errorf("MaxBodySize under limit: read %d bytes, want 5", n)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/", body)
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestMaxBodySize_ExactLimit(t *testing.T) {
	// A body exactly at the limit must be read without error.
	const limit = 5
	body := strings.NewReader("hello") // exactly 5 bytes

	h := api.MaxBodySize(limit)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := make([]byte, 10)
		n, _ := r.Body.Read(data)
		if n != 5 {
			t.Errorf("MaxBodySize exact limit: read %d bytes, want 5", n)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/", body)
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestMaxBodySize_OverLimit(t *testing.T) {
	// Reading beyond the limit must return an error from MaxBytesReader.
	const limit = 5
	body := strings.NewReader("hello world") // 11 bytes — over limit

	var readErr error
	h := api.MaxBodySize(limit)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := make([]byte, 20)
		_, readErr = r.Body.Read(data)
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/", body)
	serveRequest(h, req)

	if readErr == nil {
		t.Error("MaxBodySize over limit: expected read error, got nil")
	}
}

func TestMaxBodySize_NilBody(t *testing.T) {
	// GET requests with no body must pass through without panic.
	h := api.MaxBodySize(1024)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()

	// Must not panic.
	h.ServeHTTP(rr, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestMaxBodySize_PassesThrough(t *testing.T) {
	// Downstream handler must be called and its status code preserved.
	h := api.MaxBodySize(1024)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("data"))
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusCreated)
}

// ─── AdminIPRestrict tests ──────────────────────────────────────────────────

func TestAdminIPRestrict_AllowedCIDR(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"127.0.0.0/8"}, nil)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveLocal(h, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestAdminIPRestrict_BlockedCIDR(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"10.0.0.0/8"}, nil)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.168.1.1:9999" // not in 10.0.0.0/8
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusForbidden)
}

// TestAdminIPRestrict_BlockedNamesTheSetting pins OP-05: the refusal must name
// server.admin_allowed_cidrs so a self-hoster on a VPS can fix it without
// reading the source, and must not disclose the configured CIDRs or the
// address the server saw. Without the name the operator sees a bare "access
// denied" and has no way to tell a firewall from this setting.
func TestAdminIPRestrict_BlockedNamesTheSetting(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"10.0.0.0/8"}, nil)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.168.1.1:9999"
	rr := serveRequest(h, req)

	body := rr.Body.String()
	if !strings.Contains(body, "server.admin_allowed_cidrs") {
		t.Errorf("403 body does not name server.admin_allowed_cidrs: %s", body)
	}
	if strings.Contains(body, "192.168.1.1") || strings.Contains(body, "10.0.0.0/8") {
		t.Errorf("403 body leaks the client address or the configured CIDRs: %s", body)
	}
}

func TestAdminIPRestrict_EmptyAllowsAll(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", nil, nil)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.1:9999"
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusOK)
}

func TestAdminIPRestrict_InvalidCIDR(t *testing.T) {
	// Invalid CIDR should fail closed: the entry is skipped at construction,
	// leaving a non-empty allowed list with zero parsed networks — nothing
	// matches, so access is denied.
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"not-a-cidr"}, nil)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveLocal(h, req)

	expectStatus(t, rr, http.StatusForbidden)
}

func TestAdminIPRestrict_MultipleCIDRs(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"10.0.0.0/8", "192.168.0.0/16"}, nil)(http.HandlerFunc(ok))

	// First CIDR matches.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.1.2.3:9999"
	rr := serveRequest(h, req)
	expectStatus(t, rr, http.StatusOK)

	// Second CIDR matches.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.168.1.50:9999"
	rr = serveRequest(h, req)
	expectStatus(t, rr, http.StatusOK)

	// Neither matches.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "172.16.0.1:9999"
	rr = serveRequest(h, req)
	expectStatus(t, rr, http.StatusForbidden)
}

// ─── AdminIPRestrict proxy-aware tests (BUG-116) ─────────────────────────────

// TestAdminIPRestrict_TrustedProxy_UsesXForwardedFor verifies that when the
// connecting IP is a trusted proxy, the real client IP is extracted from
// X-Forwarded-For and checked against admin CIDRs.
func TestAdminIPRestrict_TrustedProxy_UsesXForwardedFor(t *testing.T) {
	// Admin allowed: only 203.0.113.0/24. Trusted proxy: 127.0.0.1.
	h := api.AdminIPRestrict("server.admin_allowed_cidrs",
		[]string{"203.0.113.0/24"},
		[]string{"127.0.0.0/8"},
	)(http.HandlerFunc(ok))

	// Request from proxy (127.0.0.1) with real client in XFF → allowed.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.50")
	rr := serveRequest(h, req)
	expectStatus(t, rr, http.StatusOK)

	// Request from proxy with disallowed real client → blocked.
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "198.51.100.1")
	rr = serveRequest(h, req)
	expectStatus(t, rr, http.StatusForbidden)
}

// TestAdminIPRestrict_TrustedProxy_UsesXRealIP verifies X-Real-IP is preferred
// over X-Forwarded-For when both are present from a trusted proxy.
func TestAdminIPRestrict_TrustedProxy_UsesXRealIP(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs",
		[]string{"203.0.113.0/24"},
		[]string{"127.0.0.0/8"},
	)(http.HandlerFunc(ok))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Real-IP", "203.0.113.50")
	rr := serveRequest(h, req)
	expectStatus(t, rr, http.StatusOK)
}

// TestAdminIPRestrict_UntrustedProxy_IgnoresHeaders verifies that proxy headers
// are ignored when the connecting IP is NOT a trusted proxy.
func TestAdminIPRestrict_UntrustedProxy_IgnoresHeaders(t *testing.T) {
	h := api.AdminIPRestrict("server.admin_allowed_cidrs",
		[]string{"203.0.113.0/24"},
		[]string{"10.0.0.0/8"}, // only 10.x is trusted
	)(http.HandlerFunc(ok))

	// Untrusted proxy at 192.168.1.1 tries to spoof XFF.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.168.1.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.50") // spoofed
	rr := serveRequest(h, req)
	expectStatus(t, rr, http.StatusForbidden)
}

// TestAdminIPRestrict_ProxyCollapse_WithoutTrusted verifies the original bug:
// without trusted proxies, a proxy on localhost makes everything appear local.
func TestAdminIPRestrict_ProxyCollapse_WithoutTrusted(t *testing.T) {
	// Admin CIDR: private networks. No trusted proxies.
	h := api.AdminIPRestrict("server.admin_allowed_cidrs",
		[]string{"127.0.0.0/8", "10.0.0.0/8"},
		nil, // no trusted proxies
	)(http.HandlerFunc(ok))

	// External client behind nginx on localhost — RemoteAddr is 127.0.0.1.
	// XFF has the real external IP, but it's ignored (no trusted proxies).
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "198.51.100.1") // real external IP
	rr := serveRequest(h, req)

	// Without trusted proxies, 127.0.0.1 is used — passes the private CIDR check.
	// This is the documented limitation: operators MUST configure trusted_proxies.
	expectStatus(t, rr, http.StatusOK)
}

// ─── SecurityHeadersWithTLS tests ───────────────────────────────────────────

func TestSecurityHeadersWithTLS_HSTS(t *testing.T) {
	h := api.SecurityHeadersWithTLS("auto")(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	if got := rr.Header().Get("Strict-Transport-Security"); got == "" {
		t.Error("SecurityHeadersWithTLS: missing HSTS header when TLS enabled")
	}
}

func TestSecurityHeadersWithTLS_NoHSTSWithoutTLS(t *testing.T) {
	h := api.SecurityHeadersWithTLS("")(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	if got := rr.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("SecurityHeadersWithTLS: unexpected HSTS header %q when TLS disabled", got)
	}
}

// ─── handleLiveKitHealth tests ──────────────────────────────────────────────

func TestLiveKitHealth_Healthy(t *testing.T) {
	h := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return true, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	if resp["status"] != "ok" {
		t.Errorf("status = %v, want ok", resp["status"])
	}
	if resp["livekit_reachable"] != true {
		t.Errorf("livekit_reachable = %v, want true", resp["livekit_reachable"])
	}
}

func TestLiveKitHealth_Unhealthy(t *testing.T) {
	h := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return false, fmt.Errorf("connection refused")
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	requireStatus(t, rr, http.StatusServiceUnavailable)

	resp := decodeBody[map[string]any](t, rr)
	if resp["status"] != "degraded" {
		t.Errorf("status = %v, want degraded", resp["status"])
	}
	if resp["livekit_reachable"] != false {
		t.Errorf("livekit_reachable = %v, want false", resp["livekit_reachable"])
	}
	if resp["error"] != "connection refused" {
		t.Errorf("error = %v, want 'connection refused'", resp["error"])
	}
}

func TestLiveKitHealth_UnhealthyNoError(t *testing.T) {
	h := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return false, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := serveRequest(h, req)

	requireStatus(t, rr, http.StatusServiceUnavailable)

	resp := decodeBody[map[string]any](t, rr)
	if resp["error"] != "unknown" {
		t.Errorf("error = %v, want 'unknown'", resp["error"])
	}
}

// apiTestSchema is the full schema needed for all api tests (middleware,
// auth handler, and invite handler).
var apiTestSchema = []byte(schemaAccounts + schemaMessaging + `
CREATE TABLE IF NOT EXISTS partial_auth_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device     TEXT    NOT NULL DEFAULT '',
    ip_address TEXT    NOT NULL DEFAULT '',
    failures   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_totp_enrollments (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS totp_used_codes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    expires_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    redeemed_by INTEGER REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
CREATE TABLE IF NOT EXISTS invite_redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_id   INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id     INTEGER,
    redeemed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_invite ON invite_redemptions(invite_id, id);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user   ON invite_redemptions(user_id);
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
	('require_2fa', 'false'),
	('registration_mode', 'invite');
CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category_id INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL,
    permissions_synced INTEGER NOT NULL DEFAULT 0,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    afk             INTEGER NOT NULL DEFAULT 0,
    parent_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    thread_starter_message_id INTEGER,
    thread_owner_id INTEGER,
    thread_archived INTEGER NOT NULL DEFAULT 0,
    thread_locked INTEGER NOT NULL DEFAULT 0,
    thread_auto_archive_minutes INTEGER NOT NULL DEFAULT 1440,
    thread_last_activity_at TEXT,
    forum_require_tag INTEGER NOT NULL DEFAULT 0,
    forum_default_auto_archive_minutes INTEGER NOT NULL DEFAULT 4320,
    import_pending INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_version INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0,
    dm_owner_id      INTEGER,
    dm_icon      TEXT
);
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    subject_token TEXT,
    actor_token TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);
`)

// TestRateLimitMiddleware_IPv6SharesSlash64Bucket pins that two addresses in
// one IPv6 /64 draw from the same per-IP budget: a single host usually holds
// the whole /64, so keying the full /128 would give it unlimited budget.
func TestRateLimitMiddleware_IPv6SharesSlash64Bucket(t *testing.T) {
	limiter := auth.NewRateLimiter()
	h := api.RateLimitMiddleware(limiter, "test:", 1, time.Minute)(http.HandlerFunc(ok))

	for i, remote := range []string{"[2001:db8:1:2::1]:1234", "[2001:db8:1:2::2]:1234"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = remote
		rr := serveRequest(h, req)
		want := http.StatusOK
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rr.Code != want {
			t.Errorf("request %d from %s: status = %d, want %d", i, remote, rr.Code, want)
		}
	}
}

// TestAdminIPRestrict_WarnsOnForwardedLocalPeerWithoutTrustedProxies pins the
// runtime hint for a reverse proxy nobody declared: a loopback peer sending
// X-Forwarded-For while trusted_proxies is empty means every client looks like
// the proxy, so the allowlist admits them all. It warns once, not per request,
// for either forwarding header the client-IP resolver reads.
func TestAdminIPRestrict_WarnsOnForwardedLocalPeerWithoutTrustedProxies(t *testing.T) {
	for _, header := range []string{"X-Forwarded-For", "X-Real-IP"} {
		t.Run(header, func(t *testing.T) {
			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
			t.Cleanup(func() { slog.SetDefault(prev) })

			h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"127.0.0.0/8"}, nil)(http.HandlerFunc(ok))
			for range 2 {
				req := httptest.NewRequest(http.MethodGet, "/", nil)
				req.RemoteAddr = "127.0.0.1:9999"
				req.Header.Set(header, "198.51.100.7")
				h.ServeHTTP(httptest.NewRecorder(), req)
			}

			if n := strings.Count(buf.String(), "trusted_proxies is empty"); n != 1 {
				t.Errorf("warned %d times, want exactly 1; log:\n%s", n, buf.String())
			}
		})
	}
}

// TestAdminIPRestrict_NoForwardedPeerWarningWhenPeerRefused: when the
// allowlist refuses the local proxy's address, it does not admit every client,
// so the warning claiming it does must stay silent.
func TestAdminIPRestrict_NoForwardedPeerWarningWhenPeerRefused(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := api.AdminIPRestrict("server.admin_allowed_cidrs", []string{"203.0.113.0/24"}, nil)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	rr := serveRequest(h, req)

	expectStatus(t, rr, http.StatusForbidden)
	if strings.Contains(buf.String(), "trusted_proxies is empty") {
		t.Errorf("warned although the allowlist refused the peer; log:\n%s", buf.String())
	}
}

// With the server's connection-writes batch installed, an API-token touch and
// an expired-session delete are only queued (ARCH-034): nothing is written
// until the batch flushes, and the flush then lands both. That no request
// spawns a goroutine is enforced by the invariants request-path-go rule, not
// by the goleak check here, which cannot prove it.
func TestAuthMiddleware_BatchedTouchAndDiscardAreQueuedUntilFlush(t *testing.T) {
	database := newAPITestDB(t)
	batch := service.NewConnWrites(database)
	sessions := service.NewSessionService(database)
	sessions.SetConnWrites(batch)

	uid := mustCreateUser(t, database, "batched-bot", "hash", 4)
	apiToken, _ := auth.GenerateToken()
	if _, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(apiToken), "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	expiredToken, _ := auth.GenerateToken()
	pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, auth.HashToken(expiredToken), "test", "127.0.0.1", pastTime,
	); err != nil {
		t.Fatalf("insert expired session: %v", err)
	}

	before := goleak.IgnoreCurrent()
	h := api.AuthMiddleware(sessions)(http.HandlerFunc(ok))
	for range 25 {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, withBearer(httptest.NewRequest(http.MethodGet, "/", nil), apiToken))
		requireStatus(t, rec, http.StatusOK)
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, withBearer(httptest.NewRequest(http.MethodGet, "/", nil), expiredToken))
		requireStatus(t, rec, http.StatusUnauthorized)
	}
	goleak.VerifyNone(t, before)

	var rows int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sessions WHERE token = ?`, auth.HashToken(expiredToken)).Scan(&rows); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if rows != 1 {
		t.Fatalf("expired session rows before the flush = %d, want 1 (the delete is queued, not written)", rows)
	}
	var lastUsed sql.NullString
	tokenHash := auth.HashToken(apiToken)
	if err := database.QueryRowContext(context.Background(),
		`SELECT last_used_at FROM api_tokens WHERE token_hash = ?`, tokenHash).Scan(&lastUsed); err != nil {
		t.Fatalf("read last_used_at: %v", err)
	}
	if lastUsed.Valid {
		t.Fatalf("api_tokens.last_used_at = %q before the flush, want NULL (the touch is queued, not written)", lastUsed.String)
	}
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sessions WHERE token = ?`, auth.HashToken(expiredToken)).Scan(&rows); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if rows != 0 {
		t.Fatalf("expired session rows after the flush = %d, want 0", rows)
	}
	if err := database.QueryRowContext(context.Background(),
		`SELECT last_used_at FROM api_tokens WHERE token_hash = ?`, tokenHash).Scan(&lastUsed); err != nil {
		t.Fatalf("read last_used_at: %v", err)
	}
	if !lastUsed.Valid {
		t.Fatal("api_tokens.last_used_at is still NULL after the flush")
	}
}
