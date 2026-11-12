package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// buildInviteRouter returns a chi router with invite routes and auth middleware.
func buildInviteRouter(database *db.DB, limiter *auth.RateLimiter) http.Handler {
	r := chi.NewRouter()
	svc := service.New(database, limiter)
	api.MountAuthRoutes(r, service.NewAuthService(database, limiter, testTOTPKey, nil), api.AuthMiddleware(service.NewSessionService(database)), limiter, nil)
	api.MountInviteRoutes(r, svc, limiter)
	return r
}

// loginAndGetToken creates a user with a known password and returns their session token.
func loginAndGetToken(t *testing.T, _ http.Handler, database *db.DB, username string, roleID int) string {
	t.Helper()
	hash, _ := auth.HashPassword("Password1!")
	uid := mustCreateUser(t, database, username, hash, roleID)
	token, _ := auth.GenerateToken()
	_, _ = database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1")
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

	expectStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
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

	expectStatus(t, rr, http.StatusUnauthorized)
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

	expectStatus(t, rr, http.StatusForbidden)
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

	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, ?, 0)`,
		permissions.ManageInvites,
	); err != nil {
		t.Fatalf("insert channel override: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses": 1,
	})

	expectStatus(t, rr, http.StatusForbidden)
}

func TestCreateInvite_Unlimited(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "adminuser2", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	expectStatus(t, rr, http.StatusCreated)
}

func TestCreateInvite_EmptyBody(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "emptyinvitebody", 2)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/invites", http.NoBody)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rr := serveLocal(router, req)

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
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

	if _, err := database.ExecContext(context.Background(), `DROP TABLE invites`); err != nil {
		t.Fatalf("drop invites table: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	requireStatus(t, rr, http.StatusInternalServerError)

	resp := decodeBody[map[string]any](t, rr)
	if resp["message"] != "an internal error occurred" {
		t.Errorf("message = %v, want an internal error occurred", resp["message"])
	}
}

func TestCreateInvite_GetInviteFailure(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "invitegetfail", 2)

	if _, err := database.ExecContext(context.Background(), `
		CREATE TRIGGER delete_invite_after_insert
		AFTER INSERT ON invites
		BEGIN
			DELETE FROM invites WHERE code = NEW.code;
		END;
	`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	requireStatus(t, rr, http.StatusInternalServerError)

	resp := decodeBody[map[string]any](t, rr)
	if resp["message"] != "an internal error occurred" {
		t.Errorf("message = %v, want an internal error occurred", resp["message"])
	}
	if _, err := database.ExecContext(context.Background(), `DROP TRIGGER delete_invite_after_insert`); err != nil {
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

	rr := doAPI(t, router, http.MethodGet, "/api/v1/invites", token, nil)

	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[[]any](t, rr)
	if len(resp) < 2 {
		t.Errorf("ListInvites returned %d items, want >= 2", len(resp))
	}
}

func TestListInvites_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/invites", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestListInvites_EmptyArray(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "emptyinvitelist", 2)

	rr := doAPI(t, router, http.MethodGet, "/api/v1/invites", token, nil)

	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[[]any](t, rr)
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
	requireStatus(t, rr, http.StatusCreated)
	created := decodeBody[map[string]any](t, rr)
	codeVal, ok := created["code"]
	if !ok || codeVal == nil {
		t.Fatalf("Create invite response missing code field; body parsed as %v", created)
	}
	code := codeVal.(string)

	// Revoke it.
	rr2 := doAPI(t, router, http.MethodDelete, "/api/v1/invites/"+code, token, nil)

	expectStatus(t, rr2, http.StatusNoContent)

	// Verify invite is revoked.
	inv, _ := database.GetInvite(context.Background(), code)
	if inv == nil || !inv.Revoked {
		t.Error("Invite not revoked in database after DELETE")
	}
}

func TestRevokeInvite_NotFound(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoker2", 2)

	rr := doAPI(t, router, http.MethodDelete, "/api/v1/invites/doesnotexist", token, nil)

	expectStatus(t, rr, http.StatusNotFound)
}

func TestRevokeInvite_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	adminToken := loginAndGetToken(t, router, database, "admin3", 2)
	memberToken := loginAndGetToken(t, router, database, "member3", 4)

	// Admin creates invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", adminToken, map[string]any{})
	created := decodeBody[map[string]any](t, rr)
	code := created["code"].(string)

	// Member tries to revoke.
	rr2 := doAPI(t, router, http.MethodDelete, "/api/v1/invites/"+code, memberToken, nil)

	expectStatus(t, rr2, http.StatusForbidden)
}

func TestRevokeInvite_RevokeFailure(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)
	token := loginAndGetToken(t, router, database, "revokefailure", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	requireStatus(t, rr, http.StatusCreated)
	created := decodeBody[map[string]any](t, rr)
	code := created["code"].(string)

	if _, err := database.ExecContext(context.Background(), `
		CREATE TRIGGER block_revoke_invite
		BEFORE UPDATE OF revoked ON invites
		BEGIN
			SELECT RAISE(FAIL, 'revoke blocked');
		END;
	`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	rr2 := doAPI(t, router, http.MethodDelete, "/api/v1/invites/"+code, token, nil)

	requireStatus(t, rr2, http.StatusInternalServerError)

	resp := decodeBody[map[string]any](t, rr2)
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
	requireStatus(t, rr, http.StatusCreated)
	created := decodeBody[map[string]any](t, rr)
	code := created["code"].(string)

	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/invites/"+code, nil)
	delReq.Header.Set("Authorization", "Bearer "+token)
	delReq.RemoteAddr = "127.0.0.1:9999"
	httptest.NewRecorder() // discard
	router.ServeHTTP(httptest.NewRecorder(), delReq)

	// Create one active invite.
	postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})

	// List should include both.
	rr2 := doAPI(t, router, http.MethodGet, "/api/v1/invites", token, nil)

	expectStatus(t, rr2, http.StatusOK)
}
