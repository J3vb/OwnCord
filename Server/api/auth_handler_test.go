package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// newAuthTestDB builds an in-memory DB with the full schema needed for auth tests.
func newAuthTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: apiTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// buildAuthRouter returns a chi router with auth routes mounted on /api/v1/auth.
func buildAuthRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	r := chi.NewRouter()
	api.MountAuthRoutes(r, database, limiter)
	return r
}

// postJSON is a test helper that POSTs JSON to the given router.
func postJSON(t *testing.T, router http.Handler, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// postJSONWithToken posts with an Authorization header.
func postJSONWithToken(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// getWithToken performs a GET with an Authorization header.
func getWithToken(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// ─── Register tests ───────────────────────────────────────────────────────────

func TestRegister_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Create an invite first.
	ownerID, _ := database.CreateUser("owner", "hash", 1)
	code, _ := database.CreateInvite(ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "securePass1",
		"invite_code": code,
	})

	if rr.Code != http.StatusCreated {
		t.Errorf("Register status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["token"] == nil {
		t.Error("Register response missing token")
	}
	if resp["user"] == nil {
		t.Error("Register response missing user")
	}
}

func TestRegister_InvalidInvite(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "securePass1",
		"invite_code": "bogus",
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Register invalid invite status = %d, want 400", rr.Code)
	}
}

func TestRegister_WeakPassword(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	ownerID, _ := database.CreateUser("owner2", "hash", 1)
	code, _ := database.CreateInvite(ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "short",
		"invite_code": code,
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Register weak password status = %d, want 400", rr.Code)
	}
}

func TestRegister_InviteUsedUp(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	ownerID, _ := database.CreateUser("owner3", "hash", 1)
	code, _ := database.CreateInvite(ownerID, 1, nil) // max 1 use

	// First registration should succeed.
	postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "user1",
		"password":    "securePass1",
		"invite_code": code,
	})

	// Second should fail — invite exhausted.
	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "user2",
		"password":    "securePass2",
		"invite_code": code,
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Register exhausted invite status = %d, want 400", rr.Code)
	}
}

func TestRegister_MissingFields(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("Register missing fields status = %d, want 400", rr.Code)
	}
}

func TestRegister_ErrorNeverRevealUsername(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "someone",
		"password":    "securePass1",
		"invite_code": "bogus",
	})

	body := rr.Body.String()
	// Must not hint that the username doesn't exist or the invite is invalid specifically
	if contains(body, "username") && contains(body, "taken") {
		t.Error("Register error message reveals username status")
	}
}

// ─── Login tests ──────────────────────────────────────────────────────────────

func TestLogin_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	_, _ = database.CreateUser("loginuser", hash, 4)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "loginuser",
		"password": "correctPass1",
	})

	if rr.Code != http.StatusOK {
		t.Errorf("Login status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["token"] == nil {
		t.Error("Login response missing token")
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	_, _ = database.CreateUser("loginuser2", hash, 4)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "loginuser2",
		"password": "wrongpassword",
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Login wrong password status = %d, want 401", rr.Code)
	}
}

func TestLogin_UnknownUser(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "nobody",
		"password": "anypass123",
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Login unknown user status = %d, want 401", rr.Code)
	}
}

func TestLogin_GenericErrorOnBadCredentials(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "nobody",
		"password": "anypass123",
	})

	body := rr.Body.String()
	// The response must never reveal whether the user exists
	if contains(body, "user not found") || contains(body, "does not exist") {
		t.Errorf("Login error reveals user existence: %s", body)
	}
}

func TestLogin_BannedUser(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	id, _ := database.CreateUser("banned", hash, 4)
	_ = database.BanUser(id, "violated rules", nil)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "banned",
		"password": "correctPass1",
	})

	if rr.Code != http.StatusForbidden {
		t.Errorf("Login banned user status = %d, want 403", rr.Code)
	}
}

func TestLogin_MissingFields(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("Login missing fields status = %d, want 400", rr.Code)
	}
}

// ─── Logout tests ─────────────────────────────────────────────────────────────

func TestLogout_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	uid, _ := database.CreateUser("logoutuser", hash, 4)
	token, _ := auth.GenerateToken()
	tokenHash := auth.HashToken(token)
	_, _ = database.CreateSession(uid, tokenHash, "test", "127.0.0.1")

	rr := postJSONWithToken(t, router, "/api/v1/auth/logout", token, nil)

	if rr.Code != http.StatusNoContent {
		t.Errorf("Logout status = %d, want 204", rr.Code)
	}

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash(tokenHash)
	if sess != nil {
		t.Error("Session still exists after logout")
	}
}

func TestLogout_NoAuth(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Logout no auth status = %d, want 401", rr.Code)
	}
}

// ─── Me tests ─────────────────────────────────────────────────────────────────

func TestMe_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	uid, _ := database.CreateUser("meuser", hash, 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := getWithToken(t, router, "/api/v1/auth/me", token)

	if rr.Code != http.StatusOK {
		t.Errorf("Me status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["id"] == nil {
		t.Error("Me response missing id")
	}
	if resp["username"] != "meuser" {
		t.Errorf("Me username = %v, want meuser", resp["username"])
	}
}

func TestMe_NoAuth(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Me no auth status = %d, want 401", rr.Code)
	}
}

// ─── Fix 2.5: Password trim fix ───────────────────────────────────────────────

// TestLogin_PasswordWithLeadingSpaceIsPreserved verifies that a password with
// leading whitespace is NOT trimmed, so a user who set " securePass1" can log
// in with " securePass1" and NOT with "securePass1".
func TestLogin_PasswordWithLeadingSpaceIsPreserved(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Hash the password WITH the leading space — this is what was registered.
	hash, _ := auth.HashPassword(" securePass1")
	_, _ = database.CreateUser("spacepassuser", hash, 4)

	// Login with the exact same password (including space) must succeed.
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "spacepassuser",
		"password": " securePass1",
	})

	if rr.Code != http.StatusOK {
		t.Errorf("Login space-prefixed password status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
}

// TestLogin_PasswordWithLeadingSpaceTrimmedFails verifies that logging in with
// the trimmed version of a space-prefixed password correctly fails.
func TestLogin_PasswordWithLeadingSpaceTrimmedFails(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Register with password that has a leading space.
	hash, _ := auth.HashPassword(" securePass1")
	_, _ = database.CreateUser("spacepassuser2", hash, 4)

	// Login without the leading space must fail.
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "spacepassuser2",
		"password": "securePass1",
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Login trimmed space password status = %d, want 401; body = %s", rr.Code, rr.Body.String())
	}
}

// TestLogin_PasswordWithTrailingSpaceIsPreserved verifies that a password with
// trailing whitespace is NOT trimmed.
func TestLogin_PasswordWithTrailingSpaceIsPreserved(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("securePass1 ")
	_, _ = database.CreateUser("trailingspaceuser", hash, 4)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "trailingspaceuser",
		"password": "securePass1 ",
	})

	if rr.Code != http.StatusOK {
		t.Errorf("Login trailing-space password status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
}

// TestLogin_UsernameIsStillTrimmed verifies that the username IS still trimmed
// (only the password trim was removed).
func TestLogin_UsernameIsStillTrimmed(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	hash, _ := auth.HashPassword("correctPass1")
	_, _ = database.CreateUser("trimuser", hash, 4)

	// Username with surrounding spaces should resolve to "trimuser".
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "  trimuser  ",
		"password": "correctPass1",
	})

	if rr.Code != http.StatusOK {
		t.Errorf("Login space-padded username status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
}

// ─── Rate limiting integration test ──────────────────────────────────────────

func TestRegister_RateLimit(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	ownerID, _ := database.CreateUser("rl_owner", "hash", 1)

	// Attempt register 4 times (limit=3) — 4th should be rate-limited.
	var lastCode int
	for i := range 4 {
		code, _ := database.CreateInvite(ownerID, 1, nil)
		rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
			"username":    "rl_user" + string(rune('0'+i)),
			"password":    "securePass1",
			"invite_code": code,
		})
		lastCode = rr.Code
	}

	if lastCode != http.StatusTooManyRequests {
		t.Errorf("Register rate limit: last attempt status = %d, want 429", lastCode)
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// expiredInviteDB creates a DB with an already-expired invite.
func expiredInviteDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	database := newAuthTestDB(t)
	ownerID, _ := database.CreateUser("expowner", "hash", 1)
	past := time.Now().Add(-time.Hour)
	code, _ := database.CreateInvite(ownerID, 0, &past)
	return database, code
}

func TestRegister_ExpiredInvite(t *testing.T) {
	database, code := expiredInviteDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "securePass1",
		"invite_code": code,
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Register expired invite status = %d, want 400", rr.Code)
	}
}
