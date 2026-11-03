package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

const loginSessionTestPassword = "Password1!"

// bearerJSON sends method path with token as the bearer and body (nil = none)
// as JSON.
func bearerJSON(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// TestAccountSecurityRoutes_RequireLoginSession: every account-security
// route refuses an API token with 403 LOGIN_SESSION_REQUIRED and changes
// nothing, while the same account's API token keeps working on the routes
// that do not need a login session.
func TestAccountSecurityRoutes_RequireLoginSession(t *testing.T) {
	router, database := fullRouterWithDB(t)
	ctx := context.Background()

	hash, err := auth.HashPassword(loginSessionTestPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, "token-holder", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sessionTok := issueSessionToken(t, database, uid)
	apiTok := issueAPIToken(t, database, uid)
	sess, err := database.GetSessionByTokenHash(ctx, auth.HashToken(sessionTok))
	if err != nil || sess == nil {
		t.Fatalf("GetSessionByTokenHash: %v", err)
	}
	deviceKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 65))

	refused := []struct {
		method, path string
		body         any
	}{
		{http.MethodPut, "/api/v1/users/me/password", map[string]string{"old_password": loginSessionTestPassword, "new_password": "Another-Pass2!"}},
		{http.MethodPost, "/api/v1/users/me/totp/enable", map[string]string{"password": loginSessionTestPassword}},
		{http.MethodPost, "/api/v1/users/me/totp/confirm", map[string]string{"password": loginSessionTestPassword, "code": "123456"}},
		{http.MethodDelete, "/api/v1/users/me/totp", map[string]string{"password": loginSessionTestPassword}},
		{http.MethodPost, "/api/v1/users/me/totp/recovery-codes", map[string]string{"password": loginSessionTestPassword}},
		{http.MethodPost, "/api/v1/users/me/recovery-kit", map[string]string{"password": loginSessionTestPassword}},
		{http.MethodDelete, "/api/v1/auth/account", map[string]string{"password": loginSessionTestPassword}},
		{http.MethodGet, "/api/v1/users/me/sessions", nil},
		{http.MethodDelete, "/api/v1/users/me/sessions", nil},
		{http.MethodDelete, fmt.Sprintf("/api/v1/users/me/sessions/%d", sess.ID), nil},
		{http.MethodPatch, "/api/v1/users/me", map[string]string{"username": "token-holder", "identity_public_key": deviceKey}},
		// A device key is refused even beside an ordinary profile field, and
		// the field is not applied either.
		{http.MethodPatch, "/api/v1/users/me", map[string]string{"username": "token-holder", "display_name": "Half Applied", "identity_public_key": deviceKey}},
	}
	for _, tc := range refused {
		t.Run("refused "+tc.method+" "+tc.path, func(t *testing.T) {
			rr := bearerJSON(t, router, tc.method, tc.path, apiTok, tc.body)
			wantErr(t, rr, http.StatusForbidden, "LOGIN_SESSION_REQUIRED", "this action requires a login session")
		})
	}

	// Nothing the refused calls aimed at changed.
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("account gone after refused calls: %v", err)
	}
	if user.PasswordHash != hash {
		t.Error("password changed through an API token")
	}
	if user.TOTPSecret != nil && *user.TOTPSecret != "" {
		t.Error("two-factor state changed through an API token")
	}
	if user.IdentityPublicKey != nil {
		t.Error("device key published through an API token")
	}
	if user.DisplayName != nil && *user.DisplayName == "Half Applied" {
		t.Error("a refused profile update applied its other fields")
	}
	if kit, _ := database.GetRecoveryKit(ctx, uid); kit != nil {
		t.Error("recovery kit enrolled through an API token")
	}
	if s, _ := database.GetSessionByTokenHash(ctx, auth.HashToken(sessionTok)); s == nil {
		t.Error("login session revoked through an API token")
	}

	// The API token still works where a login session is not required.
	allowed := []struct {
		method, path string
		body         any
		want         int
	}{
		{http.MethodGet, "/api/v1/auth/me", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/users/me/recovery-kit", nil, http.StatusOK},
		{http.MethodPatch, "/api/v1/users/me", map[string]string{"username": "token-holder", "display_name": "Bot Owner"}, http.StatusOK},
	}
	for _, tc := range allowed {
		if rr := bearerJSON(t, router, tc.method, tc.path, apiTok, tc.body); rr.Code != tc.want {
			t.Errorf("%s %s via API token: status = %d, want %d; body = %s", tc.method, tc.path, rr.Code, tc.want, rr.Body.String())
		}
	}

	// The login session reaches the same routes.
	if rr := bearerJSON(t, router, http.MethodGet, "/api/v1/users/me/sessions", sessionTok, nil); rr.Code != http.StatusOK {
		t.Errorf("sessions list via login session: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if rr := bearerJSON(t, router, http.MethodPatch, "/api/v1/users/me", sessionTok, map[string]string{"username": "token-holder", "identity_public_key": deviceKey}); rr.Code != http.StatusOK {
		t.Errorf("device key via login session: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if after, _ := database.GetUserByID(ctx, uid); after == nil || after.IdentityPublicKey == nil || *after.IdentityPublicKey != deviceKey {
		t.Error("device key not stored through the login session")
	}
}
