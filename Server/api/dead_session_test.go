package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// BPR-042's second clause: revoked, expired and partial sessions fail
// uniformly. This file mints a real principal behind the production router
// and presents every dead-credential class to two gates — the API's
// AuthMiddleware and the admin panel's RequireAdminAuth — asserting the
// identical 401 UNAUTHORIZED, so a client cannot tell from the refusal which
// kind of dead token it holds, and no gate leaks more than another. A banned
// account is the one documented exception (403, "suspended") and is pinned
// as such.

type bearerResult struct {
	Status int
	Error  string
}

func bearerGet(t *testing.T, h http.Handler, path, token string) bearerResult {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return bearerResult{Status: rec.Code, Error: body.Error}
}

// gates are the two authenticated surfaces a dead credential is presented to.
var gates = []string{"/api/v1/auth/me", "/admin/api/me"}

func mintUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	hash, err := auth.HashPassword("correctPass1")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	id, err := database.CreateUser(context.Background(), username, hash, int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return id
}

func mintSession(t *testing.T, database *db.DB, userID int64) (token string, sessionID int64) {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	sessionID, err = database.CreateSession(context.Background(), userID, auth.HashToken(token), "b4-2", "127.0.0.1")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	return token, sessionID
}

func TestAuthPosture_DeadCredentialsFailUniformly(t *testing.T) {
	handler, database := fullRouterWithDB(t)
	ctx := context.Background()
	userID := mintUser(t, database, "posture-user")

	// Control: a live session is accepted by the API gate (the admin gate
	// additionally requires an admin-class role, so it is not the control).
	live, _ := mintSession(t, database, userID)
	if res := bearerGet(t, handler, "/api/v1/auth/me", live); res.Status != http.StatusOK {
		t.Fatalf("control: live session answered %d %s, want 200", res.Status, res.Error)
	}

	// Revoked: the session row is gone.
	revoked, _ := mintSession(t, database, userID)
	if err := database.DeleteSession(ctx, auth.HashToken(revoked)); err != nil {
		t.Fatalf("revoke session: %v", err)
	}

	// Expired: the row exists with an expiry in the past.
	expired, expiredID := mintSession(t, database, userID)
	if _, err := database.ExecContext(ctx, `UPDATE sessions SET expires_at = ? WHERE id = ?`, "2000-01-01T00:00:00Z", expiredID); err != nil {
		t.Fatalf("expire session: %v", err)
	}

	// Unknown: a well-formed token no store has ever seen.
	unknown, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	// Partial: the token login hands out when the account has a second
	// factor enrolled. It lives in the partial-auth store, never in sessions,
	// and must buy nothing but POST /auth/verify-totp.
	partial := mintPartialToken(t, handler, database)

	// Revoked API token: the other bearer kind ResolveBearer accepts.
	apiToken, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("generate api token: %v", err)
	}
	tokenID, err := database.CreateAPIToken(ctx, userID, auth.HashToken(apiToken), "b4-2", nil)
	if err != nil {
		t.Fatalf("create api token: %v", err)
	}
	if res := bearerGet(t, handler, "/api/v1/auth/me", apiToken); res.Status != http.StatusOK {
		t.Fatalf("control: live api token answered %d %s, want 200", res.Status, res.Error)
	}
	if _, err := database.RevokeAPIToken(ctx, tokenID); err != nil {
		t.Fatalf("revoke api token: %v", err)
	}

	dead := map[string]string{
		"missing":           "",
		"revoked session":   revoked,
		"expired session":   expired,
		"unknown token":     unknown,
		"partial-auth":      partial,
		"revoked api token": apiToken,
	}
	want := bearerResult{Status: http.StatusUnauthorized, Error: "UNAUTHORIZED"}
	for name, token := range dead {
		for _, gate := range gates {
			if res := bearerGet(t, handler, gate, token); res != want {
				t.Errorf("%s at %s: got %d %q, want %d %q", name, gate, res.Status, res.Error, want.Status, want.Error)
			}
		}
	}

	// Banned: the documented exception — a valid credential for a suspended
	// account is refused with 403, distinct from the dead-credential 401.
	bannedUser := mintUser(t, database, "posture-banned")
	bannedTok, _ := mintSession(t, database, bannedUser)
	if err := database.BanUser(ctx, bannedUser, "b4-2", nil); err != nil {
		t.Fatalf("ban user: %v", err)
	}
	if res := bearerGet(t, handler, "/api/v1/auth/me", bannedTok); res != (bearerResult{Status: http.StatusForbidden, Error: "FORBIDDEN"}) {
		t.Errorf("banned account: got %d %q, want 403 FORBIDDEN", res.Status, res.Error)
	}
}

// mintPartialToken enrols a second factor on a fresh account and logs in,
// returning the partial-auth token the challenge response carries. The login
// path decides "second factor enrolled" on totp_secret being non-NULL and
// only decrypts it at verify time, so the value here never has to be a real
// ciphertext (TestLogin_RequiresTOTPChallenge uses the same shape).
func mintPartialToken(t *testing.T, handler http.Handler, database *db.DB) string {
	t.Helper()
	userID := mintUser(t, database, "posture-totp")
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = ?`, "JBSWY3DPEHPK3PXP", userID); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"username": "posture-totp", "password": "correctPass1"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login with 2FA enrolled: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Requires2FA  bool   `json:"requires_2fa"`
		PartialToken string `json:"partial_token"`
		Token        string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if !resp.Requires2FA || resp.PartialToken == "" || resp.Token != "" {
		t.Fatalf("login did not issue a partial-auth challenge: %s", rec.Body.String())
	}
	return resp.PartialToken
}
