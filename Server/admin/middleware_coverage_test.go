package admin_test

// Additional tests to increase branch coverage on adminAuthMiddleware,
// ownerOnlyMiddleware, and related helpers.

import (
	"net/http"
	"testing"
	"time"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
)

// ─── adminAuthMiddleware edge cases ──────────────────────────────────────────

// TestAdminAuthMiddleware_ExpiredSession verifies that a valid token whose
// session has expired is rejected with 401.
func TestAdminAuthMiddleware_ExpiredSession(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	// Create a user and session, then manually expire the session by setting
	// expires_at to a past timestamp via the exported Exec helper.
	uid, err := database.CreateUser("expireduser", "$2a$12$x", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token := "expired-session-token"
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Set expires_at to yesterday so the session is treated as expired.
	pastTime := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02T15:04:05Z")
	if _, err := database.Exec(
		`UPDATE sessions SET expires_at = ? WHERE token = ?`,
		pastTime, tokenHash,
	); err != nil {
		t.Fatalf("UPDATE sessions expires_at: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expired session status = %d, want 401; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAuthMiddleware_MissingBearer verifies that a request with no
// Authorization header returns 401.
func TestAdminAuthMiddleware_MissingBearer(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/stats", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("missing bearer status = %d, want 401", w.Code)
	}
}

// TestAdminAuthMiddleware_InvalidToken verifies that a token not in the
// sessions table returns 401.
func TestAdminAuthMiddleware_InvalidToken(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/stats", "completely-invalid-token", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("invalid token status = %d, want 401", w.Code)
	}
}
