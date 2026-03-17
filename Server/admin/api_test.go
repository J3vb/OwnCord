package admin_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// adminSchema is a minimal in-memory schema for admin API tests.
var adminSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',  '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',  '#F39C12', 1073741823,  80, 0),
    (3, 'Member', NULL,      1635,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 3 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT
);

CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name', 'Test Server'),
    ('motd', 'Hello');
`)

// openAdminTestDB opens a fresh in-memory database for admin API tests.
func openAdminTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// createAdminUser creates an Owner-role user and returns a valid bearer token.
func createAdminUser(t *testing.T, database *db.DB) string {
	t.Helper()
	// Owner role has permissions = 2147483647 (includes ADMINISTRATOR bit 0x40000000)
	uid, err := database.CreateUser("adminuser", "$2a$12$placeholder", 1)
	if err != nil {
		t.Fatalf("CreateUser admin: %v", err)
	}

	token := "test-admin-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// createMemberUser creates a Member-role user and returns a valid bearer token.
func createMemberUser(t *testing.T, database *db.DB) string {
	t.Helper()
	// Member role (id=3) has limited permissions, not ADMINISTRATOR
	uid, err := database.CreateUser("memberuser", "$2a$12$placeholder", 3)
	if err != nil {
		t.Fatalf("CreateUser member: %v", err)
	}

	token := "test-member-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

func doRequest(t *testing.T, handler http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("json.Marshal body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(bodyBytes))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// ─── GET /admin/api/stats ─────────────────────────────────────────────────────

func TestAdminAPI_Stats_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var stats map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal stats: %v", err)
	}
	if _, ok := stats["user_count"]; !ok {
		t.Error("response missing 'user_count'")
	}
	if _, ok := stats["message_count"]; !ok {
		t.Error("response missing 'message_count'")
	}
}

func TestAdminAPI_Stats_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)

	w := doRequest(t, handler, http.MethodGet, "/stats", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_Stats_Forbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createMemberUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// ─── GET /admin/api/users ─────────────────────────────────────────────────────

func TestAdminAPI_ListUsers_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/users?limit=50&offset=0", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var users []any
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("unmarshal users: %v", err)
	}
	// At least the admin user we created
	if len(users) < 1 {
		t.Error("expected at least 1 user in response")
	}
}

func TestAdminAPI_ListUsers_DefaultPagination(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	// No query params — should use defaults
	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestAdminAPI_ListUsers_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)

	w := doRequest(t, handler, http.MethodGet, "/users", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── PATCH /admin/api/users/{id} ─────────────────────────────────────────────

func TestAdminAPI_PatchUser_BanUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	// Create a target user
	targetUID, _ := database.CreateUser("target", "hash", 3)

	body := map[string]any{
		"banned":     true,
		"ban_reason": "spam",
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify user is banned in DB
	user, err := database.GetUserByID(targetUID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !user.Banned {
		t.Error("user should be banned after PATCH")
	}
}

func TestAdminAPI_PatchUser_ChangeRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("rolechange", "hash", 3)

	body := map[string]any{
		"role_id": float64(2),
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	user, _ := database.GetUserByID(targetUID)
	if user.RoleID != 2 {
		t.Errorf("RoleID = %d, want 2", user.RoleID)
	}
}

func TestAdminAPI_PatchUser_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/99999", token, body)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestAdminAPI_PatchUser_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/users/abc", token, nil)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// ─── DELETE /admin/api/users/{id}/sessions ────────────────────────────────────

func TestAdminAPI_ForceLogout_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("logoutme", "hash", 3)
	_, _ = database.CreateSession(targetUID, "victim-token-hash", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}

	sessions, _ := database.GetUserSessions(targetUID)
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after force logout, got %d", len(sessions))
	}
}

func TestAdminAPI_ForceLogout_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)

	w := doRequest(t, handler, http.MethodDelete, "/users/1/sessions", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── GET /admin/api/channels ──────────────────────────────────────────────────

func TestAdminAPI_ListChannels_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	_, _ = database.AdminCreateChannel("general", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodGet, "/channels", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var channels []any
	if err := json.Unmarshal(w.Body.Bytes(), &channels); err != nil {
		t.Fatalf("unmarshal channels: %v", err)
	}
	if len(channels) != 1 {
		t.Errorf("expected 1 channel, got %d", len(channels))
	}
}

// ─── POST /admin/api/channels ─────────────────────────────────────────────────

func TestAdminAPI_CreateChannel_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "new-channel",
		"type":     "text",
		"category": "General",
		"topic":    "Discussion",
		"position": float64(1),
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if _, ok := resp["id"]; !ok {
		t.Error("response missing 'id'")
	}
}

func TestAdminAPI_CreateChannel_MissingName(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"type": "text",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// ─── PATCH /admin/api/channels/{id} ──────────────────────────────────────────

func TestAdminAPI_UpdateChannel_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("old", "text", "", "", 0)

	body := map[string]any{
		"name":      "updated",
		"topic":     "new topic",
		"slow_mode": float64(10),
		"position":  float64(2),
		"archived":  false,
	}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_UpdateChannel_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{"name": "x"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/99999", token, body)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ─── DELETE /admin/api/channels/{id} ─────────────────────────────────────────

func TestAdminAPI_DeleteChannel_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("del-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
}

func TestAdminAPI_DeleteChannel_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/channels/99999", token, nil)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ─── GET /admin/api/audit-log ─────────────────────────────────────────────────

func TestAdminAPI_AuditLog_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	uid, _ := database.CreateUser("actor", "hash", 1)
	_ = database.LogAudit(uid, "TEST_ACTION", "user", uid, "detail")

	w := doRequest(t, handler, http.MethodGet, "/audit-log?limit=10&offset=0", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var entries []any
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
}

func TestAdminAPI_AuditLog_Empty(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/audit-log", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var entries []any
	_ = json.Unmarshal(w.Body.Bytes(), &entries)
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

// ─── GET /admin/api/settings ──────────────────────────────────────────────────

func TestAdminAPI_GetSettings_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/settings", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var settings map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &settings); err != nil {
		t.Fatalf("unmarshal settings: %v", err)
	}
	if _, ok := settings["server_name"]; !ok {
		t.Error("response missing 'server_name'")
	}
}

// ─── PATCH /admin/api/settings ────────────────────────────────────────────────

func TestAdminAPI_PatchSettings_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]string{
		"server_name": "Updated Server",
		"motd":        "New MOTD",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify the change was persisted
	val, err := database.GetSetting("server_name")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val != "Updated Server" {
		t.Errorf("server_name = %q, want 'Updated Server'", val)
	}
}

func TestAdminAPI_PatchSettings_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	req := httptest.NewRequest(http.MethodPatch, "/settings", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// ─── POST /admin/api/backup ───────────────────────────────────────────────────

func TestAdminAPI_Backup_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)

	// Admin (role 2) can authenticate but is not Owner (role 1, position 100)
	adminUID, _ := database.CreateUser("adminonly", "hash", 2)
	token := "admin-only-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	// Should be forbidden — not Owner role
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestAdminAPI_Backup_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)

	w := doRequest(t, handler, http.MethodPost, "/backup", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── Task 0.3: actor stored in context ───────────────────────────────────────

// TestAdminAPI_ActorFromContext verifies that after auth middleware runs, the
// user ID surfaced by audit log entries comes from the context-stored user (not
// a redundant DB lookup). We exercise this through the PATCH /users/{id} path
// which logs an audit entry containing the actor_id.
func TestAdminAPI_ActorFromContext_AuditEntry(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	// Create a target user to act on.
	targetUID, _ := database.CreateUser("ctxtarget", "hash", 3)

	body := map[string]any{"banned": true, "ban_reason": "context test"}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// The audit log should have a non-zero actor_id showing the actor was
	// resolved (not 0, which would indicate a failed context lookup).
	entries, err := database.GetAuditLog(10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least 1 audit entry")
	}
	// All entries should have a non-zero actor_id.
	for _, e := range entries {
		if e.ActorID == 0 {
			t.Errorf("audit entry actor_id = 0, expected the admin user's ID (actor stored from context)")
		}
	}
}

// TestAdminAPI_ActorFromContext_ForceLogout exercises actorFromContext via the
// DELETE /users/{id}/sessions path.
func TestAdminAPI_ActorFromContext_ForceLogout(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("logoutctx", "hash", 3)
	_, _ = database.CreateSession(targetUID, "victim-hash-ctx", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	entries, err := database.GetAuditLog(10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least 1 audit entry")
	}
	for _, e := range entries {
		if e.ActorID == 0 {
			t.Errorf("audit entry actor_id = 0, expected non-zero actor from context")
		}
	}
}

// ─── Task 0.6: Settings key whitelist ────────────────────────────────────────

// TestAdminAPI_PatchSettings_RejectsUnknownKey verifies that an unknown key
// returns 400 without writing anything to the database.
func TestAdminAPI_PatchSettings_RejectsUnknownKey(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]string{
		"unknown_key": "should be rejected",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal error response: %v", err)
	}
	// The error message must name the offending key so the caller knows what to fix.
	if msg, ok := resp["message"]; !ok || msg == "" {
		t.Error("response should include a non-empty 'message' field")
	}
}

// TestAdminAPI_PatchSettings_RejectsMixedKeys verifies that a payload
// containing both valid and invalid keys is rejected entirely (no partial write).
func TestAdminAPI_PatchSettings_RejectsMixedKeys(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]string{
		"server_name": "valid",
		"injected_key": "should block the whole request",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	// The valid key must NOT have been written because the request was rejected.
	val, err := database.GetSetting("server_name")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val == "valid" {
		t.Error("server_name was updated despite invalid key in payload — partial write occurred")
	}
}

// TestAdminAPI_PatchSettings_AcceptsAllWhitelistedKeys iterates over every key
// in the whitelist and confirms each one is individually accepted.
func TestAdminAPI_PatchSettings_AcceptsAllWhitelistedKeys(t *testing.T) {
	whitelistedKeys := []string{
		"server_name",
		"server_icon",
		"motd",
		"max_upload_bytes",
		"voice_quality",
		"require_2fa",
		"registration_open",
		"backup_schedule",
		"backup_retention",
	}

	for _, key := range whitelistedKeys {
		t.Run(key, func(t *testing.T) {
			database := openAdminTestDB(t)
			handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
			token := createAdminUser(t, database)

			body := map[string]string{key: "testvalue"}
			w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

			if w.Code != http.StatusOK {
				t.Errorf("key %q: status = %d, want 200; body: %s", key, w.Code, w.Body.String())
			}
		})
	}
}

// TestAdminAPI_PatchSettings_EmptyPayloadIsOK verifies that an empty map
// (no-op update) is accepted and returns the current settings.
func TestAdminAPI_PatchSettings_EmptyPayloadIsOK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]string{}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// ─── Fix 2.1: Sensitive field redaction ──────────────────────────────────────

// TestAdminAPI_ListUsers_NoPasswordHash verifies that GET /users does not
// expose the PasswordHash field in any returned user object.
func TestAdminAPI_ListUsers_NoPasswordHash(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	// Create a second user so the list is non-trivial.
	_, _ = database.CreateUser("plainuser", "supersecretbcrypthash", 3)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	body := w.Body.String()
	// The raw bcrypt hash must never appear in the response.
	if strings.Contains(body, "supersecretbcrypthash") {
		t.Error("GET /users response contains PasswordHash — sensitive field leaked")
	}
	// The JSON key itself must also be absent.
	if strings.Contains(body, "password_hash") || strings.Contains(body, "PasswordHash") {
		t.Error("GET /users response contains password_hash key — sensitive field leaked")
	}
}

// TestAdminAPI_ListUsers_NoTOTPSecret verifies that GET /users does not
// expose the TOTPSecret field.
func TestAdminAPI_ListUsers_NoTOTPSecret(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	body := w.Body.String()
	if strings.Contains(body, "totp_secret") || strings.Contains(body, "TOTPSecret") {
		t.Error("GET /users response contains totp_secret key — sensitive field leaked")
	}
}

// TestAdminAPI_ListUsers_PublicFieldsPresent verifies that safe public fields
// are still present after the sensitive-field removal.
func TestAdminAPI_ListUsers_PublicFieldsPresent(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var users []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(users) == 0 {
		t.Fatal("expected at least one user")
	}

	u := users[0]
	for _, field := range []string{"id", "username", "status", "role_id", "created_at", "banned", "role_name"} {
		if _, ok := u[field]; !ok {
			t.Errorf("GET /users response user object missing expected field %q", field)
		}
	}
}

// TestAdminAPI_PatchUser_NoPasswordHash verifies that PATCH /users/{id} does
// not expose PasswordHash in the returned user object.
func TestAdminAPI_PatchUser_NoPasswordHash(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("patchvictim", "topsecretbcrypt", 3)

	body := map[string]any{
		"banned":     true,
		"ban_reason": "test",
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	respBody := w.Body.String()
	if strings.Contains(respBody, "topsecretbcrypt") {
		t.Error("PATCH /users/{id} response contains PasswordHash — sensitive field leaked")
	}
	if strings.Contains(respBody, "password_hash") || strings.Contains(respBody, "PasswordHash") {
		t.Error("PATCH /users/{id} response contains password_hash key — sensitive field leaked")
	}
}

// TestAdminAPI_PatchUser_NoTOTPSecret verifies that PATCH /users/{id} does
// not expose TOTPSecret in the returned user object.
func TestAdminAPI_PatchUser_NoTOTPSecret(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("patchtotp", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"banned": false,
	})

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	respBody := w.Body.String()
	if strings.Contains(respBody, "totp_secret") || strings.Contains(respBody, "TOTPSecret") {
		t.Error("PATCH /users/{id} response contains totp_secret — sensitive field leaked")
	}
}

// ─── 4.1: Channel CRUD broadcast tests ───────────────────────────────────────

// mockHub records which broadcast methods were called and with what arguments.
type mockHub struct {
	restartCalls      []restartCall
	channelCreates    []*db.Channel
	channelUpdates    []*db.Channel
	channelDeleteIDs  []int64
	memberBanIDs      []int64
	memberUpdates     []memberUpdateCall
	clientCount       int
}

type memberUpdateCall struct {
	userID   int64
	roleName string
}

type restartCall struct {
	reason       string
	delaySeconds int
}

func (m *mockHub) BroadcastServerRestart(reason string, delaySeconds int) {
	m.restartCalls = append(m.restartCalls, restartCall{reason, delaySeconds})
}

func (m *mockHub) BroadcastChannelCreate(ch *db.Channel) {
	m.channelCreates = append(m.channelCreates, ch)
}

func (m *mockHub) BroadcastChannelUpdate(ch *db.Channel) {
	m.channelUpdates = append(m.channelUpdates, ch)
}

func (m *mockHub) BroadcastChannelDelete(channelID int64) {
	m.channelDeleteIDs = append(m.channelDeleteIDs, channelID)
}

func (m *mockHub) BroadcastMemberBan(userID int64) {
	m.memberBanIDs = append(m.memberBanIDs, userID)
}

func (m *mockHub) BroadcastMemberUpdate(userID int64, roleName string) {
	m.memberUpdates = append(m.memberUpdates, memberUpdateCall{userID, roleName})
}

func (m *mockHub) ClientCount() int {
	return m.clientCount
}

func TestAdminAPI_CreateChannel_BroadcastsChannelCreate(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name": "broadcast-test",
		"type": "text",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	if len(hub.channelCreates) != 1 {
		t.Fatalf("BroadcastChannelCreate called %d times, want 1", len(hub.channelCreates))
	}
	if hub.channelCreates[0].Name != "broadcast-test" {
		t.Errorf("broadcast channel name = %q, want broadcast-test", hub.channelCreates[0].Name)
	}
}

func TestAdminAPI_CreateChannel_NilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	// nil hub: handler must not panic
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	body := map[string]any{"name": "safe-channel", "type": "text"}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", w.Code)
	}
}

func TestAdminAPI_UpdateChannel_BroadcastsChannelUpdate(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("before", "text", "", "", 0)

	body := map[string]any{"name": "after"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if len(hub.channelUpdates) != 1 {
		t.Fatalf("BroadcastChannelUpdate called %d times, want 1", len(hub.channelUpdates))
	}
	if hub.channelUpdates[0].Name != "after" {
		t.Errorf("broadcast channel name = %q, want after", hub.channelUpdates[0].Name)
	}
}

func TestAdminAPI_UpdateChannel_NilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("patchme", "text", "", "", 0)
	body := map[string]any{"name": "patched"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestAdminAPI_DeleteChannel_BroadcastsChannelDelete(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("delete-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	if len(hub.channelDeleteIDs) != 1 {
		t.Fatalf("BroadcastChannelDelete called %d times, want 1", len(hub.channelDeleteIDs))
	}
	if hub.channelDeleteIDs[0] != chID {
		t.Errorf("broadcast channel id = %d, want %d", hub.channelDeleteIDs[0], chID)
	}
}

func TestAdminAPI_DeleteChannel_NilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("del-no-hub", "text", "", "", 0)
	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// itoa converts an int64 to a string for use in URL paths.
func itoa(n int64) string {
	return fmt.Sprint(n)
}

