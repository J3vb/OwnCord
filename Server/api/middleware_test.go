package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

func newAPITestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: apiTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
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
	uid, _ := database.CreateUser("alice", "hash", 4)
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	database.CreateSession(uid, hash, "test", "127.0.0.1")

	h := api.AuthMiddleware(database)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("AuthMiddleware valid token status = %d, want %d", rr.Code, http.StatusOK)
	}
}

func TestAuthMiddleware_MissingToken(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(database)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("AuthMiddleware no token status = %d, want 401", rr.Code)
	}
}

func TestAuthMiddleware_InvalidToken(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(database)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, "notarealtoken")
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("AuthMiddleware invalid token status = %d, want 401", rr.Code)
	}
}

func TestAuthMiddleware_ExpiredSession(t *testing.T) {
	database := newAPITestDB(t)
	uid, _ := database.CreateUser("bob", "hash", 4)
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)

	// Insert an already-expired session.
	pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	database.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, hash, "test", "127.0.0.1", pastTime,
	)

	h := api.AuthMiddleware(database)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("AuthMiddleware expired session status = %d, want 401", rr.Code)
	}
}

func TestAuthMiddleware_MalformedAuthHeader(t *testing.T) {
	database := newAPITestDB(t)

	h := api.AuthMiddleware(database)(http.HandlerFunc(ok))

	cases := []string{
		"Token abc",      // wrong scheme
		"Bearer",         // missing token after Bearer
		"abc",            // no space
	}
	for _, header := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", header)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("AuthMiddleware header=%q status = %d, want 401", header, rr.Code)
		}
	}
}

// ─── RequirePermission tests ──────────────────────────────────────────────────

func TestRequirePermission_Allowed(t *testing.T) {
	database := newAPITestDB(t)
	uid, _ := database.CreateUser("carol", "hash", 4) // Member role = 0x00100601
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	database.CreateSession(uid, hash, "test", "127.0.0.1")

	// SEND_MESSAGES = 0x1 — Member role has this bit
	h := api.AuthMiddleware(database)(
		api.RequirePermission(0x1)(http.HandlerFunc(ok)),
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("RequirePermission allowed status = %d, want 200", rr.Code)
	}
}

func TestRequirePermission_Forbidden(t *testing.T) {
	database := newAPITestDB(t)
	uid, _ := database.CreateUser("dave", "hash", 4) // Member role = 0x00100601
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	database.CreateSession(uid, hash, "test", "127.0.0.1")

	// MANAGE_ROLES = 0x1000000 — Member does not have this
	h := api.AuthMiddleware(database)(
		api.RequirePermission(0x1000000)(http.HandlerFunc(ok)),
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("RequirePermission forbidden status = %d, want 403", rr.Code)
	}
}

func TestRequirePermission_Administrator_Bypass(t *testing.T) {
	database := newAPITestDB(t)
	// Owner role (id=1) has permissions 0x7FFFFFFF which includes ADMINISTRATOR (0x40000000)
	uid, _ := database.CreateUser("owner", "hash", 1)
	token, _ := auth.GenerateToken()
	hash := auth.HashToken(token)
	database.CreateSession(uid, hash, "test", "127.0.0.1")

	// Any permission should pass for ADMINISTRATOR
	h := api.AuthMiddleware(database)(
		api.RequirePermission(0x1000000)(http.HandlerFunc(ok)),
	)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	withBearer(req, token)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("RequirePermission administrator bypass status = %d, want 200", rr.Code)
	}
}

// ─── RateLimitMiddleware tests ────────────────────────────────────────────────

func TestRateLimitMiddleware_UnderLimit(t *testing.T) {
	limiter := auth.NewRateLimiter()

	h := api.RateLimitMiddleware(limiter, 5, time.Minute)(http.HandlerFunc(ok))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("RateLimitMiddleware under limit status = %d, want 200", rr.Code)
	}
}

func TestRateLimitMiddleware_OverLimit(t *testing.T) {
	limiter := auth.NewRateLimiter()
	limit := 3

	h := api.RateLimitMiddleware(limiter, limit, time.Minute)(http.HandlerFunc(ok))

	for i := 0; i < limit; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.2:1234"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
	}

	// This next request should be rate-limited.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.2:1234"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("RateLimitMiddleware over limit status = %d, want 429", rr.Code)
	}
}

func TestRateLimitMiddleware_RetryAfterHeader(t *testing.T) {
	limiter := auth.NewRateLimiter()

	h := api.RateLimitMiddleware(limiter, 1, time.Minute)(http.HandlerFunc(ok))

	// Exhaust limit.
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.3:1234"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.3:1234"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Header().Get("Retry-After") == "" {
		t.Error("RateLimitMiddleware: missing Retry-After header on 429 response")
	}
}

func TestRateLimitMiddleware_XRealIPUsed(t *testing.T) {
	limiter := auth.NewRateLimiter()
	limit := 2

	h := api.RateLimitMiddleware(limiter, limit, time.Minute)(http.HandlerFunc(ok))

	// Two requests from the same X-Real-IP but different RemoteAddr.
	for i := 0; i < limit; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Real-IP", "192.168.1.1")
		req.RemoteAddr = "10.0.0.99:9999"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
	}

	// Third request should be blocked by the X-Real-IP key.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Real-IP", "192.168.1.1")
	req.RemoteAddr = "10.0.0.99:9999"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("RateLimitMiddleware X-Real-IP status = %d, want 429", rr.Code)
	}
}

// apiTestSchema is the full schema needed for all api tests (middleware,
// auth handler, and invite handler).
var apiTestSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1049089,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

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
`)
