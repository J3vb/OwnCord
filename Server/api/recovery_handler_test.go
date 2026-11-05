package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// The recovery kit's routes (B4-5): enrolment and status under /users/me,
// public redemption that signs the holder in without the second factor.
func TestRecoveryKitRoutes_EnrolStatusRecover(t *testing.T) {
	ctx := context.Background()
	database, _, router := newAuthEnv(t)
	uid := seedUser(t, database, "kitholder", "KitHolderPass1!", 4)
	token := issueSessionToken(t, database, uid)
	apiToken := issueAPIToken(t, database, uid)

	// Not enrolled yet.
	rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", token)
	requireStatus(t, rr, http.StatusOK)
	status := decodeBody[map[string]any](t, rr)
	if status["enrolled"] != false {
		t.Fatalf("status before enrolment = %v", status)
	}

	// Unauthenticated enrolment and a wrong password are refused.
	if rr := postJSON(t, router, "/api/v1/users/me/recovery-kit", map[string]string{"password": "KitHolderPass1!"}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous enrolment = %d, want 401", rr.Code)
	}
	if rr := postJSONWithToken(t, router, "/api/v1/users/me/recovery-kit", token, map[string]string{"password": "wrong"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("wrong password = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}

	rr = postJSONWithToken(t, router, "/api/v1/users/me/recovery-kit", token, map[string]string{"password": "KitHolderPass1!"})
	requireStatus(t, rr, http.StatusOK)
	issue := decodeBody[struct {
		KitSecret string `json:"kit_secret"`
		CreatedAt string `json:"created_at"`
	}](t, rr)
	if issue.KitSecret == "" || issue.CreatedAt == "" {
		t.Fatalf("issue = %+v, want the secret once", issue)
	}
	rr = getWithToken(t, router, "/api/v1/users/me/recovery-kit", token)
	status = nil
	_ = json.NewDecoder(rr.Body).Decode(&status)
	if status["enrolled"] != true {
		t.Fatalf("status after enrolment = %v", status)
	}

	// Redemption: a weak new password is refused before anything runs; a
	// wrong secret is the uniform 401; the right one signs in.
	if rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "kitholder", "kit_secret": issue.KitSecret, "new_password": "short"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("weak password = %d, want 400", rr.Code)
	}
	wrong, _, _ := auth.GenerateRecoveryKitSecret()
	if rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "kitholder", "kit_secret": wrong, "new_password": "Recovered-Pass2!"}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong secret = %d, want 401; body = %s", rr.Code, rr.Body.String())
	}
	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "kitholder", "kit_secret": issue.KitSecret, "new_password": "Recovered-Pass2!"})
	requireStatus(t, rr, http.StatusOK)
	recovered := decodeBody[map[string]any](t, rr)
	if recovered["token"] == nil || recovered["requires_2fa"] != false {
		t.Fatalf("recovery body = %v, want a session token", recovered)
	}
	// The old session is gone; the new password signs in; the kit is spent.
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", token); rr.Code != http.StatusUnauthorized {
		t.Fatalf("old session after recovery = %d, want 401", rr.Code)
	}
	// So is an API token minted before it.
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", apiToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("API token after recovery = %d, want 401", rr.Code)
	}
	if rr := postJSON(t, router, "/api/v1/auth/login", map[string]string{"username": "kitholder", "password": "Recovered-Pass2!"}); rr.Code != http.StatusOK {
		t.Fatalf("login with the new password = %d; body = %s", rr.Code, rr.Body.String())
	}
	if rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "kitholder", "kit_secret": issue.KitSecret, "new_password": "Recovered-Pass3!"}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("spent kit = %d, want 401", rr.Code)
	}
	_ = ctx
}

// issueSessionToken creates a login session for uid and returns its raw token.
func issueSessionToken(t *testing.T, database interface {
	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
}, uid int64) string {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// issueAPIToken mints an API token for uid and returns its raw token.
func issueAPIToken(t *testing.T, database interface {
	CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string, expiresAt *time.Time) (int64, error)
}, uid int64) string {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(token), "bot", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	return token
}

// An owner-issued credential (B4-6) is redeemed through the same public
// route, in the credential field, and signs the holder in likewise.
func TestRecoverRoute_AcceptsAnOwnerIssuedCredential(t *testing.T) {
	ctx := context.Background()
	database, limiter, router := newAuthEnv(t)
	uid := seedUser(t, database, "assisted", "AssistedPass1!", 4)
	oldToken := issueSessionToken(t, database, uid)
	apiToken := issueAPIToken(t, database, uid)
	oid := seedUser(t, database, "owner", "OwnerPass1!", int(permissions.OwnerRoleID))
	issue, err := service.NewAuthService(database, limiter, nil, nil).IssueRecoveryAssist(ctx, oid, uid, "voice_call")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}

	rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", "new_password": "N3w-Str0ng!Pass"})
	requireStatus(t, rr, http.StatusUnauthorized)
	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": issue.Credential, "new_password": "N3w-Str0ng!Pass"})
	requireStatus(t, rr, http.StatusOK)
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", oldToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("the old session is still alive: %d", rr.Code)
	}
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", apiToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("an API token minted before recovery is still alive: %d", rr.Code)
	}
	if rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": issue.Credential, "new_password": "N3w-Str0ng!Pass2"}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("replayed credential = %d, want 401", rr.Code)
	}
}

// The public route bounds the username as login does (Codex on #1512): it
// becomes a limiter key and a lockout row.
func TestRecoverRoute_BoundsTheUsername(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	for _, name := range []string{strings.Repeat("a", 33), strings.Repeat("a", 200000)} {
		rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": name, "credential": "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA", "new_password": "N3w-Str0ng!Pass"})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("username of %d bytes = %d, want 400", len(name), rr.Code)
		}
	}
}

func TestRecoveryKitStatusRoute_StoreFaultYieldsAGenericBody(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	uid := seedUser(t, database, "kitfault", "KitFaultPass1!", 4)
	token := issueSessionToken(t, database, uid)
	if _, err := database.ExecContext(context.Background(), `DROP TABLE recovery_kits`); err != nil {
		t.Fatalf("drop recovery_kits: %v", err)
	}

	rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", token)
	requireStatus(t, rr, http.StatusInternalServerError)
	body := decodeBody[map[string]string](t, rr)
	if body["error"] != "INTERNAL_ERROR" || body["message"] != "internal error" {
		t.Errorf("body = %v, want INTERNAL_ERROR / internal error", body)
	}
}

// A recovery that committed but could not start a session answers its own
// code and tells the holder to sign in, not the generic "try again".
func TestRecoverRoute_SessionIssueFailureAfterCommitSaysSignIn(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	uid := seedUser(t, database, "kitsignin", "KitSignInPass1!", 4)
	token := issueSessionToken(t, database, uid)
	rr := postJSONWithToken(t, router, "/api/v1/users/me/recovery-kit", token, map[string]string{"password": "KitSignInPass1!"})
	requireStatus(t, rr, http.StatusOK)
	issue := decodeBody[struct {
		KitSecret string `json:"kit_secret"`
	}](t, rr)
	if _, err := database.ExecContext(context.Background(),
		`CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'session store down'); END`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "kitsignin", "kit_secret": issue.KitSecret, "new_password": "N3w-Str0ng!Pass"})
	requireStatus(t, rr, http.StatusInternalServerError)
	body := decodeBody[map[string]string](t, rr)
	if body["error"] != "RECOVERED_SIGN_IN_REQUIRED" || !strings.Contains(body["message"], "sign in with your new password") {
		t.Errorf("body = %v, want RECOVERED_SIGN_IN_REQUIRED with the sign-in hint", body)
	}
}
