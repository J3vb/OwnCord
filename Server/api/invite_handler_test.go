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
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
)

// buildInviteRouter returns a chi router with invite routes and auth middleware.
func buildInviteRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	r := chi.NewRouter()
	svc := service.New(database, limiter)
	api.MountAuthRoutes(r, database, limiter, nil, testTOTPKey)
	api.MountInviteRoutes(r, database, svc)
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

// TestCreateInvite_ChannelAllowOverrideDoesNotGrant pins the scope boundary of
// RequirePermission: it gates on SERVER-WIDE bits, so a per-channel allow must
// never open it. The state is reachable — the admin channel-permission handler
// masks override input with permissions.AllPerms, which includes ManageInvites.
// This kills the plausible-looking "just route RequirePermission through
// Checker.HasChannelPerm" refactor, which would pass naive review because
// GetChannelPermissions returns (0, 0, nil) when no override row exists.
func TestCreateInvite_ChannelAllowOverrideDoesNotGrant(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "overrideuser", 4)

	if _, err := database.Exec(
		`INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if _, err := database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, ?, 0)`,
		permissions.ManageInvites,
	); err != nil {
		t.Fatalf("insert channel override: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses": 1,
	})

	if rr.Code != http.StatusForbidden {
		t.Errorf("CreateInvite with channel allow override status = %d, want 403", rr.Code)
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

func TestCreateInvite_EmptyBody(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "emptyinvitebody", 2)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/invites", http.NoBody)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("CreateInvite empty body status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["max_uses"] != nil {
		t.Errorf("max_uses = %v, want nil", resp["max_uses"])
	}
	if resp["expires_at"] != nil {
		t.Errorf("expires_at = %v, want nil", resp["expires_at"])
	}
	if resp["code"] == nil || resp["code"] == "" {
		t.Fatal("expected invite code in response")
	}
}

func TestCreateInvite_CreateInviteFailure(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "invitecreatefail", 2)

	if _, err := database.Exec(`DROP TABLE invites`); err != nil {
		t.Fatalf("drop invites table: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("CreateInvite create failure status = %d, want 500; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["message"] != "an internal error occurred" {
		t.Errorf("message = %v, want an internal error occurred", resp["message"])
	}
}

func TestCreateInvite_GetInviteFailure(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "invitegetfail", 2)

	if _, err := database.Exec(`
		CREATE TRIGGER delete_invite_after_insert
		AFTER INSERT ON invites
		BEGIN
			DELETE FROM invites WHERE code = NEW.code;
		END;
	`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("CreateInvite get failure status = %d, want 500; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["message"] != "an internal error occurred" {
		t.Errorf("message = %v, want an internal error occurred", resp["message"])
	}
	if _, err := database.Exec(`DROP TRIGGER delete_invite_after_insert`); err != nil {
		t.Fatalf("drop trigger: %v", err)
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

func TestListInvites_EmptyArray(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "emptyinvitelist", 2)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("ListInvites empty status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var resp []any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 0 {
		t.Fatalf("ListInvites empty returned %d items, want 0", len(resp))
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

func TestRevokeInvite_RevokeFailure(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "revokefailure", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("setup create invite: status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var created map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	code := created["code"].(string)

	if _, err := database.Exec(`
		CREATE TRIGGER block_revoke_invite
		BEFORE UPDATE OF revoked ON invites
		BEGIN
			SELECT RAISE(FAIL, 'revoke blocked');
		END;
	`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusInternalServerError {
		t.Fatalf("RevokeInvite failure status = %d, want 500; body = %s", rr2.Code, rr2.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr2.Body).Decode(&resp); err != nil {
		t.Fatalf("decode revoke failure response: %v", err)
	}
	if resp["message"] != "an internal error occurred" {
		t.Errorf("message = %v, want an internal error occurred", resp["message"])
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
