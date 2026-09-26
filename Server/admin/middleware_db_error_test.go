// Package admin whitebox test for OC-0225: adminAuthMiddleware must not
// report a transient DB error from auth.ResolveTokenHash as 401. A wrapped
// DB error is not "invalid or expired session" — treating it as one ejects
// an admin whose session was never revoked (see the finding for the desktop
// client's onUnauthorized -> clearAuth -> deleteCredential chain triggered by
// a stray 401).
package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// TestAdminAuthMiddleware_DBErrorIsNotUnauthorized verifies that when
// ResolveTokenHash fails with a wrapped (non-sentinel) DB error — as happens
// when the underlying SQLite connection is unavailable — adminAuthMiddleware
// reports 503 SERVICE_UNAVAILABLE, not 401 UNAUTHORIZED. A 401 here is
// indistinguishable from a genuinely dead/unknown session and drives the
// desktop client to clear auth and delete the stored credential for a
// session that was never actually revoked.
func TestAdminAuthMiddleware_DBErrorIsNotUnauthorized(t *testing.T) {
	database := openWhiteboxTestDB(t)

	uid, err := database.CreateUser(context.Background(), "dberroruser", "$2a$12$x", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token := "db-error-token"
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Close the DB so the very next query — GetSessionByTokenHash, called
	// from inside ResolveTokenHash — fails with a wrapped, non-sentinel
	// error (not sql.ErrNoRows, so not ErrTokenNotFound either).
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	handler := NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code == http.StatusUnauthorized {
		t.Fatalf("status = %d (UNAUTHORIZED), want 503 (SERVICE_UNAVAILABLE) for a transient DB error; body: %s", w.Code, w.Body.String())
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 (SERVICE_UNAVAILABLE); body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] == "UNAUTHORIZED" {
		t.Errorf("error = %q, must not be UNAUTHORIZED for a DB outage", resp["error"])
	}
}
