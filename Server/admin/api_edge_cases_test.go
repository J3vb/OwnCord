package admin_test

// Targeted tests to boost coverage to 80%+ by exercising uncovered branches.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
)

// ─── handlePatchUser — self-modification guard ─────────────────────────────

// TestAdminAPI_PatchUser_CannotModifySelf verifies that an admin cannot patch
// their own account via the admin panel.
func TestAdminAPI_PatchUser_CannotModifySelf(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// The admin user created by createAdminUser has id=1. We try to patch id=1.
	body := map[string]any{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/1", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("self-modification status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_PatchUser_UnbanUser verifies that setting banned=false on a
// banned user unbans them and returns 200.
func TestAdminAPI_PatchUser_UnbanUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Create and ban a target user first.
	targetUID, _ := database.CreateUser(context.Background(), "unbanme", "hash", 3)
	_ = database.BanUser(context.Background(), targetUID, "test ban", nil)

	body := map[string]any{"banned": false}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("unban status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify the user is now unbanned.
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.Banned {
		t.Error("user is still banned after unban request")
	}
}

// TestAdminAPI_PatchUser_TempBan verifies that ban_duration_hours stores an
// expiry so the ban lapses on its own.
func TestAdminAPI_PatchUser_TempBan(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "tempbanme", "hash", 3)

	body := map[string]any{"banned": true, "ban_reason": "cooling off", "ban_duration_hours": 24}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("temp ban status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	user, _ := database.GetUserByID(context.Background(), targetUID)
	if !user.Banned {
		t.Fatal("user should be banned")
	}
	if user.BanExpires == nil {
		t.Fatal("ban_expires should be set for a temporary ban")
	}
}

// TestAdminAPI_PatchUser_TempBanOutOfRange verifies duration bounds are enforced.
func TestAdminAPI_PatchUser_TempBanOutOfRange(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "toolongban", "hash", 3)

	for _, hours := range []int{-1, 24*365 + 1} {
		body := map[string]any{"banned": true, "ban_duration_hours": hours}
		w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("ban_duration_hours=%d status = %d, want 400; body: %s", hours, w.Code, w.Body.String())
		}
	}
}

// TestAdminAPI_PatchUser_InvalidBody verifies that a non-JSON body returns 400.
func TestAdminAPI_PatchUser_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "invalidbody", "hash", 3)

	req := httptest.NewRequest(http.MethodPatch, "/users/"+itoa(targetUID), bytes.NewReader([]byte("not-json")))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid body status = %d, want 400", w.Code)
	}
}

// ─── handleCreateChannel — default type ───────────────────────────────────

// TestAdminAPI_CreateChannel_DefaultsTypeToText verifies that omitting the
// "type" field causes the channel to be created with type "text".
func TestAdminAPI_CreateChannel_DefaultsTypeToText(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]any{
		"name": "no-type-channel",
		// "type" intentionally omitted — should default to "text"
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["type"] != "text" {
		t.Errorf("type = %q, want text", resp["type"])
	}
}

// TestAdminAPI_CreateChannel_InvalidBody verifies that a malformed body returns 400.
func TestAdminAPI_CreateChannel_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	req := httptest.NewRequest(http.MethodPost, "/channels", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid body status = %d, want 400", w.Code)
	}
}

// ─── handleForceLogout — invalid ID ──────────────────────────────────────

// TestAdminAPI_ForceLogout_InvalidID verifies that a non-numeric user ID in
// the URL returns 400.
func TestAdminAPI_ForceLogout_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/users/notanumber/sessions", token, nil)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid ID status = %d, want 400", w.Code)
	}
}

// ─── handlePatchChannel — invalid body ────────────────────────────────────

// TestAdminAPI_PatchChannel_InvalidBody verifies that a malformed PATCH body
// returns 400.
func TestAdminAPI_PatchChannel_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "malformed", "text", "", "", 0)

	req := httptest.NewRequest(http.MethodPatch, "/channels/"+itoa(chID), bytes.NewReader([]byte("not-json")))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid body status = %d, want 400", w.Code)
	}
}

// ─── queryInt — cap at 500 ────────────────────────────────────────────────

// TestAdminAPI_ListUsers_CapLargeLimit verifies that a limit > 500 is capped
// to 500 (testing the queryInt cap branch).
func TestAdminAPI_ListUsers_CapLargeLimit(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Passing limit=9999 should be silently capped to 500.
	w := doRequest(t, handler, http.MethodGet, "/users?limit=9999", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// ─── handleCheckUpdate — nil updater ──────────────────────────────────────

// TestAdminAPI_CheckUpdate_NilUpdater verifies that GET /updates returns 503
// when no updater is configured.
func TestAdminAPI_CheckUpdate_NilUpdater(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("nil updater GET /updates status = %d, want 503", w.Code)
	}
}

// ─── handleDeleteChannel — invalid ID ────────────────────────────────────

// TestAdminAPI_DeleteChannel_InvalidID verifies that a non-numeric channel ID
// returns 400.
func TestAdminAPI_DeleteChannel_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/channels/notanumber", token, nil)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid ID status = %d, want 400", w.Code)
	}
}

// ─── handlePatchChannel — invalid ID ─────────────────────────────────────

// TestAdminAPI_PatchChannel_InvalidID verifies that a non-numeric channel ID
// returns 400.
func TestAdminAPI_PatchChannel_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]any{"name": "x"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/abc", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid ID status = %d, want 400", w.Code)
	}
}

// ─── handleGetAuditLog — pagination ───────────────────────────────────────

// TestAdminAPI_AuditLog_Pagination verifies that limit and offset params work.
func TestAdminAPI_AuditLog_Pagination(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Create several audit entries.
	uid, _ := database.CreateUser(context.Background(), "auditpager", "hash", 1)
	for i := range 5 {
		_ = database.LogAudit(context.Background(), uid, "TEST", "test", int64(i), "")
	}

	// Fetch page 2 with limit=2, offset=2 — should return 2 entries.
	w := doRequest(t, handler, http.MethodGet, "/audit-log?limit=2&offset=2", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var entries []any
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries with limit=2 offset=2, got %d", len(entries))
	}
}

// TestAdminAPI_AuditLog_Search pins the server-side audit search (AO-7): q
// and action narrow the whole log, not just the page the panel fetched, and
// the pagination limits still apply to the narrowed result.
func TestAdminAPI_AuditLog_Search(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	ctx := context.Background()

	uid, _ := database.CreateUser(ctx, "searcher", "hash", 1)
	// The one match is the OLDEST row, behind a full page of newer noise, so
	// a page-local filter could never find it.
	_ = database.LogAudit(ctx, uid, "channel_delete", "channel", 1, "removed #Needle-Room")
	for i := range 60 {
		_ = database.LogAudit(ctx, uid, "setting_change", "setting", int64(i), "motd updated")
	}
	for i := range 5 {
		_ = database.LogAudit(ctx, uid, "role_create", "role", int64(i), "")
	}

	get := func(t *testing.T, query string) []map[string]any {
		t.Helper()
		w := doRequest(t, handler, http.MethodGet, "/audit-log?"+query, token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /audit-log?%s status = %d, want 200; body: %s", query, w.Code, w.Body.String())
		}
		var entries []map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return entries
	}

	t.Run("q matches detail case-insensitively across the whole log", func(t *testing.T) {
		got := get(t, "limit=50&q=needle-room")
		if len(got) != 1 || got[0]["action"] != "channel_delete" {
			t.Fatalf("q=needle-room = %v, want the one channel_delete row", got)
		}
	})
	t.Run("q matches the actor name", func(t *testing.T) {
		if got := get(t, "limit=500&q=SEARCH"); len(got) != 66 {
			t.Fatalf("q=SEARCH = %d rows, want all 66 by actor searcher", len(got))
		}
	})
	t.Run("action is an exact match", func(t *testing.T) {
		if got := get(t, "limit=500&action=role_create"); len(got) != 5 {
			t.Fatalf("action=role_create = %d rows, want 5", len(got))
		}
		if got := get(t, "limit=500&action=role"); len(got) != 0 {
			t.Fatalf("action=role = %d rows, want 0 (no prefix match)", len(got))
		}
	})
	t.Run("q and action combine, and paginate", func(t *testing.T) {
		if got := get(t, "action=setting_change&q=MOTD&limit=7&offset=56"); len(got) != 4 {
			t.Fatalf("page past offset 56 of 60 matches = %d rows, want 4", len(got))
		}
	})
	t.Run("a blank q does not narrow", func(t *testing.T) {
		if got := get(t, "limit=500&q=%20%20"); len(got) < 66 {
			t.Fatalf("q=blank = %d rows, want every row", len(got))
		}
	})
	t.Run("limit stays capped at 500", func(t *testing.T) {
		for i := range 500 {
			_ = database.LogAudit(ctx, uid, "setting_change", "setting", int64(i), "bulk")
		}
		if got := get(t, "limit=100000&q=setting"); len(got) != 500 {
			t.Fatalf("limit=100000 = %d rows, want the 500 cap", len(got))
		}
	})

	for name, query := range map[string]string{
		"an over-long q":        "q=" + strings.Repeat("a", 101),
		"an over-long action":   "action=" + strings.Repeat("a", 65),
		"a q that is not UTF-8": "q=%ff%fe",
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			w := doRequest(t, handler, http.MethodGet, "/audit-log?"+query, token, nil)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
			}
		})
	}
}

// ─── handleGetStats — nil hub ─────────────────────────────────────────────

// TestAdminAPI_Stats_NilHub verifies that GET /stats works correctly when
// hub is nil (the OnlineCount field defaults to 0).
func TestAdminAPI_Stats_NilHub(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var stats map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// online_count should be 0 when hub is nil
	if v, ok := stats["online_count"]; ok {
		if v.(float64) != 0 {
			t.Errorf("online_count = %v, want 0 (nil hub)", v)
		}
	}
}

// ─── queryInt — invalid string value ──────────────────────────────────────

// TestAdminAPI_AuditLog_InvalidLimitParam verifies that a non-numeric limit
// falls back to the default (testing the queryInt error-fallback branch).
func TestAdminAPI_AuditLog_InvalidLimitParam(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/audit-log?limit=notanumber", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("invalid limit status = %d, want 200", w.Code)
	}
}

// TestAdminAPI_ListUsers_InvalidLimitParam verifies that limit=0 falls back to
// the default (testing the n < 1 branch of queryInt).
func TestAdminAPI_ListUsers_InvalidLimitParam(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// limit=0 triggers the n < 1 fallback in queryInt
	w := doRequest(t, handler, http.MethodGet, "/users?limit=0", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("limit=0 status = %d, want 200", w.Code)
	}
}

// ─── PatchUser — nil hub does not panic ─────────────────────────────────────

// TestAdminAPI_PatchUser_BanNilHubDoesNotPanic verifies that banning a user
// when hub is nil does not panic (exercises the hub != nil guard around
// BroadcastMemberBan).
func TestAdminAPI_PatchUser_BanNilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "ban-nohub", "hash", 3)

	body := map[string]any{"banned": true, "ban_reason": "nil hub test"}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify ban was still applied despite nil hub.
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if !user.Banned {
		t.Error("user should be banned even with nil hub")
	}
}

// TestAdminAPI_LogStreamTicketFlow verifies that the admin API issues
// single-use log stream tickets and rejects both ticket reuse and the old
// token-in-query flow.
func TestAdminAPI_LogStreamTicketFlow(t *testing.T) {
	database := openAdminTestDB(t)
	logBuf := admin.NewRingBuffer(8)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, logBuf, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	ticketResp := doRequest(t, handler, http.MethodPost, "/logs/ticket", token, nil)
	if ticketResp.Code != http.StatusOK {
		t.Fatalf("POST /logs/ticket status = %d, want 200; body: %s", ticketResp.Code, ticketResp.Body.String())
	}

	var payload struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(ticketResp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal ticket response: %v", err)
	}
	if payload.Ticket == "" {
		t.Fatal("expected non-empty log stream ticket")
	}
	if err := database.DeleteSession(context.Background(), auth.HashToken(token)); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	srv := httptest.NewServer(handler)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/logs/stream?ticket="+payload.Ticket, nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		t.Fatalf("GET /logs/stream?ticket=... after session revocation status = %d, want 401; body: %s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(body, []byte("invalid or expired session")) {
		_ = resp.Body.Close()
		t.Fatalf("expected revoked-session error body, got: %s", string(body))
	}
	cancel()
	_ = resp.Body.Close()

	reuseResp, err := http.Get(srv.URL + "/logs/stream?ticket=" + payload.Ticket)
	if err != nil {
		t.Fatalf("reuse request failed: %v", err)
	}
	defer reuseResp.Body.Close() //nolint:errcheck
	if reuseResp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(reuseResp.Body)
		t.Fatalf("reused ticket status = %d, want 401; body: %s", reuseResp.StatusCode, string(body))
	}

	legacyResp, err := http.Get(srv.URL + "/logs/stream?token=" + token)
	if err != nil {
		t.Fatalf("legacy request failed: %v", err)
	}
	defer legacyResp.Body.Close() //nolint:errcheck
	if legacyResp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(legacyResp.Body)
		t.Fatalf("legacy token stream status = %d, want 401; body: %s", legacyResp.StatusCode, string(body))
	}

	if _, err := database.CreateSession(context.Background(), 1, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	ticketResp = doRequest(t, handler, http.MethodPost, "/logs/ticket", token, nil)
	if ticketResp.Code != http.StatusOK {
		t.Fatalf("POST /logs/ticket after restoring session status = %d, want 200; body: %s", ticketResp.Code, ticketResp.Body.String())
	}
	if err := json.Unmarshal(ticketResp.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal restored ticket response: %v", err)
	}
	if err := database.UpdateUserRole(context.Background(), 1, 3); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	demotedResp, err := http.Get(srv.URL + "/logs/stream?ticket=" + payload.Ticket)
	if err != nil {
		t.Fatalf("demoted-role request failed: %v", err)
	}
	defer demotedResp.Body.Close() //nolint:errcheck
	if demotedResp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(demotedResp.Body)
		t.Fatalf("demoted-role ticket status = %d, want 403; body: %s", demotedResp.StatusCode, string(body))
	}
}

// TestAdminAPI_PatchUser_RoleChangeNilHubDoesNotPanic verifies that changing a
// user's role when hub is nil does not panic (exercises the hub != nil guard
// around BroadcastMemberUpdate).
func TestAdminAPI_PatchUser_RoleChangeNilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "role-nohub", "hash", 3)

	body := map[string]any{"role_id": float64(2)}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify role was still changed despite nil hub.
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.RoleID != 2 {
		t.Errorf("RoleID = %d, want 2", user.RoleID)
	}
}

// ─── PatchUser — BanReason nil path ────────────────────────────────────────

// TestAdminAPI_PatchUser_BanWithoutReason verifies that banning a user without
// providing ban_reason is accepted (reason defaults to empty string).
func TestAdminAPI_PatchUser_BanWithoutReason(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "banwithout", "hash", 3)

	// No ban_reason in body — the nil check in handlePatchUser uses empty string.
	body := map[string]any{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("ban without reason status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// ─── PatchUser — role change broadcasts ────────────────────────────────────

// TestAdminAPI_PatchUser_RoleChangeBroadcast verifies that changing a user's
// role results in a BroadcastMemberUpdate call via the hub.
func TestAdminAPI_PatchUser_RoleChangeBroadcast(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "rolebroadcast", "hash", 3)

	body := map[string]any{"role_id": float64(2)}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if len(hub.memberUpdates) == 0 {
		t.Error("BroadcastMemberUpdate not called after role change")
	}
}

// ─── Setup endpoints ──────────────────────────────────────────────────────

// TestAdminAPI_SetupStatus_NeedsSetup verifies that GET /setup/status returns
// needs_setup=true when the database has no users.
func TestAdminAPI_SetupStatus_NeedsSetup(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/setup/status", "", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp["needs_setup"] {
		t.Error("expected needs_setup=true when no users exist")
	}
}

// TestAdminAPI_SetupStatus_AlreadySetup verifies needs_setup=false when users exist.
func TestAdminAPI_SetupStatus_AlreadySetup(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	_, _ = database.CreateUser(context.Background(), "existing", "hash", 1)

	w := doRequest(t, handler, http.MethodGet, "/setup/status", "", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]bool
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["needs_setup"] {
		t.Error("expected needs_setup=false when users exist")
	}
}

// TestAdminAPI_Setup_Success verifies the full setup flow creates an owner,
// session, channel, and invite.
func TestAdminAPI_Setup_Success(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	body := map[string]string{
		"username": "owner",
		"password": "Str0ngP@ssw0rd!",
	}
	w := doRequest(t, handler, http.MethodPost, "/setup", "", body)

	if w.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["token"] == nil || resp["token"] == "" {
		t.Error("expected non-empty token in setup response")
	}
	if resp["invite_code"] == nil || resp["invite_code"] == "" {
		t.Error("expected non-empty invite_code in setup response")
	}
	if resp["username"] != "owner" {
		t.Errorf("username = %v, want owner", resp["username"])
	}
}

// TestAdminAPI_Setup_AlreadyCompleted verifies that POST /setup returns 403
// when users already exist.
func TestAdminAPI_Setup_AlreadyCompleted(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	_, _ = database.CreateUser(context.Background(), "existing", "hash", 1)

	body := map[string]string{
		"username": "hacker",
		"password": "Str0ngP@ssw0rd!",
	}
	w := doRequest(t, handler, http.MethodPost, "/setup", "", body)

	if w.Code != http.StatusForbidden {
		t.Errorf("setup after completion status = %d, want 403", w.Code)
	}
}

// TestAdminAPI_Setup_MissingFields verifies that POST /setup with empty
// username or password returns 400.
func TestAdminAPI_Setup_MissingFields(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	body := map[string]string{
		"username": "",
		"password": "",
	}
	w := doRequest(t, handler, http.MethodPost, "/setup", "", body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("empty fields status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_Setup_WeakPassword verifies that a weak password is rejected.
func TestAdminAPI_Setup_WeakPassword(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	body := map[string]string{
		"username": "owner",
		"password": "weak",
	}
	w := doRequest(t, handler, http.MethodPost, "/setup", "", body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("weak password status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_Setup_InvalidBody verifies that a non-JSON body returns 400.
func TestAdminAPI_Setup_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	req := httptest.NewRequest(http.MethodPost, "/setup", bytes.NewReader([]byte("not-json")))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid body status = %d, want 400", w.Code)
	}
}
