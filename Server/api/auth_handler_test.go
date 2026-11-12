package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// newAuthTestDB builds an in-memory DB with the full schema needed for auth tests.
func newAuthTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, apiTestSchema)
}

// buildAuthRouter returns a chi router with auth routes mounted on /api/v1/auth.
func buildAuthRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	return buildAuthRouterWithProxies(database, limiter, nil)
}

func buildAuthRouterWithProxies(database *db.DB, limiter *auth.RateLimiter, trustedProxies []string) http.Handler {
	r := chi.NewRouter()
	api.MountAuthRoutes(r, service.NewAuthService(database, limiter, testTOTPKey, nil), api.AuthMiddleware(service.NewSessionService(database)), limiter, trustedProxies)
	return r
}

// testTOTPKey is a fixed 32-byte AES-256 key used in tests.
var testTOTPKey = make([]byte, 32)

// postJSON is a test helper that POSTs JSON to the given router.
func postJSON(t *testing.T, router http.Handler, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doAPIJSON(t, router, http.MethodPost, path, "", body)
}

// postJSONWithToken posts with an Authorization header.
func postJSONWithToken(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doAPIJSON(t, router, http.MethodPost, path, token, body)
}

func postJSONFromIP(t *testing.T, router http.Handler, path string, body any, ip string) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = ip + ":9999"
	rr := serveRequest(router, req)
	return rr
}

// postLoginFromIP posts a login attempt that appears to come from ip.
func postLoginFromIP(t *testing.T, router http.Handler, username, password, ip string) *httptest.ResponseRecorder {
	t.Helper()
	return postJSONFromIP(t, router, "/api/v1/auth/login", map[string]string{"username": username, "password": password}, ip)
}

// failLoginsFromFreshIPs sends n wrong-password logins for username, each from
// its own address under ipPrefix, so only the per-username lockout can bind.
func failLoginsFromFreshIPs(t *testing.T, router http.Handler, username string, n int, ipPrefix string) {
	t.Helper()
	for i := range n {
		rr := postLoginFromIP(t, router, username, "wrongpassword", fmt.Sprintf("%s%d", ipPrefix, i+1))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("setup attempt %d status = %d, want 401; body = %s", i+1, rr.Code, rr.Body.String())
		}
	}
}

// loginAwaitingTOTP creates a user with the given TOTP secret enrolled, logs
// in with the password, and returns the partial token of the 2FA challenge.
func loginAwaitingTOTP(t *testing.T, database *db.DB, router http.Handler, username, secret string) string {
	t.Helper()
	userID := seedUser(t, database, username, "correctPass1", 4)
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = ?`, sealedTOTP(t, secret), userID); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}

	login := postLogin(t, router, username, "correctPass1")
	requireStatus(t, login, http.StatusOK)

	partialToken, _ := decodeBody[map[string]any](t, login)["partial_token"].(string)
	if partialToken == "" {
		t.Fatal("expected partial_token from login")
	}
	return partialToken
}

// getWithToken performs a GET with an Authorization header.
func getWithToken(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doAPI(t, router, http.MethodGet, path, token, nil)
}

// ─── Register tests ───────────────────────────────────────────────────────────

func TestRegister_Success(t *testing.T) {
	database, _, router := newAuthEnv(t)

	// Create an invite first.
	ownerID := mustCreateUser(t, database, "owner", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "securePass1",
		"invite_code": code,
	})

	expectStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
	if resp["token"] == nil {
		t.Error("Register response missing token")
	}
	if resp["user"] == nil {
		t.Error("Register response missing user")
	}
}

func TestRegister_RegistrationClosed(t *testing.T) {
	database, _, router := newAuthEnv(t)

	if _, err := database.ExecContext(context.Background(), `INSERT OR REPLACE INTO settings (key, value) VALUES ('registration_mode', 'closed')`); err != nil {
		t.Fatalf("close registration: %v", err)
	}

	ownerID := mustCreateUser(t, database, "owner", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "closeduser",
		"password":    "securePass1",
		"invite_code": code,
	})

	requireStatus(t, rr, http.StatusForbidden)
}

func TestRegister_InvalidInvite(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "securePass1",
		"invite_code": "bogus",
	})

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestRegister_WeakPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	ownerID := mustCreateUser(t, database, "owner2", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "newuser",
		"password":    "short",
		"invite_code": code,
	})

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestRegister_InviteUsedUp(t *testing.T) {
	database, _, router := newAuthEnv(t)

	ownerID := mustCreateUser(t, database, "owner3", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil) // max 1 use

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

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestRegister_DuplicateUsername_DoesNotConsumeInvite(t *testing.T) {
	database, _, router := newAuthEnv(t)

	ownerID := mustCreateUser(t, database, "owner4", "hash", 1)
	_, _ = database.CreateUser(context.Background(), "takenuser", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	duplicate := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "takenuser",
		"password":    "securePass1",
		"invite_code": code,
	})
	requireStatus(t, duplicate, http.StatusBadRequest)

	success := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "freshuser",
		"password":    "securePass2",
		"invite_code": code,
	})
	requireStatus(t, success, http.StatusCreated)
}

func TestRegister_MissingFields(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{})
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestRegister_ErrorNeverRevealUsername(t *testing.T) {
	_, _, router := newAuthEnv(t)

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
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "loginuser", "correctPass1", 4)

	rr := postLogin(t, router, "loginuser", "correctPass1")

	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	if resp["token"] == nil {
		t.Error("Login response missing token")
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "loginuser2", "correctPass1", 4)

	rr := postLogin(t, router, "loginuser2", "wrongpassword")

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestLogin_UnknownUser(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postLogin(t, router, "nobody", "anypass123")

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestLogin_LockoutUsesTrustedForwardedIP(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouterWithProxies(database, limiter, []string{"127.0.0.0/8"})

	for range 10 {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader([]byte(`{"username":"nobody","password":"wrongpass123"}`)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", "198.51.100.10")
		_ = serveLocal(router, req)
	}

	// Use a different username AND IP to verify per-IP lockout isolation.
	// (Same username would be locked by per-username lockout — BUG-110 fix.)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader([]byte(`{"username":"other","password":"wrongpass123"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "198.51.100.11")
	rr := serveLocal(router, req)
	requireStatus(t, rr, http.StatusUnauthorized)
}

func TestLogin_UsernameLockoutAcrossDifferentIPs(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "lockoutuser", "correctPass1", 4)

	for i := range 10 {
		rr := postLoginFromIP(t, router, "lockoutuser", "wrongpassword", fmt.Sprintf("198.51.100.%d", i+1))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401; body = %s", i+1, rr.Code, rr.Body.String())
		}
	}

	rr := postLoginFromIP(t, router, "lockoutuser", "wrongpassword", "198.51.100.250")
	requireStatus(t, rr, http.StatusTooManyRequests)
}

func TestLogin_UsernameLockoutBlocksCorrectPasswordFromFreshIP(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "lockoutcorrect", "correctPass1", 4)

	failLoginsFromFreshIPs(t, router, "lockoutcorrect", 10, "203.0.113.")

	rr := postLoginFromIP(t, router, "lockoutcorrect", "correctPass1", "203.0.113.250")
	requireStatus(t, rr, http.StatusTooManyRequests)
}

// TestLogin_UsernameLockoutIgnoresCasing locks F1: the per-username lockout key
// must be case-folded so it matches the DB's COLLATE NOCASE username lookup.
// Otherwise an attacker splits the 9-attempt lockout budget across case variants
// of one account (admin, Admin, ADMIN, …), all of which authenticate the same row.
func TestLogin_UsernameLockoutIgnoresCasing(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "casehunt", "correctPass1", 4)

	// Trip the per-username lockout using the lowercase spelling, from many IPs
	// so the per-IP limiter is never the binding cap.
	failLoginsFromFreshIPs(t, router, "casehunt", 10, "198.51.100.")

	// A different casing of the SAME account must land in the same lockout bucket.
	rr := postLoginFromIP(t, router, "CASEHUNT", "wrongpassword", "198.51.100.250")
	requireStatus(t, rr, http.StatusTooManyRequests)
}

// TestLogin_ConcurrentBurstCannotExceedUsernameBudget locks F3: the
// per-username failure cap (the only cross-IP brute-force defence) must bind
// concurrent attackers, not just sequential ones. Before the fix the lockout
// was a read-only check followed by a post-bcrypt record, so N concurrent
// requests all passed the stale check and landed N guesses; a distributed
// burst must now land at most the same 10-attempt budget a sequential
// attacker gets.
func TestLogin_ConcurrentBurstCannotExceedUsernameBudget(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "bursttarget", "correctPass1", 4)

	const burst = 40
	start := make(chan struct{})
	codes := make([]int, burst)
	var wg sync.WaitGroup
	for i := range burst {
		wg.Go(func() {
			raw, _ := json.Marshal(map[string]string{
				"username": "bursttarget",
				"password": "wrongpassword",
			})
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			// Unique IP per request so only the per-username limiter binds.
			req.RemoteAddr = fmt.Sprintf("203.0.113.%d:9999", i+1)
			rr := httptest.NewRecorder()
			<-start
			router.ServeHTTP(rr, req)
			codes[i] = rr.Code
		})
	}
	close(start)
	wg.Wait()

	landed, limited := 0, 0
	for i, code := range codes {
		switch code {
		case http.StatusUnauthorized:
			landed++
		case http.StatusTooManyRequests:
			limited++
		default:
			t.Fatalf("request %d: unexpected status %d", i, code)
		}
	}
	// Sequential budget is 10 landed guesses (9 recorded + the one that trips
	// the lockout); a concurrent burst must not exceed it.
	if landed > 10 {
		t.Fatalf("concurrent burst landed %d password guesses (%d rate-limited), want at most 10", landed, limited)
	}
}

// TestLogin_NineFailuresThenCorrectPasswordSucceeds pins the sequential
// accepted-input boundary that the F3 fix must not move: after 9 wrong
// guesses the account owner's correct password still logs in (attempt 10 is
// inside the budget). A fix that reserves attempts pre-compare at the
// original threshold would return 429 here and hand attackers a 9-request
// victim lockout.
func TestLogin_NineFailuresThenCorrectPasswordSucceeds(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "boundaryuser", "correctPass1", 4)

	failLoginsFromFreshIPs(t, router, "boundaryuser", 9, "198.51.100.")

	rr := postLoginFromIP(t, router, "boundaryuser", "correctPass1", "198.51.100.250")
	requireStatus(t, rr, http.StatusOK)
}

func TestLogin_SuccessResetsUsernameFailureCounter(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "resetuser", "correctPass1", 4)

	failLoginsFromFreshIPs(t, router, "resetuser", 8, "192.0.2.")

	rr := postLoginFromIP(t, router, "resetuser", "correctPass1", "192.0.2.200")
	requireStatus(t, rr, http.StatusOK)

	for i := range 3 {
		rr = postLoginFromIP(t, router, "resetuser", "wrongpassword", fmt.Sprintf("192.0.2.%d", 201+i))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("post-reset attempt %d status = %d, want 401; body = %s", i+1, rr.Code, rr.Body.String())
		}
	}
}

func TestLogin_GenericErrorOnBadCredentials(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postLogin(t, router, "nobody", "anypass123")

	body := rr.Body.String()
	// The response must never reveal whether the user exists
	if contains(body, "user not found") || contains(body, "does not exist") {
		t.Errorf("Login error reveals user existence: %s", body)
	}
}

func TestLogin_RequiresTOTPChallenge(t *testing.T) {
	database, _, router := newAuthEnv(t)

	userID := seedUser(t, database, "totpuser", "correctPass1", 4)
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = ?`, "JBSWY3DPEHPK3PXP", userID); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}

	rr := postLogin(t, router, "totpuser", "correctPass1")

	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	if resp["requires_2fa"] != true {
		t.Fatalf("requires_2fa = %v, want true", resp["requires_2fa"])
	}
	if resp["partial_token"] == nil || resp["partial_token"] == "" {
		t.Fatal("expected partial_token in TOTP challenge response")
	}
	if token := resp["token"]; token != nil && token != "" {
		t.Fatalf("expected no full session token before TOTP verification, got %v", token)
	}
}

func TestLogin_UsernameLockoutBlocksTOTPChallenge(t *testing.T) {
	database, _, router := newAuthEnv(t)

	userID := seedUser(t, database, "totplocked", "correctPass1", 4)
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = ?`, "JBSWY3DPEHPK3PXP", userID); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}

	failLoginsFromFreshIPs(t, router, "totplocked", 10, "198.18.0.")

	rr := postLoginFromIP(t, router, "totplocked", "correctPass1", "198.18.0.250")
	requireStatus(t, rr, http.StatusTooManyRequests)

	resp := decodeBody[map[string]any](t, rr)
	if resp["partial_token"] != nil {
		t.Fatalf("partial_token = %v, want nil when username is locked out", resp["partial_token"])
	}
}

func TestVerifyTotp_Success(t *testing.T) {
	database, _, router := newAuthEnv(t)

	secret := "JBSWY3DPEHPK3PXP"
	partialToken := loginAwaitingTOTP(t, database, router, "totpverify", secret)

	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	verify := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partialToken, map[string]string{"code": code})
	requireStatus(t, verify, http.StatusOK)

	verifyResp := decodeBody[map[string]any](t, verify)
	if verifyResp["token"] == nil || verifyResp["token"] == "" {
		t.Fatal("expected full session token after successful TOTP verification")
	}
	if verifyResp["requires_2fa"] != false {
		t.Fatalf("requires_2fa after verify = %v, want false", verifyResp["requires_2fa"])
	}
}

func TestEnableConfirmDisableTotp(t *testing.T) {
	database, _, router := newAuthEnv(t)

	userID := seedUser(t, database, "enrolltotp", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	enable := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token, map[string]string{"password": "correctPass1"})
	requireStatus(t, enable, http.StatusOK)

	enableResp := decodeBody[map[string]any](t, enable)
	qrURI, _ := enableResp["qr_uri"].(string)
	if qrURI == "" {
		t.Fatal("expected qr_uri from enable response")
	}

	userBeforeConfirm, err := database.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID before confirm: %v", err)
	}
	if userBeforeConfirm.TOTPSecret != nil {
		t.Fatal("TOTP secret should not be persisted before confirmation")
	}

	parsed, err := url.Parse(qrURI)
	if err != nil {
		t.Fatalf("parse qr uri: %v", err)
	}
	secret := parsed.Query().Get("secret")
	if secret == "" {
		t.Fatal("expected secret query param in qr_uri")
	}
	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}

	confirm := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token, map[string]string{"password": "correctPass1", "code": code})
	requireStatus(t, confirm, http.StatusNoContent)

	userAfterConfirm, err := database.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID after confirm: %v", err)
	}
	if userAfterConfirm.TOTPSecret == nil || *userAfterConfirm.TOTPSecret == "" {
		t.Fatal("TOTP secret should be persisted after confirmation")
	}

	deleteBody, err := json.Marshal(map[string]string{"password": "correctPass1"})
	if err != nil {
		t.Fatalf("marshal delete body: %v", err)
	}
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/totp", bytes.NewReader(deleteBody))
	deleteReq.Header.Set("Authorization", "Bearer "+token)
	deleteReq.Header.Set("Content-Type", "application/json")
	deleteReq.RemoteAddr = "127.0.0.1:9999"
	deleteRec := serveRequest(router, deleteReq)
	requireStatus(t, deleteRec, http.StatusNoContent)

	userAfterDelete, err := database.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID after delete: %v", err)
	}
	if userAfterDelete.TOTPSecret != nil {
		t.Fatal("TOTP secret should be cleared after disable")
	}
}

func TestTOTPManagement_RequiresPasswordConfirmation(t *testing.T) {
	database, _, router := newAuthEnv(t)

	userID := seedUser(t, database, "totppassword", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	enable := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token, map[string]string{"password": "wrongPass"})
	requireStatus(t, enable, http.StatusBadRequest)

	userAfterEnable, err := database.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID after failed enable: %v", err)
	}
	if userAfterEnable.TOTPSecret != nil {
		t.Fatal("TOTP secret should remain unset after failed password confirmation")
	}

	deleteBody, err := json.Marshal(map[string]string{"password": "wrongPass"})
	if err != nil {
		t.Fatalf("marshal delete body: %v", err)
	}
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/totp", bytes.NewReader(deleteBody))
	deleteReq.Header.Set("Authorization", "Bearer "+token)
	deleteReq.Header.Set("Content-Type", "application/json")
	deleteReq.RemoteAddr = "127.0.0.1:9999"
	deleteRec := serveRequest(router, deleteReq)
	requireStatus(t, deleteRec, http.StatusBadRequest)
}

func TestVerifyTotp_ConsumesChallengeAfterRepeatedFailures(t *testing.T) {
	database, _, router := newAuthEnv(t)

	secret := "JBSWY3DPEHPK3PXP"
	partialToken := loginAwaitingTOTP(t, database, router, "totplockout", secret)

	for i := range 5 {
		verify := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partialToken, map[string]string{"code": "000000"})
		if verify.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401; body = %s", i+1, verify.Code, verify.Body.String())
		}
	}

	code, err := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	verify := postJSONWithToken(t, router, "/api/v1/auth/verify-totp", partialToken, map[string]string{"code": code})
	requireStatus(t, verify, http.StatusUnauthorized)
}

func TestLogin_Require2FASettingRejectsUsersWithoutEnrollment(t *testing.T) {
	database, _, router := newAuthEnv(t)

	if _, err := database.ExecContext(context.Background(), `UPDATE settings SET value = 'true' WHERE key = 'require_2fa'`); err != nil {
		t.Fatalf("enable require_2fa: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `INSERT OR REPLACE INTO settings (key, value) VALUES ('registration_mode', 'closed')`); err != nil {
		t.Fatalf("close registration: %v", err)
	}

	_ = seedUser(t, database, "needsenrollment", "correctPass1", 4)

	rr := postLogin(t, router, "needsenrollment", "correctPass1")

	requireStatus(t, rr, http.StatusForbidden)
}

func TestLogin_BannedUser(t *testing.T) {
	database, _, router := newAuthEnv(t)

	id := seedUser(t, database, "banned", "correctPass1", 4)
	_ = database.BanUser(context.Background(), id, "violated rules", nil)

	rr := postLogin(t, router, "banned", "correctPass1")

	expectStatus(t, rr, http.StatusForbidden)
}

func TestLogin_MissingFields(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{})
	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── Logout tests ─────────────────────────────────────────────────────────────

func TestLogout_Success(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "logoutuser", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	tokenHash := auth.HashToken(token)
	_, _ = database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1")

	rr := postJSONWithToken(t, router, "/api/v1/auth/logout", token, nil)

	expectStatus(t, rr, http.StatusNoContent)

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash(context.Background(), tokenHash)
	if sess != nil {
		t.Error("Session still exists after logout")
	}
}

func TestLogout_NoAuth(t *testing.T) {
	_, _, router := newAuthEnv(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── Me tests ─────────────────────────────────────────────────────────────────

func TestMe_Success(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "meuser", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := getWithToken(t, router, "/api/v1/auth/me", token)

	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	if resp["id"] == nil {
		t.Error("Me response missing id")
	}
	if resp["username"] != "meuser" {
		t.Errorf("Me username = %v, want meuser", resp["username"])
	}
}

func TestMe_NoAuth(t *testing.T) {
	_, _, router := newAuthEnv(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── Fix 2.5: Password trim fix ───────────────────────────────────────────────

// TestLogin_PasswordWithLeadingSpaceIsPreserved verifies that a password with
// leading whitespace is NOT trimmed, so a user who set " securePass1" can log
// in with " securePass1" and NOT with "securePass1".
func TestLogin_PasswordWithLeadingSpaceIsPreserved(t *testing.T) {
	database, _, router := newAuthEnv(t)

	// Hash the password WITH the leading space — this is what was registered.
	hash, _ := auth.HashPassword(" securePass1")
	_, _ = database.CreateUser(context.Background(), "spacepassuser", hash, 4)

	// Login with the exact same password (including space) must succeed.
	rr := postLogin(t, router, "spacepassuser", " securePass1")

	expectStatus(t, rr, http.StatusOK)
}

// TestLogin_PasswordWithLeadingSpaceTrimmedFails verifies that logging in with
// the trimmed version of a space-prefixed password correctly fails.
func TestLogin_PasswordWithLeadingSpaceTrimmedFails(t *testing.T) {
	database, _, router := newAuthEnv(t)

	// Register with password that has a leading space.
	hash, _ := auth.HashPassword(" securePass1")
	_, _ = database.CreateUser(context.Background(), "spacepassuser2", hash, 4)

	// Login without the leading space must fail.
	rr := postLogin(t, router, "spacepassuser2", "securePass1")

	expectStatus(t, rr, http.StatusUnauthorized)
}

// TestLogin_PasswordWithTrailingSpaceIsPreserved verifies that a password with
// trailing whitespace is NOT trimmed.
func TestLogin_PasswordWithTrailingSpaceIsPreserved(t *testing.T) {
	database, _, router := newAuthEnv(t)

	hash, _ := auth.HashPassword("securePass1 ")
	_, _ = database.CreateUser(context.Background(), "trailingspaceuser", hash, 4)

	rr := postLogin(t, router, "trailingspaceuser", "securePass1 ")

	expectStatus(t, rr, http.StatusOK)
}

// TestLogin_UsernameIsStillTrimmed verifies that the username IS still trimmed
// (only the password trim was removed).
func TestLogin_UsernameIsStillTrimmed(t *testing.T) {
	database, _, router := newAuthEnv(t)

	_ = seedUser(t, database, "trimuser", "correctPass1", 4)

	// Username with surrounding spaces should resolve to "trimuser".
	rr := postLogin(t, router, "  trimuser  ", "correctPass1")

	expectStatus(t, rr, http.StatusOK)
}

// TestRegister_UsernameNotHTMLEscaped pins OC-0099: handleRegister must not
// persist an HTML-escaped username. A bare bluemonday sanitizer.Sanitize call
// HTML-escapes survivors (' -> &#39;, & -> &amp;, " -> &#34;), so a name like
// "O'Brien" would be stored as "O&#39;Brien" — different from what the user
// typed and from what handleLogin looks up (which only trims).
//
// WP 3C-9: an apostrophe is no longer a legal character in a name being
// chosen, so register now refuses "O'Brien" outright. The OC-0099 invariant
// that remains is that nothing is stored for it, escaped or not.
func TestRegister_UsernameNotHTMLEscaped(t *testing.T) {
	database, _, router := newAuthEnv(t)

	ownerID := mustCreateUser(t, database, "owner2", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    "O'Brien",
		"password":    "securePass1",
		"invite_code": code,
	})
	requireStatus(t, rr, http.StatusBadRequest)

	for _, name := range []string{"O'Brien", "O&#39;Brien"} {
		stored, err := database.GetUserByUsername(context.Background(), name)
		if err == nil && stored != nil {
			t.Errorf("a row exists for %q after a refused registration", name)
		}
	}
}

// TestLogin_UsernameWithApostropheSucceeds pins OC-0099 end-to-end: an account
// whose name holds an apostrophe must be able to log in with the exact same
// name. Before the fix, handleRegister stored the HTML-escaped form while
// handleLogin looked up the raw form, so this login permanently 401ed.
//
// WP 3C-9: register no longer admits such a name, but accounts made before
// the strict rules still hold one (login keeps the loose check), so the row is
// inserted directly.
func TestLogin_UsernameWithApostropheSucceeds(t *testing.T) {
	database, _, router := newAuthEnv(t)

	seedUser(t, database, "O'Brien", "securePass1", 4)

	loginRR := postLogin(t, router, "O'Brien", "securePass1")
	requireStatus(t, loginRR, http.StatusOK)
	resp := decodeBody[map[string]any](t, loginRR)
	if resp["token"] == nil {
		t.Error("Login response missing token")
	}
}

// TestLogin_OversizedUsernameRejectedBeforeRateLimiterKey pins OC-0021:
// handleLogin never length-checks req.Username before using it to build
// RateLimiter map keys ("login_user_fail:"+username, "login_user_lock:"+...).
// An unauthenticated caller could otherwise pin an arbitrarily large key in
// the limiter's maps (retained for hours by Cleanup's window) on every
// attempt. The oversized username must be rejected with 400 before any such
// key is ever recorded, mirroring the same 32-rune cap register enforces via
// auth.ValidateUsername before touching anything.
func TestLogin_OversizedUsernameRejectedBeforeRateLimiterKey(t *testing.T) {
	_, limiter, router := newAuthEnv(t)

	hugeUsername := strings.Repeat("a", 1<<20) // 1 MiB, as in the repro

	rr := postLogin(t, router, hugeUsername, "anypass123")

	expectStatus(t, rr, http.StatusBadRequest)

	// The route's own per-IP RateLimitMiddleware ("login:"+ip) legitimately
	// records one small, IP-bounded window entry regardless of this fix.
	// What must NOT happen is handleLogin additionally recording a second
	// entry keyed on the 1 MiB username itself (failKey/userFailKey) — that
	// unbounded entry is the actual leak, so anything beyond the single
	// expected IP entry means the oversized username reached key-building
	// code before being rejected.
	if windows, lockouts := limiter.Len(); windows > 1 || lockouts != 0 {
		t.Errorf("RateLimiter retained state after oversized-username login: windows=%d lockouts=%d, want at most 1/0", windows, lockouts)
	}
}

// OC-0151: registerReadRequest ran the fixpoint sanitizer
// (service.SanitizeText) over the raw username *before* auth.ValidateUsername
// applies its 32-rune cap. The sanitizer loops sanitizePass to a fixpoint,
// and nested HTML entities force roughly one extra pass per two nesting
// levels, so the cost is quadratic in the attacker-controlled field length.
// A 16 KB adversarial username measurably takes ~200ms to sanitize on this
// tree (measured up to ~3.4s at 64 KB) — all of it spent before any bound on
// the field is applied, and unauthenticated. The fix must reject an
// oversized username on a cheap byte-length check *before* sanitizing, so
// the rejection is near-instant regardless of payload size.
func TestRegister_OversizedUsernameRejectedBeforeSanitizing(t *testing.T) {
	_, _, router := newAuthEnv(t)

	// Adversarial nested-entity payload (16 KB) — see service.sanitizeToFixpoint's
	// doc comment for why this shape is quadratic to sanitize.
	hugeUsername := "&" + strings.Repeat("amp;", 4000) + "lt;"

	start := time.Now()
	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username":    hugeUsername,
		"password":    "securePass1",
		"invite_code": "whatever",
	})
	elapsed := time.Since(start)

	expectStatus(t, rr, http.StatusBadRequest)

	// A guard that runs before sanitizing rejects in well under a
	// millisecond; the pre-fix code spends ~200ms in sanitizeToFixpoint on
	// this payload before it ever reaches auth.ValidateUsername's length
	// check. 150ms gives generous margin over noise while still being far
	// below the unguarded cost.
	if elapsed > 150*time.Millisecond {
		t.Errorf("Register oversized username took %v, want well under 150ms (raw field must be bounded before sanitizing, not after)", elapsed)
	}
}

// ─── Rate limiting integration test ──────────────────────────────────────────

func TestRegister_RateLimit(t *testing.T) {
	database, _, router := newAuthEnv(t)

	ownerID := mustCreateUser(t, database, "rl_owner", "hash", 1)

	// Attempt register 4 times (limit=3) — 4th should be rate-limited.
	var lastCode int
	for i := range 4 {
		code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)
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

// ─── DeleteAccount tests ─────────────────────────────────────────────────────

// deleteJSONWithToken sends a DELETE request with an Authorization header and JSON body.
func deleteJSONWithToken(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doAPIJSON(t, router, http.MethodDelete, path, token, body)
}

// newMigratedAuthTestDB is newAuthTestDB on the real migration set: the
// account erasure touches every table, which the reduced apiTestSchema does
// not carry.
func newMigratedAuthTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openMigratedDB(t)
}

func TestDeleteAccount_Success(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Create as Member (role_id=4) so the last-admin check does not block deletion.
	uid, token := seedUserSession(t, database, "deleteuser", 4)

	rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{
		"password": "correctPass1",
	})

	requireStatus(t, rr, http.StatusNoContent)

	// The account is erased: no row survives (B4-9).
	user, err := database.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID after delete: %v", err)
	}
	if user != nil {
		t.Errorf("user row survived the erasure: %+v", user)
	}

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token))
	if sess != nil {
		t.Error("session should be deleted after account deletion")
	}
}

func TestDeleteAccount_MissingPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "delnopass", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{})

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestDeleteAccount_WrongPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "delwrong", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{
		"password": "wrongPassword1",
	})

	expectStatus(t, rr, http.StatusBadRequest)

	// Verify user is NOT deleted.
	user, _ := database.GetUserByID(context.Background(), uid)
	if user == nil || user.Banned {
		t.Error("user should not be deleted after wrong password")
	}
}

func TestDeleteAccount_LastAdmin(t *testing.T) {
	database := newMigratedAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)

	// Create as Owner (role_id=1) — the only admin-class user.
	uid, token := seedUserSession(t, database, "lastadmin", 1)

	rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{
		"password": "correctPass1",
	})

	expectStatus(t, rr, http.StatusForbidden)

	// User should still be intact.
	user, _ := database.GetUserByID(context.Background(), uid)
	if user == nil || user.Banned {
		t.Error("last admin should not be deleted")
	}
}

func TestDeleteAccount_NoAuth(t *testing.T) {
	_, _, router := newAuthEnv(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/account", bytes.NewReader([]byte(`{"password":"x"}`)))
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestDeleteAccount_LockoutAfterRepeatedFailures(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "dellockout", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// 3 failures should trigger lockout on the 4th attempt.
	for range 4 {
		deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{
			"password": "wrongPassword1",
		})
	}

	// Even with correct password, should now be locked out.
	rr := deleteJSONWithToken(t, router, "/api/v1/auth/account", token, map[string]string{
		"password": "correctPass1",
	})

	expectStatus(t, rr, http.StatusTooManyRequests)
}

// ─── ConfirmTOTP additional tests ────────────────────────────────────────────

func TestConfirmTOTP_InvalidCode(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "totpbadcode", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Enable TOTP first to get a pending secret.
	enable := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token, map[string]string{"password": "correctPass1"})
	requireStatus(t, enable, http.StatusOK)

	// Confirm with an invalid code.
	confirm := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token, map[string]string{
		"password": "correctPass1",
		"code":     "000000",
	})

	expectStatus(t, confirm, http.StatusUnauthorized)

	// Secret should NOT be persisted.
	user, _ := database.GetUserByID(context.Background(), uid)
	if user.TOTPSecret != nil {
		t.Error("TOTP secret should not be persisted after invalid code")
	}
}

func TestConfirmTOTP_NoPendingSecret(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "totpnopending", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Confirm without enabling first — no pending secret.
	confirm := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token, map[string]string{
		"password": "correctPass1",
		"code":     "123456",
	})

	expectStatus(t, confirm, http.StatusBadRequest)
}

func TestConfirmTOTP_MissingPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "totpnoconfirmpass", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Enable TOTP first.
	postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token, map[string]string{"password": "correctPass1"})

	// Confirm without password.
	confirm := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token, map[string]string{
		"code": "123456",
	})

	expectStatus(t, confirm, http.StatusBadRequest)
}

func TestConfirmTOTP_WrongPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "totpwrongconfirm", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Enable TOTP first.
	postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token, map[string]string{"password": "correctPass1"})

	// Confirm with wrong password.
	confirm := postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token, map[string]string{
		"password": "wrongPass",
		"code":     "123456",
	})

	expectStatus(t, confirm, http.StatusBadRequest)
}

func TestConfirmTOTP_NoAuth(t *testing.T) {
	_, _, router := newAuthEnv(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/totp/confirm", bytes.NewReader([]byte(`{"password":"x","code":"123456"}`)))
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── DisableTOTP additional tests ────────────────────────────────────────────

func TestDisableTOTP_WrongPassword(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "disabletotpwrong", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Set TOTP secret directly.
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?`, uid); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}

	deleteBody, _ := json.Marshal(map[string]string{"password": "wrongPass"})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/totp", bytes.NewReader(deleteBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusBadRequest)

	// TOTP should still be enabled.
	user, _ := database.GetUserByID(context.Background(), uid)
	if user.TOTPSecret == nil {
		t.Error("TOTP secret should still be set after wrong password")
	}
}

func TestDisableTOTP_Require2FABlocksDisable(t *testing.T) {
	database, _, router := newAuthEnv(t)

	// Enable require_2fa setting.
	if _, err := database.ExecContext(context.Background(), `UPDATE settings SET value = 'true' WHERE key = 'require_2fa'`); err != nil {
		t.Fatalf("enable require_2fa: %v", err)
	}

	uid := seedUser(t, database, "disabletotpreq", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	// Set TOTP secret directly.
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?`, uid); err != nil {
		t.Fatalf("set totp secret: %v", err)
	}

	deleteBody, _ := json.Marshal(map[string]string{"password": "correctPass1"})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/totp", bytes.NewReader(deleteBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusForbidden)

	// TOTP should still be enabled.
	user, _ := database.GetUserByID(context.Background(), uid)
	if user.TOTPSecret == nil {
		t.Error("TOTP secret should still be set when require_2fa is enabled")
	}
}

func TestDisableTOTP_NoAuth(t *testing.T) {
	_, _, router := newAuthEnv(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/totp", bytes.NewReader([]byte(`{"password":"x"}`)))
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── Logout additional tests ─────────────────────────────────────────────────

func TestLogout_InvalidToken(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := postJSONWithToken(t, router, "/api/v1/auth/logout", "invalid-token-value", nil)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestLogout_SessionGoneAfterLogout(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "logoutsess", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	tokenHash := auth.HashToken(token)
	_, _ = database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1")

	// First logout should succeed.
	rr := postJSONWithToken(t, router, "/api/v1/auth/logout", token, nil)
	requireStatus(t, rr, http.StatusNoContent)

	// Second logout with the same token should fail (session already deleted).
	rr2 := postJSONWithToken(t, router, "/api/v1/auth/logout", token, nil)
	expectStatus(t, rr2, http.StatusUnauthorized)
}

// ─── Me additional tests ─────────────────────────────────────────────────────

func TestMe_ReturnsCorrectUserFields(t *testing.T) {
	database, _, router := newAuthEnv(t)

	uid := seedUser(t, database, "medetailed", "correctPass1", 4)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")

	rr := getWithToken(t, router, "/api/v1/auth/me", token)

	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)

	// Verify all expected fields are present.
	for _, field := range []string{"id", "username", "status", "role_id", "totp_enabled", "created_at"} {
		if _, ok := resp[field]; !ok {
			t.Errorf("Me response missing field %q", field)
		}
	}
	if resp["username"] != "medetailed" {
		t.Errorf("username = %v, want medetailed", resp["username"])
	}
	if resp["totp_enabled"] != false {
		t.Errorf("totp_enabled = %v, want false", resp["totp_enabled"])
	}
}

func TestMe_InvalidToken(t *testing.T) {
	_, _, router := newAuthEnv(t)

	rr := getWithToken(t, router, "/api/v1/auth/me", "not-a-real-token")

	expectStatus(t, rr, http.StatusUnauthorized)
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
	ownerID := mustCreateUser(t, database, "expowner", "hash", 1)
	past := time.Now().Add(-time.Hour)
	code, _ := database.CreateInvite(context.Background(), ownerID, 0, &past)
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

	expectStatus(t, rr, http.StatusBadRequest)
}

// TestRegister_UsesTrustedForwardedIP pins OC-0093: handleRegister must
// resolve the client IP through the same trusted-proxy list handleLogin
// uses, not unconditionally use RemoteAddr. Behind a trusted reverse proxy,
// the sessions.ip row registration creates must record the real client, not
// the proxy's own address — otherwise the same client shows two different
// IPs on the "active sessions" screen depending on whether they registered
// or logged in.
func TestRegister_UsesTrustedForwardedIP(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouterWithProxies(database, limiter, []string{"127.0.0.0/8"})

	ownerID := mustCreateUser(t, database, "owner", "hash", 1)
	code, _ := database.CreateInvite(context.Background(), ownerID, 1, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader([]byte(
		`{"username":"newuser","password":"securePass1","invite_code":"`+code+`"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.RemoteAddr = "127.0.0.1:9999" // the trusted reverse proxy's own hop
	rr := serveRequest(router, req)

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
	token, _ := resp["token"].(string)
	if token == "" {
		t.Fatal("Register response missing token")
	}

	sess, err := database.GetSessionByTokenHash(context.Background(), auth.HashToken(token))
	if err != nil || sess == nil {
		t.Fatalf("GetSessionByTokenHash: %v", err)
	}
	if sess.IP != "203.0.113.9" {
		t.Errorf("session IP = %q, want the trusted-forwarded client IP %q — registration behind a reverse proxy must not record the proxy's own address", sess.IP, "203.0.113.9")
	}
}
