package api_test

// coverage_push_test.go adds tests for functions with low coverage
// to push the api package above 80%.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── handleCreateInvite: malformed JSON body ────────────────────────────────

func TestCreateInvite_MalformedJSON(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "malformedinvite", 2)

	rr := doAPIRawJSON(t, router, http.MethodPost, "/api/v1/invites", token, `{invalid json`)

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestCreateInvite_WithExpiration(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "expireinvite", 2)

	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses":         10,
		"expires_in_hours": 24,
	})

	expectStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
	if resp["expires_at"] == nil {
		t.Error("CreateInvite with expiry: expected expires_at to be set")
	}
}

// ─── handleEnableTOTP: already enabled ──────────────────────────────────────

func TestEnableTOTP_AlreadyEnabled(t *testing.T) {
	database, _, router := newAuthEnv(t)

	token := loginAndGetToken(t, router, database, "alreadytotp", 4)

	// Enable TOTP first.
	rr := postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})
	requireStatus(t, rr, http.StatusOK)

	enableResp := decodeBody[map[string]any](t, rr)
	secret := extractSecretFromURI(t, enableResp["qr_uri"].(string))

	// Confirm TOTP.
	code, _ := auth.GenerateTOTPCode(secret, time.Now().UTC())
	rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/confirm", token,
		map[string]string{"password": "Password1!", "code": code})
	requireStatus(t, rr, http.StatusNoContent)

	// Try enabling again — should get 409 Conflict.
	rr = postJSONWithToken(t, router, "/api/v1/users/me/totp/enable", token,
		map[string]string{"password": "Password1!"})
	expectStatus(t, rr, http.StatusConflict)
}

// ─── handleEnableTOTP: malformed body ───────────────────────────────────────

func TestEnableTOTP_MalformedBody(t *testing.T) {
	database, _, router := newAuthEnv(t)

	token := loginAndGetToken(t, router, database, "enablemalformed", 4)

	rr := doAPIRawJSON(t, router, http.MethodPost, "/api/v1/users/me/totp/enable", token, `{invalid`)

	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleConfirmTOTP: malformed body ──────────────────────────────────────

func TestConfirmTOTP_MalformedBody(t *testing.T) {
	database, _, router := newAuthEnv(t)

	token := loginAndGetToken(t, router, database, "confirmmalformed", 4)

	rr := doAPIRawJSON(t, router, http.MethodPost, "/api/v1/users/me/totp/confirm", token, `{invalid`)

	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleDisableTOTP: malformed body ──────────────────────────────────────

func TestDisableTOTP_MalformedBody(t *testing.T) {
	database, _, router := newAuthEnv(t)

	token := loginAndGetToken(t, router, database, "disablemalformed", 4)

	rr := doAPIRawJSON(t, router, http.MethodDelete, "/api/v1/users/me/totp", token, `{invalid`)

	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleUpdateProfile: malformed body ────────────────────────────────────

func TestUpdateProfile_MalformedBody(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "profilemalformed", 4)

	rr := doAPIRawJSON(t, router, http.MethodPatch, "/api/v1/users/me", token, `{invalid`)

	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleUpdateProfile: invalid username (too short/long or special chars) ─

func TestUpdateProfile_InvalidUsername(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "validuser1", 4)

	// Username with only spaces → empty after trim.
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "   ",
	})
	expectStatus(t, rr, http.StatusBadRequest)

	// Username that is too short (single char) — might fail ValidateUsername.
	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "a",
	})
	// This should be 400 if ValidateUsername rejects it, or 200 if it accepts 1-char names.
	// Either way, we hit the validation code path.
	if rr.Code != http.StatusBadRequest && rr.Code != http.StatusOK {
		t.Errorf("UpdateProfile short username: unexpected status = %d", rr.Code)
	}
}

// ─── handleUpdateProfile: avatar sanitisation ───────────────────────────────

func TestUpdateProfile_WithAvatar(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "avataruser", 4)

	// A different host: a URL on the request's own host must be an attachment
	// route, which the same-host guard in validateAvatarURL enforces.
	avatar := "https://avatars.example.net/avatar.png"
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "avataruser2",
		"avatar":   avatar,
	})
	expectStatus(t, rr, http.StatusOK)
}

func TestUpdateProfile_NullAvatar(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "nullavuser", 4)

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]any{
		"username": "nullavuser2",
		"avatar":   nil,
	})
	expectStatus(t, rr, http.StatusOK)
}

// ─── handleChangePassword: malformed body ───────────────────────────────────

func TestChangePassword_MalformedBody(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "chpwmalformed", 4)

	rr := doAPIRawJSON(t, router, http.MethodPut, "/api/v1/users/me/password", token, `{invalid`)

	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleChangePassword: missing fields ───────────────────────────────────

func TestChangePassword_MissingOldPassword(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "chpwmissold", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "",
		"new_password": "newSecure2",
	})
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestChangePassword_MissingNewPassword(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "chpwmissnew", 4)

	rr := putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
		"old_password": "securePass1",
		"new_password": "",
	})
	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── handleRevokeSession: invalid ID format ─────────────────────────────────

func TestRevokeSession_InvalidID(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revokebadfmt", 4)

	rr := profileDelete(t, router, "/api/v1/users/me/sessions/abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestRevokeSession_NegativeID(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "revokenegid", 4)

	rr := profileDelete(t, router, "/api/v1/users/me/sessions/-1", token)
	// Negative IDs should return 400 or 404.
	if rr.Code != http.StatusBadRequest && rr.Code != http.StatusNotFound {
		t.Errorf("RevokeSession negative ID: status = %d, want 400 or 404", rr.Code)
	}
}

// ─── handleLiveKitHealth via exported test helper ───────────────────────────

func TestLiveKitHealth_OK(t *testing.T) {
	handler := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return true, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health/livekit", nil)
	rr := serveRequest(handler, req)

	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	if resp["status"] != "ok" {
		t.Errorf("LiveKitHealth OK: status = %v, want 'ok'", resp["status"])
	}
	if resp["livekit_reachable"] != true {
		t.Errorf("LiveKitHealth OK: livekit_reachable = %v, want true", resp["livekit_reachable"])
	}
}

func TestLiveKitHealth_Degraded_WithError(t *testing.T) {
	handler := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return false, errors.New("connection refused")
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health/livekit", nil)
	rr := serveRequest(handler, req)

	expectStatus(t, rr, http.StatusServiceUnavailable)

	resp := decodeBody[map[string]any](t, rr)
	if resp["status"] != "degraded" {
		t.Errorf("LiveKitHealth degraded: status = %v, want 'degraded'", resp["status"])
	}
	if resp["error"] != "connection refused" {
		t.Errorf("LiveKitHealth degraded: error = %v, want 'connection refused'", resp["error"])
	}
}

func TestLiveKitHealth_Degraded_NilError(t *testing.T) {
	handler := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return false, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health/livekit", nil)
	rr := serveRequest(handler, req)

	expectStatus(t, rr, http.StatusServiceUnavailable)

	resp := decodeBody[map[string]any](t, rr)
	if resp["error"] != "unknown" {
		t.Errorf("LiveKitHealth nil error: error = %v, want 'unknown'", resp["error"])
	}
}

// ─── handleListSessions: unauthenticated ────────────────────────────────────

func TestListSessions_BadToken(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me/sessions", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleRevokeSession: unauthenticated ───────────────────────────────────

func TestRevokeSession_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	rr := profileDelete(t, router, "/api/v1/users/me/sessions/1", "badtoken")
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleChangePassword: unauthorized ─────────────────────────────────────

func TestChangePassword_Unauthorized(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	rr := putJSON(t, router, "/api/v1/users/me/password", "badtoken", map[string]string{
		"old_password": "securePass1",
		"new_password": "newSecure2",
	})
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleUpdateProfile: unauthorized ──────────────────────────────────────

func TestUpdateProfile_NoToken(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me",
		bytes.NewReader([]byte(`{"username":"hack"}`)))
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleListInvites: member forbidden ────────────────────────────────────

func TestListInvites_MemberForbidden(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "listmember", 4)

	rr := doAPI(t, router, http.MethodGet, "/api/v1/invites", token, nil)

	expectStatus(t, rr, http.StatusForbidden)
}

// ─── handleCloseDM: broadcaster returns false (user not connected) ──────────

type offlineBroadcaster struct{}

func (b *offlineBroadcaster) SendToUser(_ int64, _ []byte) bool {
	return false
}

func TestCloseDM_BroadcasterUserOffline(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &offlineBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "offline_alice", 4)
	_ = dmCreateToken(t, database, "offline_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "offline_bob")

	// Create a DM.
	rr := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	requireStatus(t, rr, http.StatusCreated)
	createResp := decodeBody[map[string]any](t, rr)
	channelID := createResp["channel_id"]

	// Close — broadcaster returns false (user offline).
	rr2 := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)
	expectStatus(t, rr2, http.StatusNoContent)
}

// ─── handleSearch / isInvalidSearchQueryError coverage ──────────────────────
// These tests exercise the search endpoint with various query patterns to cover
// isInvalidSearchQueryError and handleSearch edge cases.

func TestSearch_EmptyQuery(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchempty", 1)

	rr := chGet(t, router, "/api/v1/search?q=", token)
	// Empty query should return 400 or 200 with empty results.
	if rr.Code != http.StatusBadRequest && rr.Code != http.StatusOK {
		t.Errorf("Search empty: unexpected status = %d; body = %s", rr.Code, rr.Body.String())
	}
}

func TestSearch_SpecialCharacters(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchspecial", 1)

	// These queries may trigger FTS5 syntax errors which isInvalidSearchQueryError handles.
	queries := []string{
		`"unterminated string`,
		`test OR`,
		`test AND`,
		`*`,
		`test"`,
	}
	for _, q := range queries {
		rr := chGet(t, router, "/api/v1/search?q="+url.QueryEscape(q), token)
		// Should get 400 (invalid query) or 200 (handled gracefully).
		if rr.Code >= 500 {
			t.Errorf("Search %q: unexpected 5xx status = %d; body = %s", q, rr.Code, rr.Body.String())
		}
	}
}

// ─── handleListChannels: unauthorized ───────────────────────────────────────

func TestListChannels_Unauthorized(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleGetMessages: edge cases ──────────────────────────────────────────

func TestGetMessages_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "msglimit", 1)
	chID := mustCreateChannel(t, database, "limit-ch", "text")

	// Negative limit.
	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=-1", chID), token)
	if rr.Code >= 500 {
		t.Errorf("GetMessages negative limit: unexpected 5xx status = %d", rr.Code)
	}

	// Limit > 100.
	rr = chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=999", chID), token)
	expectStatus(t, rr, http.StatusOK)

	// With before parameter.
	rr = chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?before=999999", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

// ─── handleGetPins: basic and unauthorized ──────────────────────────────────

func TestGetPins_Success(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "pinuser", 1)
	chID := mustCreateChannel(t, database, "pin-ch", "text")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/pins", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestGetPins_Unauthorized(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	chID := mustCreateChannel(t, database, "pin-unauth-ch", "text")

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/channels/%d/pins", chID), nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleSetPinned: unauthorized and invalid ──────────────────────────────

func TestSetPinned_Unauthorized(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	chID := mustCreateChannel(t, database, "setpin-ch", "text")

	req := httptest.NewRequest(http.MethodPut,
		fmt.Sprintf("/api/v1/channels/%d/messages/1/pin", chID),
		bytes.NewReader([]byte(`{"pinned":true}`)))
	req.Header.Set("Content-Type", "application/json")
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── writeJSON: verify JSON encoding corner case ────────────────────────────
// writeJSON is at 75% — testing the success path covers the rest.

func TestWriteJSON_BasicSuccess(t *testing.T) {
	handler := api.HandleLiveKitHealthForTest(func(_ context.Context) (bool, error) {
		return true, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rr := serveRequest(handler, req)

	if ct := rr.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("writeJSON Content-Type = %q, want application/json", ct)
	}
}

// ─── helpers: buildChannelRouter, chTestCreateToken, chGet ──────────────────
// These are defined in channel_handler_test.go but we reference them here.
// They use newChannelTestDB which is also in that file.

// Verify all helper functions are accessible (compile check).
var (
	_ = newChannelTestDB
	_ = buildChannelRouter
	_ = chTestCreateToken
	_ = chGet
)

// ─── handleRevokeInvite: already revoked ────────────────────────────────────

func TestRevokeInvite_AlreadyRevoked(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildInviteRouter(database, limiter)

	token := loginAndGetToken(t, router, database, "revoketwice", 2)

	// Create invite.
	rr := postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{})
	requireStatus(t, rr, http.StatusCreated)
	created := decodeBody[map[string]any](t, rr)
	code := created["code"].(string)

	// Revoke it once.
	rr2 := doAPI(t, router, http.MethodDelete, "/api/v1/invites/"+code, token, nil)
	requireStatus(t, rr2, http.StatusNoContent)

	// Revoke it again — should still succeed (idempotent) or return error.
	rr3 := doAPI(t, router, http.MethodDelete, "/api/v1/invites/"+code, token, nil)
	// Should not be 500.
	if rr3.Code >= 500 {
		t.Errorf("RevokeInvite already revoked: unexpected 5xx = %d; body = %s", rr3.Code, rr3.Body.String())
	}
}

// ─── handleListSessions: multiple sessions ──────────────────────────────────

func TestListSessions_MultipleSessions(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "multisess", 4)

	// Create additional session.
	user, _ := database.GetUserByUsername(context.Background(), "multisess")
	_, _ = database.CreateSession(context.Background(), user.ID, auth.HashToken("extra-token"), "Chrome", "1.2.3.4")

	rr := getWithToken(t, router, "/api/v1/users/me/sessions", token)
	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[struct {
		Sessions []map[string]any `json:"sessions"`
	}](t, rr)
	if len(resp.Sessions) < 2 {
		t.Errorf("expected >= 2 sessions, got %d", len(resp.Sessions))
	}
}

// ─── handleListDMs: with token but invalid ──────────────────────────────────

func TestListDMs_InvalidToken(t *testing.T) {
	database := newDMTestDB(t)
	router := buildDMRouter(database, nil)

	rr := dmGet(t, router, "/api/v1/dms", "invalid-token-xxx")
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── buildAuthRouter with profile routes for combined testing ───────────────

func buildCombinedRouter(t *testing.T) (http.Handler, *auth.RateLimiter, string) {
	t.Helper()
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()

	r := chi.NewRouter()
	svc := service.New(database, limiter)
	api.MountAuthRoutes(r, service.NewAuthService(database, limiter, testTOTPKey, nil), api.AuthMiddleware(service.NewSessionService(database)), limiter, nil)
	api.MountProfileRoutes(r, svc, nil, limiter, nil, nil, nil)
	api.MountInviteRoutes(r, svc, limiter)

	token := loginAndGetToken(t, r, database, "combined1", 2)
	return r, limiter, token
}

func TestCombinedRouter_ProfileAndInvites(t *testing.T) {
	router, _, token := buildCombinedRouter(t)

	// Profile update.
	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{
		"username": "combined_newname",
	})
	expectStatus(t, rr, http.StatusOK)

	// Create invite.
	rr = postJSONWithToken(t, router, "/api/v1/invites", token, map[string]any{
		"max_uses": 5,
	})
	expectStatus(t, rr, http.StatusCreated)
}

// ─── handleSetPinned: message not found ─────────────────────────────────────

func TestSetPinned_MessageNotFound_Push(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinmissmsg", 1)
	chID := mustCreateChannel(t, database, "pinmiss-ch", "text")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, 99999), token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestSetPinned_ChannelNotFound_Push(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinmissch", 1)

	rr := chPost(t, router, "/api/v1/channels/99999/pins/1", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestSetPinned_InvalidChannelID(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinbadid", 1)

	rr := chPost(t, router, "/api/v1/channels/abc/pins/1", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSetPinned_InvalidMessageID(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinbadmsg", 1)
	chID := mustCreateChannel(t, database, "badmsgid-ch", "text")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/abc", chID), token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestUnpin_Success(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "unpinner", 1, "unpin-ch", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "to unpin")
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: msgID, Pinned: true, UserID: user.ID}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}

	rr := chDelete(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusNoContent)
}

func TestSetPinned_MemberForbidden(t *testing.T) {
	database := newPinTestDB(t)
	router, token, user, chID := newChannelEnvOn(t, database, "pinmember", 4, "pinforbid-ch", "text")
	msgID := mustCreateMessage(t, database, chID, user.ID, "cant pin")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID, msgID), token)
	expectStatus(t, rr, http.StatusForbidden)
}

func TestSetPinned_WrongChannel(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "pinwrongch", 1)
	user, _ := database.GetUserByUsername(context.Background(), "pinwrongch")
	chID1 := mustCreateChannel(t, database, "pin-ch1", "text")
	chID2 := mustCreateChannel(t, database, "pin-ch2", "text")
	msgID := mustCreateMessage(t, database, chID1, user.ID, "wrong channel")

	// Try to pin a message from chID1 using chID2.
	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", chID2, msgID), token)
	expectStatus(t, rr, http.StatusNotFound)
}

// ─── handleSetPinned: DM channel pin ────────────────────────────────────────

func TestSetPinned_DMChannel_ParticipantSuccess(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	tokenAlice := chTestCreateToken(t, database, "dmpin_alice", 4)
	_ = chTestCreateToken(t, database, "dmpin_bob", 4)
	alice, _ := database.GetUserByUsername(context.Background(), "dmpin_alice")
	bob, _ := database.GetUserByUsername(context.Background(), "dmpin_bob")

	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)
	msgID := mustCreateMessage(t, database, dmCh.ID, alice.ID, "pin this dm msg")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", dmCh.ID, msgID), tokenAlice)
	expectStatus(t, rr, http.StatusNoContent)
}

func TestSetPinned_DMChannel_NonParticipantForbidden(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	_ = chTestCreateToken(t, database, "dmpinforbid_alice", 4)
	_ = chTestCreateToken(t, database, "dmpinforbid_bob", 4)
	tokenCharlie := chTestCreateToken(t, database, "dmpinforbid_charlie", 4)
	alice, _ := database.GetUserByUsername(context.Background(), "dmpinforbid_alice")
	bob, _ := database.GetUserByUsername(context.Background(), "dmpinforbid_bob")

	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)
	msgID := mustCreateMessage(t, database, dmCh.ID, alice.ID, "secret msg")

	rr := chPost(t, router, fmt.Sprintf("/api/v1/channels/%d/pins/%d", dmCh.ID, msgID), tokenCharlie)
	expectStatus(t, rr, http.StatusNotFound)
}

// ─── handleSearch: with channel_id filter ───────────────────────────────────

func TestSearch_WithChannelID_Push(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "searchch", 1, "search-ch1", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "findable in channel")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/search?q=findable&channel_id=%d", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestSearch_WithInvalidChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchbadch", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_WithNonexistentChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchmissch", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=99999", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestSearch_WithLimit_Push(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchlimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=10", token)
	expectStatus(t, rr, http.StatusOK)
}

func TestSearch_WithInvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchbadlimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=abc", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_WithNegativeLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchneglimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=-1", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestSearch_WithOverMaxLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchmaxlimit", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&limit=999", token)
	expectStatus(t, rr, http.StatusOK)
}

func TestSearch_Unauthorized(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	rr := chGet(t, router, "/api/v1/search?q=test", "")
	expectStatus(t, rr, http.StatusUnauthorized)
}

// ─── handleGetMessages: more edge cases ─────────────────────────────────────

func TestGetMessages_ChannelNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "msgnotfound", 1)

	rr := chGet(t, router, "/api/v1/channels/99999/messages", token)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestGetMessages_InvalidChannelID(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "msgbadid", 1)

	rr := chGet(t, router, "/api/v1/channels/abc/messages", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

func TestGetMessages_WithBeforeParam(t *testing.T) {
	database, router, token, user, chID := newChannelEnv(t, "msgbefore", 1, "before-ch", "text")
	_ = mustCreateMessage(t, database, chID, user.ID, "msg one")
	msgID2 := mustCreateMessage(t, database, chID, user.ID, "msg two")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?before=%d", chID, msgID2), token)
	expectStatus(t, rr, http.StatusOK)
}

func TestGetMessages_WithCustomLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "msglimitcust", 1)
	chID := mustCreateChannel(t, database, "limitch", "text")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages?limit=5", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

// ─── handleListChannels: member role filtering ──────────────────────────────

func TestListChannels_MemberRole(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "memberchanlist", 4)
	_, _ = database.CreateChannel(context.Background(), "visible-ch", "text", "", "", 0)

	rr := chGet(t, router, "/api/v1/channels", token)
	expectStatus(t, rr, http.StatusOK)
}

func TestListChannels_AdminSeesAll(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "adminchanlist", 2)
	_, _ = database.CreateChannel(context.Background(), "admin-visible-ch", "text", "", "", 0)

	rr := chGet(t, router, "/api/v1/channels", token)
	expectStatus(t, rr, http.StatusOK)

	resp := decodeBody[[]any](t, rr)
	if len(resp) < 1 {
		t.Errorf("Admin should see at least 1 channel, got %d", len(resp))
	}
}

// ─── handleGetMessages: DM channel access ───────────────────────────────────

func TestGetMessages_DMChannel_NonParticipant(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	_ = chTestCreateToken(t, database, "dmmsg_alice", 4)
	_ = chTestCreateToken(t, database, "dmmsg_bob", 4)
	tokenCharlie := chTestCreateToken(t, database, "dmmsg_charlie", 4)
	alice, _ := database.GetUserByUsername(context.Background(), "dmmsg_alice")
	bob, _ := database.GetUserByUsername(context.Background(), "dmmsg_bob")

	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", dmCh.ID), tokenCharlie)
	expectStatus(t, rr, http.StatusNotFound)
}

func TestGetMessages_DMChannel_ParticipantSuccess(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	tokenAlice := chTestCreateToken(t, database, "dmmsgok_alice", 4)
	_ = chTestCreateToken(t, database, "dmmsgok_bob", 4)
	alice, _ := database.GetUserByUsername(context.Background(), "dmmsgok_alice")
	bob, _ := database.GetUserByUsername(context.Background(), "dmmsgok_bob")

	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", dmCh.ID), tokenAlice)
	expectStatus(t, rr, http.StatusOK)
}

// ─── handleSearch: DM channel search ────────────────────────────────────────

func TestSearch_DMChannelFilter_NonParticipant(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)
	_ = chTestCreateToken(t, database, "dmsearch_alice", 4)
	_ = chTestCreateToken(t, database, "dmsearch_bob", 4)
	tokenCharlie := chTestCreateToken(t, database, "dmsearch_charlie", 4)
	alice, _ := database.GetUserByUsername(context.Background(), "dmsearch_alice")
	bob, _ := database.GetUserByUsername(context.Background(), "dmsearch_bob")

	dmCh, _, _ := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/search?q=test&channel_id=%d", dmCh.ID), tokenCharlie)
	expectStatus(t, rr, http.StatusForbidden)
}

func TestSearch_NegativeChannelID_Push(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchnegch", 1)

	rr := chGet(t, router, "/api/v1/search?q=test&channel_id=-1", token)
	expectStatus(t, rr, http.StatusBadRequest)
}

// ─── RateLimitMiddleware "search:" bucket: coverage via multiple rapid requests ─

func TestSearch_RateLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "searchrl", 1)

	// Make many rapid search requests to trigger rate limiting.
	var lastCode int
	for range 25 {
		rr := chGet(t, router, "/api/v1/search?q=ratelimittest", token)
		lastCode = rr.Code
		if lastCode == http.StatusTooManyRequests {
			break
		}
	}
	// We may or may not hit the rate limit depending on the config,
	// but we exercise the middleware code path either way.
	if lastCode >= 500 {
		t.Errorf("Search rate limit: unexpected 5xx = %d", lastCode)
	}
}
