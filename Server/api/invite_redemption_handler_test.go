package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// GET /api/v1/invites/{code}/redemptions (O1): an owner can trace a leaked
// invite to the account that redeemed it.
func TestListInviteRedemptions_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "redemption-lister", 2)

	// Create an invite and redeem it.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{"max_uses": 1})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create invite = %d; body %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code, _ := created["code"].(string)
	if code == "" {
		t.Fatal("create invite response missing code")
	}

	if _, err := database.CreateUserWithInvite(context.Background(), "traceable-redeemer", "hash", 4, code, "sess-traceable", "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateUserWithInvite: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites/"+code+"/redemptions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("ListInviteRedemptions = %d, want 200; body = %s", w.Code, w.Body.String())
	}
	var resp []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp) != 1 {
		t.Fatalf("redemptions = %d, want 1", len(resp))
	}
	if resp[0]["username"] != "traceable-redeemer" {
		t.Errorf("username = %v, want traceable-redeemer", resp[0]["username"])
	}
	if resp[0]["redeemed_at"] == nil {
		t.Error("redeemed_at is missing")
	}
}

// A member without MANAGE_INVITES is refused.
func TestListInviteRedemptions_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	// Member role (id=4) lacks MANAGE_INVITES.
	token := loginAndGetToken(t, router, database, "plain-member", 4)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites/whatever/redemptions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("member ListInviteRedemptions = %d, want 403; body = %s", w.Code, w.Body.String())
	}
}

// An unknown code is 404.
func TestListInviteRedemptions_UnknownCode(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "unknown-redemption-lister", 2)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites/no-such-code/redemptions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("unknown code = %d, want 404; body = %s", w.Code, w.Body.String())
	}
}
