package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// The recovery kit's routes (B4-5): enrolment and status under /users/me,
// public redemption that signs the holder in without the second factor.
func TestRecoveryKitRoutes_EnrolStatusRecover(t *testing.T) {
	ctx := context.Background()
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)
	uid := seedUser(t, database, "kitholder", "KitHolderPass1!", 4)
	token := issueSessionToken(t, database, uid)

	// Not enrolled yet.
	rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status route = %d; body = %s", rr.Code, rr.Body.String())
	}
	var status map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&status)
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
	if rr.Code != http.StatusOK {
		t.Fatalf("enrolment = %d; body = %s", rr.Code, rr.Body.String())
	}
	var issue struct {
		KitSecret string `json:"kit_secret"`
		CreatedAt string `json:"created_at"`
	}
	_ = json.NewDecoder(rr.Body).Decode(&issue)
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
	if rr.Code != http.StatusOK {
		t.Fatalf("recovery = %d; body = %s", rr.Code, rr.Body.String())
	}
	var recovered map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&recovered)
	if recovered["token"] == nil || recovered["requires_2fa"] != false {
		t.Fatalf("recovery body = %v, want a session token", recovered)
	}
	// The old session is gone; the new password signs in; the kit is spent.
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", token); rr.Code != http.StatusUnauthorized {
		t.Fatalf("old session after recovery = %d, want 401", rr.Code)
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

// An owner-issued credential (B4-6) is redeemed through the same public
// route, in the credential field, and signs the holder in likewise.
func TestRecoverRoute_AcceptsAnOwnerIssuedCredential(t *testing.T) {
	ctx := context.Background()
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)
	uid := seedUser(t, database, "assisted", "AssistedPass1!", 4)
	oldToken := issueSessionToken(t, database, uid)
	oid := seedUser(t, database, "owner", "OwnerPass1!", int(permissions.OwnerRoleID))
	owner, _ := database.GetUserByID(ctx, oid)
	issue, err := service.NewAuthService(database, limiter, nil, nil).IssueRecoveryAssist(ctx, owner, uid, "voice_call")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}

	rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", "new_password": "N3w-Str0ng!Pass"})
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong credential = %d, want 401; body = %s", rr.Code, rr.Body.String())
	}
	rr = postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": issue.Credential, "new_password": "N3w-Str0ng!Pass"})
	if rr.Code != http.StatusOK {
		t.Fatalf("credential = %d; body = %s", rr.Code, rr.Body.String())
	}
	if rr := getWithToken(t, router, "/api/v1/users/me/recovery-kit", oldToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("the old session is still alive: %d", rr.Code)
	}
	if rr := postJSON(t, router, "/api/v1/auth/recover", map[string]string{"username": "assisted", "credential": issue.Credential, "new_password": "N3w-Str0ng!Pass2"}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("replayed credential = %d, want 401", rr.Code)
	}
}
