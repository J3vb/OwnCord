package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// buildProfileRouter returns a chi router with profile routes mounted.
func buildProfileRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, database, limiter, nil)
	return r
}

// profileCreateToken creates a user and session, returning the raw token.
func profileCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	uid, err := database.CreateUser(username, mustHash(t), roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	expiresAt := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05Z")
	_, err = database.Exec(
		"INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)",
		uid, auth.HashToken(token), "TestAgent", "127.0.0.1", expiresAt,
	)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
	return token
}

// mustHash returns a bcrypt hash of a standard test password.
func mustHash(t *testing.T) string {
	t.Helper()
	h, err := auth.HashPassword("securePass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	return h
}

// patchJSON sends a PATCH request with JSON body and auth token.
func patchJSON(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPatch, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// putJSON sends a PUT request with JSON body and auth token.
func putJSON(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// profileDelete sends a DELETE request with an auth token (no body).
func profileDelete(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// ─── PATCH /api/v1/users/me ──────────────────────────────────────────────────

func TestUpdateProfile_Success(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "patchuser", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "newname",
		"avatar":   "https://example.com/av.png",
	})

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["username"] != "newname" {
		t.Errorf("username = %v, want 'newname'", resp["username"])
	}
}

func TestUpdateProfile_EmptyUsername(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "emptyuser", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "",
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpdateProfile_UsernameTaken(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	profileCreateToken(t, database, "takenname", 4)
	token := profileCreateToken(t, database, "wannatake", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "takenname",
	})

	if rr.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpdateProfile_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	rr := patchJSON(t, router, "/api/v1/users/me", "badtoken", map[string]string{
		"username": "hacker",
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

// ─── PUT /api/v1/users/me/password ──────────────────────────────────────────

func TestChangePassword_Success(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "pwuser", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "securePass1",
		"new_password": "newSecure2",
	})

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestChangePassword_WrongOldPassword(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "wrongpw", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "wrongPassword1",
		"new_password": "newSecure2",
	})

	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
}

func TestChangePassword_WeakNewPassword(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "weakpw", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "securePass1",
		"new_password": "short",
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestChangePassword_SamePassword(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "samepw", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "securePass1",
		"new_password": "securePass1",
	})

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

// ─── GET /api/v1/users/me/sessions ──────────────────────────────────────────

func TestListSessions_Success(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "sessuser", 4)

	rr := getWithToken(t, router, "/api/v1/users/me/sessions", token)

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Sessions) == 0 {
		t.Error("expected at least 1 session (the current one)")
	}

	// Verify is_current flag is present.
	found := false
	for _, s := range resp.Sessions {
		if isCurrent, ok := s["is_current"]; ok && isCurrent == true {
			found = true
		}
	}
	if !found {
		t.Error("no session has is_current=true")
	}
}

func TestListSessions_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	rr := getWithToken(t, router, "/api/v1/users/me/sessions", "badtoken")

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

// ─── DELETE /api/v1/users/me/sessions/:id ───────────────────────────────────

func TestRevokeSession_Success(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revoke", 4)

	// Create a second session to revoke.
	user, _ := database.GetUserByUsername("revoke")
	secondSessID, _ := database.CreateSession(user.ID, auth.HashToken("second-tok"), "Firefox", "1.2.3.4")

	rr := profileDelete(t, router, fmt.Sprintf("/api/v1/users/me/sessions/%d", secondSessID), token)

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestRevokeSession_NotFound(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revokenf", 4)

	rr := profileDelete(t, router, "/api/v1/users/me/sessions/99999", token)

	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body = %s", rr.Code, rr.Body.String())
	}
}

func TestRevokeSession_OtherUsersSession(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revokeother", 4)

	// Create another user with a session.
	otherUID, _ := database.CreateUser("victim", mustHash(t), 4)
	otherSessID, _ := database.CreateSession(otherUID, auth.HashToken("victim-tok"), "Safari", "9.8.7.6")

	rr := profileDelete(t, router, fmt.Sprintf("/api/v1/users/me/sessions/%d", otherSessID), token)

	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (should not reveal other user's session); body = %s", rr.Code, rr.Body.String())
	}
}

func TestRevokeSession_CurrentSession(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revokeself", 4)

	// Find the current session ID.
	user, _ := database.GetUserByUsername("revokeself")
	sessions, _ := database.ListUserSessions(user.ID)
	if len(sessions) == 0 {
		t.Fatal("expected at least 1 session")
	}

	rr := profileDelete(t, router, fmt.Sprintf("/api/v1/users/me/sessions/%d", sessions[0].ID), token)

	// Revoking own session is allowed.
	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}
