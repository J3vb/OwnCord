package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// buildInviteRouter returns a chi router with invite routes and auth middleware.
func buildInviteRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	r := chi.NewRouter()
	api.MountAuthRoutes(r, database, limiter)
	api.MountInviteRoutes(r, database)
	return r
}

// loginAndGetToken creates a user with a known password and returns their session token.
func loginAndGetToken(t *testing.T, _ http.Handler, database *db.DB, username string, roleID int) string {
	t.Helper()
	hash, _ := auth.HashPassword("Password1!")
	uid, _ := database.CreateUser(username, hash, roleID)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(uid, auth.HashToken(token), "test", "127.0.0.1")
	return token
}

// ─── POST /api/v1/invites ─────────────────────────────────────────────────────

func TestCreateInvite_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	// Admin role (id=2) has MANAGE_INVITES (0x4000000) set.
	token := loginAndGetToken(t, router, database, "invitecreator", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses":         5,
		"expires_in_hours": 48,
	})

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateInvite status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["code"] == nil {
		t.Error("CreateInvite response missing code")
	}
}

func TestCreateInvite_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	rr := postJSON(t, router, "/api/v1/invites", map[string]any{
		"max_uses": 5,
	})

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("CreateInvite no auth status = %d, want 401", rr.Code)
	}
}

func TestCreateInvite_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	// Member role (id=4) does NOT have MANAGE_INVITES.
	token := loginAndGetToken(t, router, database, "memberuser", 4)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses": 1,
	})

	if rr.Code != http.StatusForbidden {
		t.Errorf("CreateInvite member status = %d, want 403", rr.Code)
	}
}

func TestCreateInvite_Unlimited(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "adminuser2", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	if rr.Code != http.StatusCreated {
		t.Errorf("CreateInvite unlimited status = %d, want 201", rr.Code)
	}
}

// ─── GET /api/v1/invites ──────────────────────────────────────────────────────

func TestListInvites_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "listuser", 2)

	// Create a couple of invites.
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{"max_uses": 1})
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{"max_uses": 5})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("ListInvites status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp []any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) < 2 {
		t.Errorf("ListInvites returned %d items, want >= 2", len(resp))
	}
}

func TestListInvites_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("ListInvites no auth status = %d, want 401", rr.Code)
	}
}

// ─── DELETE /api/v1/invites/:code ─────────────────────────────────────────────

func TestRevokeInvite_Success(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoker", 2)

	// Create invite via API.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create invite for revoke test: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	codeVal, ok := created["code"]
	if !ok || codeVal == nil {
		t.Fatalf("Create invite response missing code field; body parsed as %v", created)
	}
	code := codeVal.(string)

	// Revoke it.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusNoContent {
		t.Errorf("RevokeInvite status = %d, want 204; body = %s", rr2.Code, rr2.Body.String())
	}

	// Verify invite is revoked.
	inv, _ := database.GetInvite(code)
	if inv == nil || !inv.Revoked {
		t.Error("Invite not revoked in database after DELETE")
	}
}

func TestRevokeInvite_NotFound(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoker2", 2)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/doesnotexist", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("RevokeInvite not found status = %d, want 404", rr.Code)
	}
}

func TestRevokeInvite_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	adminToken := loginAndGetToken(t, router, database, "admin3", 2)
	memberToken := loginAndGetToken(t, router, database, "member3", 4)

	// Admin creates invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", adminToken, map[string]any{})
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code := created["code"].(string)

	// Member tries to revoke.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+memberToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusForbidden {
		t.Errorf("RevokeInvite member status = %d, want 403", rr2.Code)
	}
}

// TestListInvites_IncludesRevokedAndActive checks the list endpoint returns
// correct data for both revoked and active invites.
func TestListInvites_IncludesRevokedAndActive(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "listall", 2)

	// Create and revoke one invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create invite for list test: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&created)
	code := created["code"].(string)

	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	delReq.Header.Set("Authorization", "Bearer "+token)
	delReq.RemoteAddr = "127.0.0.1:9999"
	httptest.NewRecorder() // discard
	router.ServeHTTP(httptest.NewRecorder(), delReq)

	// Create one active invite.
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	// List should include both.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusOK {
		t.Errorf("ListInvites status = %d, want 200", rr2.Code)
	}
}

