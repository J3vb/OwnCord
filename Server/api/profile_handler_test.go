package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// buildProfileRouter returns a chi router with profile routes mounted.
func buildProfileRouter(database *db.DB) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	api.MountProfileRoutes(r, database, svc, nil, limiter, nil, nil)
	return r
}

// profileCreateToken creates a user and session, returning the raw token.
func profileCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, mustHash(t), roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	expiresAt := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05Z")
	_, err = database.ExecContext(context.Background(),
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

// OC-0100: a rename must canonicalize identically to how login looks the
// username up. A bare bluemonday sanitizer.Sanitize call HTML-escapes
// survivor punctuation instead of leaving it as typed, so a name with an
// apostrophe would be persisted as e.g. "O&#39;Brien" — unreachable by the
// literal name on the next login.
func TestUpdateProfile_UsernameWithApostropheIsNotEscaped(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "apostropheuser", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "O'Brien",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["username"] != "O'Brien" {
		t.Errorf("username = %v, want %q (must not be HTML-escaped)", resp["username"], "O'Brien")
	}

	// The row itself must be reachable by the literal name — that is exactly
	// what a future login looks up.
	u, err := database.GetUserByUsername(context.Background(), "O'Brien")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%q) = %v, %v — rename escaped the username and would lock the account out on next login", "O'Brien", u, err)
	}
}

// OC-0151: handleUpdateProfile is the same call in the same order as
// registerReadRequest — service.SanitizeText (the fixpoint sanitizer) runs
// on the raw username before auth.ValidateUsername's 32-rune cap. Since
// sanitizeToFixpoint's cost is quadratic in input length, an authenticated
// caller can still pin a core for hundreds of milliseconds (and much longer
// at larger sizes) with one PATCH before any bound is applied. The fix must
// reject an oversized username on a cheap byte-length check before
// sanitizing, so the rejection is near-instant regardless of payload size.
func TestUpdateProfile_OversizedUsernameRejectedBeforeSanitizing(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "patchvictim", 4)

	// Adversarial nested-entity payload (16 KB) — see service.sanitizeToFixpoint's
	// doc comment for why this shape is quadratic to sanitize.
	hugeUsername := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": hugeUsername,
	})
	elapsed := time.Since(start)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("UpdateProfile oversized username status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}

	// A guard that runs before sanitizing rejects in well under a
	// millisecond; the pre-fix code spends ~200ms in sanitizeToFixpoint on
	// this payload before it ever reaches auth.ValidateUsername's length
	// check. 150ms gives generous margin over noise while still being far
	// below the unguarded cost.
	if elapsed > 150*time.Millisecond {
		t.Errorf("UpdateProfile oversized username took %v, want well under 150ms (raw field must be bounded before sanitizing, not after)", elapsed)
	}
}

// OC-0192: same story as OC-0151 above, but for the avatar field — the
// service.SanitizeText call in the avatar branch has no byte-length guard at
// all, unlike the username field just above it. validateAvatarURL's
// maxAvatarURLLen check never gets a chance to reject a huge payload cheaply,
// because the fixpoint sanitizer already spent its (quadratic) cost on it
// first. The fix must reject an oversized avatar on a cheap byte-length
// check before sanitizing, so the rejection is near-instant regardless of
// payload size.
func TestUpdateProfile_OversizedAvatarRejectedBeforeSanitizing(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "avatarvictim", 4)

	// Adversarial nested-entity payload (16 KB) — see service.sanitizeToFixpoint's
	// doc comment for why this shape is quadratic to sanitize.
	hugeAvatar := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "avatarvictim",
		"avatar":   hugeAvatar,
	})
	elapsed := time.Since(start)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("UpdateProfile oversized avatar status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}

	// See TestUpdateProfile_OversizedUsernameRejectedBeforeSanitizing for the
	// rationale behind this bound: a guard that runs before sanitizing
	// rejects in well under a millisecond, while the pre-fix code spends over
	// 150ms in sanitizeToFixpoint on this payload before validateAvatarURL's
	// length check ever runs.
	if elapsed > 150*time.Millisecond {
		t.Errorf("UpdateProfile oversized avatar took %v, want well under 150ms (raw field must be bounded before sanitizing, not after)", elapsed)
	}
}

// OC-0197: display_name is validated (validateDisplayName) against the raw
// JSON string, before the fixpoint sanitizer's outer html.UnescapeString
// ever runs (that happens later, inside UserService.UpdateProfile's
// cleanText call). So an entity-encoded control or bidi character like
// "&#x202e;" sails through validateDisplayName as harmless ASCII, and is only
// turned into the real U+202E RIGHT-TO-LEFT OVERRIDE character afterwards,
// on its way into storage. TestUpdateProfile_RejectsBadDisplayName
// (avatar_handler_test.go) shows the literal character is correctly
// rejected; this is the entity-encoded bypass of that same guard — the fix
// is to sanitize display_name before validating it, the same order the
// username field above already uses.
func TestUpdateProfile_RejectsEntityEncodedBidiOverrideInDisplayName(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "dnentity", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username":     "dnentity",
		"display_name": "ada&#x202e;gnp.exe",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("entity-encoded bidi override display_name status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}

	// Regardless of what the handler answered, the stored row must never end
	// up holding a real bidi override character smuggled in via the entity
	// encoding — that is the actual harm (it renders wherever the username
	// does, in every connected client, once broadcast).
	u, err := database.GetUserByUsername(context.Background(), "dnentity")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v, %v", u, err)
	}
	if u.DisplayName != nil && strings.ContainsRune(*u.DisplayName, '\u202e') {
		t.Errorf("stored display_name = %q, contains a real U+202E bidi override smuggled past validateDisplayName via HTML entity", *u.DisplayName)
	}
}

// OC-0180: the avatar branch must canonicalize with the same fixpoint
// sanitizer (service.SanitizeText) as the username path above it, not the
// bare bluemonday sanitizer.Sanitize — Sanitize's output is always
// HTML-escaped, so a legitimate avatar URL with more than one query
// parameter gets its "&" separators rewritten to "&amp;" and is persisted
// (and later served to every client) as a broken URL.
func TestUpdateProfile_AvatarQueryStringIsNotEscaped(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "avatarqsuser", 4)

	const avatarURL = "https://www.gravatar.com/avatar/abc?s=256&d=identicon"

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "avatarqsuser",
		"avatar":   avatarURL,
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["avatar"] != avatarURL {
		t.Errorf("avatar = %v, want %q (must not be HTML-escaped)", resp["avatar"], avatarURL)
	}

	u, err := database.GetUserByUsername(context.Background(), "avatarqsuser")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v, %v", u, err)
	}
	if u.Avatar == nil || *u.Avatar != avatarURL {
		t.Errorf("stored avatar = %v, want %q (must not be HTML-escaped)", u.Avatar, avatarURL)
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

// BUG-108: Password change must revoke other sessions.
func TestChangePassword_RevokesOtherSessions(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	// Create user with two sessions.
	token1 := profileCreateToken(t, database, "pw-revoke", 4)
	user, _ := database.GetUserByUsername(context.Background(), "pw-revoke")

	// Create a second session for the same user.
	token2, _ := auth.GenerateToken()
	expiresAt := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05Z")
	_, _ = database.ExecContext(context.Background(),
		"INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)",
		user.ID, auth.HashToken(token2), "OtherDevice", "10.0.0.1", expiresAt,
	)

	// Change password using token1.
	rr := putJSON(t, router, "/api/v1/users/me/password", token1, map[string]string{
		"old_password": "securePass1",
		"new_password": "newSecure2",
	})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	// token1 (current session) should still work.
	sess1, _ := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token1))
	if sess1 == nil {
		t.Error("current session should survive password change")
	}

	// token2 (other session) should be revoked.
	sess2, _ := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token2))
	if sess2 != nil {
		t.Error("other session should be revoked after password change")
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
	user, _ := database.GetUserByUsername(context.Background(), "revoke")
	secondSessID, _ := database.CreateSession(context.Background(), user.ID, auth.HashToken("second-tok"), "Firefox", "1.2.3.4")

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
	otherUID, _ := database.CreateUser(context.Background(), "victim", mustHash(t), 4)
	otherSessID, _ := database.CreateSession(context.Background(), otherUID, auth.HashToken("victim-tok"), "Safari", "9.8.7.6")

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
	user, _ := database.GetUserByUsername(context.Background(), "revokeself")
	sessions, _ := database.ListUserSessions(context.Background(), user.ID)
	if len(sessions) == 0 {
		t.Fatal("expected at least 1 session")
	}

	rr := profileDelete(t, router, fmt.Sprintf("/api/v1/users/me/sessions/%d", sessions[0].ID), token)

	// Revoking own session is allowed.
	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

// ─── DELETE /api/v1/users/me/sessions — sign-out-everywhere (B4-7) ─────────

// The two-account proof the B4 exit gate asks for: signing out everywhere
// revokes every session of the caller — the current one included — and
// none of another account's, with the two accounts' sessions interleaved in
// creation order.
func TestRevokeAllSessions_OnlyTheCallersAccount(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	ctx := context.Background()

	aliceTok := profileCreateToken(t, database, "alice-everywhere", 4)
	alice, _ := database.GetUserByUsername(ctx, "alice-everywhere")
	bobUID, _ := database.CreateUser(ctx, "bob-bystander", mustHash(t), 4)
	if _, err := database.CreateSession(ctx, bobUID, auth.HashToken("bob-1"), "Firefox", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateSession(ctx, alice.ID, auth.HashToken("alice-2"), "Phone", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateSession(ctx, bobUID, auth.HashToken("bob-2"), "Tablet", "10.0.0.3"); err != nil {
		t.Fatal(err)
	}

	rr := profileDelete(t, router, "/api/v1/users/me/sessions", aliceTok)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		SessionsRevoked int64 `json:"sessions_revoked"`
		CurrentRevoked  bool  `json:"current_session_revoked"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionsRevoked != 2 || !resp.CurrentRevoked {
		t.Fatalf("response = %+v, want 2 sessions revoked including the current one", resp)
	}

	aliceLeft, _ := database.ListUserSessions(ctx, alice.ID)
	if len(aliceLeft) != 0 {
		t.Fatalf("alice still has %d session(s)", len(aliceLeft))
	}
	bobLeft, _ := database.ListUserSessions(ctx, bobUID)
	if len(bobLeft) != 2 {
		t.Fatalf("bob has %d session(s), want 2 untouched", len(bobLeft))
	}

	// The caller's own token is dead from here on.
	if rr := getWithToken(t, router, "/api/v1/users/me/sessions", aliceTok); rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoked caller token answered %d, want 401", rr.Code)
	}
}

func TestRevokeAllSessions_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	if rr := profileDelete(t, router, "/api/v1/users/me/sessions", "badtoken"); rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

// ─── PATCH /api/v1/users/me — identity_public_key (F3 voice E2EE TOFU) ───────

func TestUpdateProfile_PublishIdentityKey(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "idkeyuser", 4)

	key := "BPZ8bfkPz8B64iDeNtItYkEy0123456789abcdef+/=="
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username":            "idkeyuser",
		"identity_public_key": key,
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	u, err := database.GetUserByUsername(context.Background(), "idkeyuser")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.IdentityPublicKey == nil || *u.IdentityPublicKey != key {
		t.Errorf("IdentityPublicKey = %v, want %q", u.IdentityPublicKey, key)
	}
}

func TestUpdateProfile_IdentityKeyOmitted_Unchanged(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "idkeykeep", 4)

	key := "a2VlcHRoaXNrZXk="
	u, err := database.GetUserByUsername(context.Background(), "idkeykeep")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if err := database.UpdateUserIdentityKey(context.Background(), u.ID, &key); err != nil {
		t.Fatalf("UpdateUserIdentityKey: %v", err)
	}

	// PATCH without identity_public_key must not clear the stored key.
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "idkeykeep",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	after, err := database.GetUserByID(context.Background(), u.ID)
	if err != nil || after == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if after.IdentityPublicKey == nil || *after.IdentityPublicKey != key {
		t.Errorf("IdentityPublicKey = %v, want %q (unchanged)", after.IdentityPublicKey, key)
	}
}

func TestUpdateProfile_IdentityKeyInvalid(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	cases := []struct {
		name string
		key  string
	}{
		{"not base64", "!!!not-base64!!!"},
		{"url-safe alphabet", "abc-_def"},
		{"too large", strings.Repeat("A", 132)},
		{"empty", ""},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token := profileCreateToken(t, database, fmt.Sprintf("idkeybad%d", i), 4)
			rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
				"username":            fmt.Sprintf("idkeybad%d", i),
				"identity_public_key": tc.key,
			})
			if rr.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
			}
		})
	}
}

// ─── GET /api/v1/users/me/sessions with an API-token principal ────────────────

func TestListSessions_APITokenPrincipal(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	// One login session exists, but the caller authenticates with an API
	// token (nil SessionKey). The sibling DELETE works for this principal;
	// the list must too, with no session marked current.
	_ = profileCreateToken(t, database, "apisessions", 4)
	user, _ := database.GetUserByUsername(context.Background(), "apisessions")
	if user == nil {
		t.Fatal("user not found")
	}
	apiTok, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateAPIToken(context.Background(), user.ID, auth.HashToken(apiTok), "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+apiTok)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("sessions list via API token: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Sessions []struct {
			ID        int64 `json:"id"`
			IsCurrent bool  `json:"is_current"`
		} `json:"sessions"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp.Sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(resp.Sessions))
	}
	if resp.Sessions[0].IsCurrent {
		t.Error("API-token principal must not mark any session as current")
	}
}

// ─── Rate-limit bucket isolation ─────────────────────────────────────────────

func TestRateLimit_ProfileUpdatesDoNotConsumePasswordBudget(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "bucketuser", 4)

	// Five profile PATCHes (limit 10/min). If the password endpoint shared
	// the same bare-IP bucket, its 5/min budget would now read as exhausted
	// with zero password attempts made.
	for i := range 5 {
		rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
			"username": "bucketuser",
		})
		if rr.Code == http.StatusTooManyRequests {
			t.Fatalf("profile PATCH %d unexpectedly rate limited", i)
		}
	}

	raw, _ := json.Marshal(map[string]string{
		"old_password": "wrong-on-purpose",
		"new_password": "NewSecurePass1!",
	})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/password", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code == http.StatusTooManyRequests {
		t.Fatal("password change 429'd with zero password attempts made — unrelated endpoints share one rate-limit bucket")
	}
}
