package admin_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
    (3, 'Member', NULL,      1049089,     40, 1);

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
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    type       TEXT    NOT NULL DEFAULT 'text',
    category   TEXT,
    topic      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    slow_mode  INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
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
	t.Cleanup(func() { database.Close() })

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

func doRequest(t *testing.T, handler http.Handler, method, path, token string, body interface{}) *httptest.ResponseRecorder {
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var stats map[string]interface{}
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/stats", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_Stats_Forbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createMemberUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// ─── GET /admin/api/users ─────────────────────────────────────────────────────

func TestAdminAPI_ListUsers_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/users?limit=50&offset=0", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var users []interface{}
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	// No query params — should use defaults
	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestAdminAPI_ListUsers_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/users", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── PATCH /admin/api/users/{id} ─────────────────────────────────────────────

func TestAdminAPI_PatchUser_BanUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	// Create a target user
	targetUID, _ := database.CreateUser("target", "hash", 3)

	body := map[string]interface{}{
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("rolechange", "hash", 3)

	body := map[string]interface{}{
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	body := map[string]interface{}{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/99999", token, body)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestAdminAPI_PatchUser_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/users/abc", token, nil)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// ─── DELETE /admin/api/users/{id}/sessions ────────────────────────────────────

func TestAdminAPI_ForceLogout_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser("logoutme", "hash", 3)
	database.CreateSession(targetUID, "victim-token-hash", "web", "1.2.3.4")

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodDelete, "/users/1/sessions", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── GET /admin/api/channels ──────────────────────────────────────────────────

func TestAdminAPI_ListChannels_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	database.AdminCreateChannel("general", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodGet, "/channels", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var channels []interface{}
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	body := map[string]interface{}{
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

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if _, ok := resp["id"]; !ok {
		t.Error("response missing 'id'")
	}
}

func TestAdminAPI_CreateChannel_MissingName(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	body := map[string]interface{}{
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("old", "text", "", "", 0)

	body := map[string]interface{}{
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	body := map[string]interface{}{"name": "x"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/99999", token, body)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ─── DELETE /admin/api/channels/{id} ─────────────────────────────────────────

func TestAdminAPI_DeleteChannel_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel("del-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
}

func TestAdminAPI_DeleteChannel_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/channels/99999", token, nil)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ─── GET /admin/api/audit-log ─────────────────────────────────────────────────

func TestAdminAPI_AuditLog_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	uid, _ := database.CreateUser("actor", "hash", 1)
	database.LogAudit(uid, "TEST_ACTION", "user", uid, "detail")

	w := doRequest(t, handler, http.MethodGet, "/audit-log?limit=10&offset=0", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var entries []interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
}

func TestAdminAPI_AuditLog_Empty(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/audit-log", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}

	var entries []interface{}
	json.Unmarshal(w.Body.Bytes(), &entries)
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

// ─── GET /admin/api/settings ──────────────────────────────────────────────────

func TestAdminAPI_GetSettings_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	// Admin (role 2) can authenticate but is not Owner (role 1, position 100)
	adminUID, _ := database.CreateUser("adminonly", "hash", 2)
	token := "admin-only-token"
	database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	// Should be forbidden — not Owner role
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestAdminAPI_Backup_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodPost, "/backup", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// itoa converts an int64 to a string for use in URL paths.
func itoa(n int64) string {
	return fmt.Sprint(n)
}
