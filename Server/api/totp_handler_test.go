package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

// ─── POST /api/v1/auth/verify-totp ──────────────────────────────────────────

func TestVerifyTOTP_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Create user with TOTP enabled.
	secret, _ := auth.GenerateTOTPSecret()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser("totpuser", hash, 4)
	_ = database.UpdateUserTOTPSecret(uid, &secret)

	// Login should return requires_2fa + partial_token.
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "totpuser",
		"password": "Password1!",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var loginResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&loginResp)
	if loginResp["requires_2fa"] != true {
		t.Fatal("expected requires_2fa=true in login response")
	}
	partialToken, ok := loginResp["partial_token"].(string)
	if !ok || partialToken == "" {
		t.Fatal("expected non-empty partial_token")
	}

	// Generate valid TOTP code and verify.
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}

	rr = postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partialToken,
		map[string]string{"code": code})
	if rr.Code != http.StatusOK {
		t.Errorf("verify-totp status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var verifyResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&verifyResp)
	if verifyResp["token"] == nil {
		t.Error("verify-totp response missing session token")
	}
}

func TestVerifyTOTP_InvalidCode(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	secret, _ := auth.GenerateTOTPSecret()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser("totpuser2", hash, 4)
	_ = database.UpdateUserTOTPSecret(uid, &secret)

	// Login to get partial token.
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "totpuser2",
		"password": "Password1!",
	})
	var loginResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&loginResp)
	partialToken := loginResp["partial_token"].(string)

	// Submit wrong code.
	rr = postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partialToken,
		map[string]string{"code": "000000"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("verify-totp with bad code: status = %d, want 401", rr.Code)
	}
}

func TestVerifyTOTP_MissingToken(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/auth/verify-totp",
		map[string]string{"code": "123456"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("verify-totp without token: status = %d, want 401", rr.Code)
	}
}

func TestVerifyTOTP_InvalidPartialToken(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", "bogus-token",
		map[string]string{"code": "123456"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("verify-totp with bogus token: status = %d, want 401", rr.Code)
	}
}

func TestVerifyTOTP_MalformedBody(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Need a valid partial token to get past the token check.
	secret, _ := auth.GenerateTOTPSecret()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser("totpuser3", hash, 4)
	_ = database.UpdateUserTOTPSecret(uid, &secret)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "totpuser3",
		"password": "Password1!",
	})
	var loginResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&loginResp)
	partialToken := loginResp["partial_token"].(string)

	// Send invalid JSON.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-totp",
		bytes.NewReader([]byte("{invalid")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+partialToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("verify-totp with malformed body: status = %d, want 400", rec.Code)
	}
}

func TestVerifyTOTP_ReplayProtection(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	secret, _ := auth.GenerateTOTPSecret()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser("totpuser4", hash, 4)
	_ = database.UpdateUserTOTPSecret(uid, &secret)

	code, _ := auth.GenerateTOTPCode(secret, time.Now().UTC())

	// First login + verify — should succeed.
	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "totpuser4",
		"password": "Password1!",
	})
	var resp1 map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&resp1)
	token1 := resp1["partial_token"].(string)

	rr = postJSONWithToken(t, router, "/api/v1/auth/verify-totp", token1,
		map[string]string{"code": code})
	if rr.Code != http.StatusOK {
		t.Fatalf("first verify: status = %d, want 200", rr.Code)
	}

	// Second login + verify with same code — should fail (consumed token).
	rr = postJSON(t, router, "/api/v1/auth/login", map[string]string{
		"username": "totpuser4",
		"password": "Password1!",
	})
	var resp2 map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&resp2)
	token2 := resp2["partial_token"].(string)

	rr = postJSONWithToken(t, router, "/api/v1/auth/verify-totp", token2,
		map[string]string{"code": code})
	// Code was already used in UsedTOTPCodeStore, so it should be rejected.
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("replay code: status = %d, want 401", rr.Code)
	}
}

// ─── POST /api/v1/users/me/totp/enable ──────────────────────────────────────

func TestEnableTOTP_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "enableuser", 4)

	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusOK {
		t.Errorf("enable-totp status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["qr_uri"] == nil || resp["qr_uri"] == "" {
		t.Error("enable-totp response missing qr_uri")
	}
}

func TestEnableTOTP_WrongPassword(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "enableuser2", 4)

	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "wrongpassword"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("enable-totp with wrong password: status = %d, want 400", rr.Code)
	}
}

func TestEnableTOTP_Unauthenticated(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", "badtoken",
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("enable-totp unauthenticated: status = %d, want 401", rr.Code)
	}
}

// ─── POST /api/v1/users/me/totp/confirm ─────────────────────────────────────

func TestConfirmTOTP_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "confirmuser", 4)

	// Step 1: Enable to get pending secret.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusOK {
		t.Fatalf("enable: status = %d; body = %s", rr.Code, rr.Body.String())
	}

	var enableResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&enableResp)
	qrURI, _ := enableResp["qr_uri"].(string)

	// Extract secret from QR URI (otpauth://totp/...?secret=XXX&...)
	secret := extractSecretFromURI(t, qrURI)

	// Step 2: Generate valid code and confirm.
	code, _ := auth.GenerateTOTPCode(secret, time.Now().UTC())
	rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "Password1!", "code": code})
	if rr.Code != http.StatusNoContent {
		t.Errorf("confirm-totp: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	// Verify TOTP is now stored on user.
	user, _ := database.GetUserByUsername("confirmuser")
	if user == nil {
		t.Fatal("user not found after confirm")
	}
	if user.TOTPSecret == nil {
		t.Error("expected TOTPSecret to be set after confirm")
	}
}

func TestConfirmTOTP_InvalidCode_Handler(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "confirmuser2", 4)

	// Enable first.
	postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})

	// Confirm with wrong code.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "Password1!", "code": "000000"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("confirm-totp with bad code: status = %d, want 401", rr.Code)
	}
}

func TestConfirmTOTP_NoPendingEnrollment(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "confirmuser3", 4)

	// Try to confirm without enable first.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "Password1!", "code": "123456"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("confirm-totp without enable: status = %d, want 400", rr.Code)
	}
}

func TestConfirmTOTP_WrongPassword_Handler(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "confirmuser4", 4)

	postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})

	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "wrong", "code": "123456"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("confirm-totp wrong password: status = %d, want 400", rr.Code)
	}
}

// ─── DELETE /api/v1/users/me/totp ────────────────────────────────────────────

func TestDisableTOTP_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "disableuser", 4)

	// Enable and confirm TOTP first.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})
	var enableResp map[string]interface{}
	_ = json.NewDecoder(rr.Body).Decode(&enableResp)
	secret := extractSecretFromURI(t, enableResp["qr_uri"].(string))
	code, _ := auth.GenerateTOTPCode(secret, time.Now().UTC())
	postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "Password1!", "code": code})

	// Now disable.
	rr = deleteWithToken(t, router, "/api/v1/users/me/totp", token,
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusNoContent {
		t.Errorf("disable-totp: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestDisableTOTP_WrongPassword_Handler(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "disableuser2", 4)

	rr := deleteWithToken(t, router, "/api/v1/users/me/totp", token,
		map[string]string{"password": "wrong"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("disable-totp wrong password: status = %d, want 400", rr.Code)
	}
}

func TestDisableTOTP_Unauthenticated(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	rr := deleteWithToken(t, router, "/api/v1/users/me/totp", "badtoken",
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("disable-totp unauthenticated: status = %d, want 401", rr.Code)
	}
}

func TestDisableTOTP_BlockedByServerPolicy(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "disableuser3", 4)

	// Enable require_2fa server policy.
	_, _ = database.Exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('require_2fa', '1')`)

	rr := deleteWithToken(t, router, "/api/v1/users/me/totp", token,
		map[string]string{"password": "Password1!"})
	if rr.Code != http.StatusForbidden {
		t.Errorf("disable-totp with require_2fa: status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// deleteWithToken sends a DELETE request with a JSON body and auth token.
func deleteWithToken(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodDelete, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// extractSecretFromURI parses a TOTP otpauth:// URI and returns the secret parameter.
func extractSecretFromURI(t *testing.T, uri string) string {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("parse otpauth URI: %v", err)
	}
	s := u.Query().Get("secret")
	if s == "" {
		t.Fatalf("no secret param in URI: %s", uri)
	}
	return s
}
