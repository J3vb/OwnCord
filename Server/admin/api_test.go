package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// newTestModService builds a real ModerationService over the test database so
// PATCH-user ban paths exercise the production authorization (BAN_MEMBERS +
// role hierarchy) instead of a stub.
func newTestModService(database *db.DB) *service.ModerationService {
	st := database
	checker := permissions.NewChecker(st)
	return service.NewModerationService(st, service.NewPermissionService(st, checker))
}

// newTestChannelService builds a real ChannelService over the test database
// so the channel routes exercise the same S-03/S-04 policy production runs.
func newTestChannelService(database *db.DB) *service.ChannelService {
	return service.NewChannelService(database, service.NewPermissionService(database, nil))
}

// newTestSettingsService builds a real SettingsService over the test
// database so the settings routes exercise the same policy production runs.
func newTestSettingsService(database *db.DB) *service.SettingsService {
	return service.NewSettingsService(database)
}

// newTestRoleService builds a real RoleService over the test database so the
// role routes exercise the production authorization (MANAGE_ROLES + hierarchy)
// instead of a stub.
func newTestRoleService(database *db.DB) *service.RoleService {
	st := database
	checker := permissions.NewChecker(st)
	return service.NewRoleService(st, service.NewPermissionService(st, checker))
}

// newTestServices bundles the services NewAdminAPI routes to, each a real one
// over the test database so the routes exercise production authorization
// rather than stubs. Tests that need a service absent (the fail-closed rows)
// build the bundle and nil the one field they mean.
func newTestServices(database *db.DB) *service.Services {
	return &service.Services{
		Moderation: newTestModService(database),
		Roles:      newTestRoleService(database),
		Settings:   newTestSettingsService(database),
		Channels:   newTestChannelService(database),
		Users:      service.NewUserService(database),
		Tokens:     service.NewTokenService(database),
		Sessions:   service.NewSessionService(database),
		Auth:       service.NewAuthService(database, auth.NewRateLimiter(), nil, nil),
	}
}

// svcWithRoles is newTestServices with a caller-supplied RoleService, for the
// rows that need to observe or substitute that one service.
func svcWithRoles(database *db.DB, roles *service.RoleService) *service.Services {
	svc := newTestServices(database)
	svc.Roles = roles
	return svc
}

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_nocase ON roles(name COLLATE NOCASE);

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
    ban_expires TEXT,
    registration_status TEXT NOT NULL DEFAULT 'active',
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    unseen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_kits (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier   TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS recovery_assists (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    issued_by INTEGER NOT NULL,
    verification TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
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
    voice_max_video  INTEGER NOT NULL DEFAULT 0,
    nsfw             INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
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
    edited_at  TEXT,
    mentions_everyone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
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
    subject_token TEXT,
    actor_token TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
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
	uid, err := database.CreateUser(context.Background(), "adminuser", "$2a$12$placeholder", 1)
	if err != nil {
		t.Fatalf("CreateUser admin: %v", err)
	}

	token := "test-admin-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// createMemberUser creates a Member-role user and returns a valid bearer token.
func createMemberUser(t *testing.T, database *db.DB) string {
	t.Helper()
	// Member role (id=3) has limited permissions, not ADMINISTRATOR
	uid, err := database.CreateUser(context.Background(), "memberuser", "$2a$12$placeholder", 3)
	if err != nil {
		t.Fatalf("CreateUser member: %v", err)
	}

	token := "test-member-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1"); err != nil {
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/stats", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_Stats_Forbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createMemberUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// ─── GET /admin/api/users ─────────────────────────────────────────────────────

func TestAdminAPI_ListUsers_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// No query params — should use defaults
	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestAdminAPI_ListUsers_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/users", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── PATCH /admin/api/users/{id} ─────────────────────────────────────────────

// TestAdminAPI_PatchUser_BanHierarchy locks the W1-4 fix: the admin-auth
// perimeter alone no longer authorizes bans — ModerationService's role
// hierarchy runs on the live PATCH path, so an admin-panel actor cannot ban
// an equal- or higher-ranked user (previously any panel actor could ban the
// owner via the raw UPDATE).
func TestAdminAPI_PatchUser_BanHierarchy(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	ownerToken := createAdminUser(t, database) // Owner role (pos 100)

	// A second owner-rank user: equal position, cannot be banned.
	peerUID, err := database.CreateUser(context.Background(), "peerowner", "$2a$12$placeholder", 1)
	if err != nil {
		t.Fatalf("CreateUser peerowner: %v", err)
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(peerUID), ownerToken,
		map[string]any{"banned": true})
	if w.Code != http.StatusForbidden {
		t.Fatalf("equal-rank ban: status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(context.Background(), peerUID); u.Banned {
		t.Fatal("equal-rank target must not be banned")
	}

	// A lower-positioned role that still holds ADMINISTRATOR (panel access):
	// its holder must not be able to ban the higher-ranked owner.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'JuniorAdmin', ?, 50, 0)`,
		permissions.Administrator,
	); err != nil {
		t.Fatalf("inserting junior admin role: %v", err)
	}
	juniorUID, err := database.CreateUser(context.Background(), "junioradmin", "$2a$12$placeholder", 9)
	if err != nil {
		t.Fatalf("CreateUser junioradmin: %v", err)
	}
	juniorToken := "junior-token-" + t.Name()
	if _, err := database.CreateSession(context.Background(), juniorUID, auth.HashToken(juniorToken), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession junior: %v", err)
	}
	ownerUser, err := database.GetUserByUsername(context.Background(), "adminuser")
	if err != nil || ownerUser == nil {
		t.Fatalf("GetUserByUsername adminuser: %v", err)
	}
	w = doRequest(t, handler, http.MethodPatch, "/users/"+itoa(ownerUser.ID), juniorToken,
		map[string]any{"banned": true})
	if w.Code != http.StatusForbidden {
		t.Fatalf("junior bans owner: status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(context.Background(), ownerUser.ID); u.Banned {
		t.Fatal("owner must not be banned by a lower rank")
	}

	// Downward ban still works: junior admin (pos 50) bans a member (pos 40).
	memberUID, err := database.CreateUser(context.Background(), "banme", "$2a$12$placeholder", 3)
	if err != nil {
		t.Fatalf("CreateUser banme: %v", err)
	}
	w = doRequest(t, handler, http.MethodPatch, "/users/"+itoa(memberUID), juniorToken,
		map[string]any{"banned": true, "ban_reason": "spam"})
	if w.Code != http.StatusOK {
		t.Fatalf("junior bans member: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(context.Background(), memberUID); !u.Banned {
		t.Fatal("member should be banned by higher-ranked actor")
	}
}

func TestAdminAPI_PatchUser_BanUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Create a target user
	targetUID, _ := database.CreateUser(context.Background(), "target", "hash", 3)

	body := map[string]any{
		"banned":     true,
		"ban_reason": "spam",
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// Verify user is banned in DB
	user, err := database.GetUserByID(context.Background(), targetUID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !user.Banned {
		t.Error("user should be banned after PATCH")
	}
}

func TestAdminAPI_PatchUser_ChangeRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "rolechange", "hash", 3)

	body := map[string]any{
		"role_id": float64(2),
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.RoleID != 2 {
		t.Errorf("RoleID = %d, want 2", user.RoleID)
	}
}

func TestAdminAPI_PatchUser_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]any{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/99999", token, body)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestAdminAPI_PatchUser_InvalidID(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/users/abc", token, nil)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// ─── DELETE /admin/api/users/{id}/sessions ────────────────────────────────────

func TestAdminAPI_ForceLogout_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "logoutme", "hash", 3)
	_, _ = database.CreateSession(context.Background(), targetUID, "victim-token-hash", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}

	sessions, _ := database.GetUserSessions(context.Background(), targetUID)
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after force logout, got %d", len(sessions))
	}
}

func TestAdminAPI_ForceLogout_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodDelete, "/users/1/sessions", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── GET /admin/api/channels ──────────────────────────────────────────────────

func TestAdminAPI_ListChannels_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	_, _ = database.AdminCreateChannel(context.Background(), "general", "text", "", "", 0)

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "old", "text", "", "", 0)

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
}

// Deleting a channel must evict its voice participants BEFORE the DB row goes
// away: the voice_states FK cascade wipes the rows with the channel, after
// which neither CleanupVoiceForChannel nor the stale sweeper can see who was
// in the room — participants would keep their client voice state, voice-topic
// subscription, and LiveKit session forever, with no voice_leave broadcast.
func TestAdminAPI_DeleteChannel_CleansVoiceBeforeDBDelete(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// The minimal admin schema has no voice_states; create it with the real
	// FK cascade — the cascade IS the hazard: it wipes the rows the cleanup
	// needs if the delete runs first.
	if _, err := database.ExecContext(context.Background(), `
		CREATE TABLE voice_states (
			user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			muted      INTEGER NOT NULL DEFAULT 0,
			deafened   INTEGER NOT NULL DEFAULT 0,
			speaking   INTEGER NOT NULL DEFAULT 0,
			joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
			camera     INTEGER NOT NULL DEFAULT 0,
			screenshare INTEGER NOT NULL DEFAULT 0,
			server_muted INTEGER NOT NULL DEFAULT 0,
			server_deafened INTEGER NOT NULL DEFAULT 0
		)`); err != nil {
		t.Fatalf("create voice_states: %v", err)
	}

	chID, _ := database.AdminCreateChannel(context.Background(), "del-voice", "voice", "", "", 0)
	uid, _ := database.CreateUser(context.Background(), "del-voice-user", "hash", 1)
	if err := database.JoinVoiceChannel(context.Background(), uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	rowsAtCleanup := -1
	hub.onVoiceCleanup = func(channelID int64) {
		states, err := database.GetChannelVoiceStates(context.Background(), channelID)
		if err != nil {
			t.Errorf("GetChannelVoiceStates during cleanup: %v", err)
		}
		rowsAtCleanup = len(states)
	}

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	if len(hub.voiceCleanupIDs) != 1 || hub.voiceCleanupIDs[0] != chID {
		t.Fatalf("CleanupVoiceForChannel calls = %v, want exactly [%d]", hub.voiceCleanupIDs, chID)
	}
	if rowsAtCleanup != 1 {
		t.Errorf("voice_states rows visible at cleanup time = %d, want 1 (cleanup must run before the delete cascade)", rowsAtCleanup)
	}
}

// A voice_join racing the delete window must be refused, not silently create
// a voice_states row the FK cascade then wipes out from under it (OC-0035):
// CleanupVoiceForChannel snapshots participants ONCE, up front, so a join
// that lands after that snapshot but before AdminDeleteChannel's cascade
// leaves the joiner's hub-side voice state and LiveKit session orphaned with
// nothing left to clean it up. handleDeleteChannel must close that window the
// same way the archive path does (handlePatchChannel): persist archived=true
// BEFORE evicting current participants, so voice_join's archived gate
// (ws/voice_join.go) refuses any concurrent join that reads the channel row
// during cleanup.
func TestAdminAPI_DeleteChannel_ArchivesBeforeVoiceCleanup(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-race", "voice", "", "", 0)

	archivedAtCleanup := false
	hub.onVoiceCleanup = func(channelID int64) {
		ch, err := database.GetChannel(context.Background(), channelID)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel during cleanup: %v", err)
		}
		archivedAtCleanup = ch.Archived
	}

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	if !archivedAtCleanup {
		t.Errorf("channel.Archived at CleanupVoiceForChannel time = false, want true — a concurrent voice_join would not be refused by the archived gate")
	}
}

func TestAdminAPI_DeleteChannel_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/channels/99999", token, nil)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ─── GET /admin/api/audit-log ─────────────────────────────────────────────────

func TestAdminAPI_AuditLog_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	uid, _ := database.CreateUser(context.Background(), "actor", "hash", 1)
	_ = database.LogAudit(context.Background(), uid, "TEST_ACTION", "user", uid, "detail")

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	val, err := database.GetSetting(context.Background(), "server_name")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val != "Updated Server" {
		t.Errorf("server_name = %q, want 'Updated Server'", val)
	}
}

func TestAdminAPI_PatchSettings_InvalidBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	// Admin (role 2) can authenticate but is not Owner (role 1, position 100)
	adminUID, _ := database.CreateUser(context.Background(), "adminonly", "hash", 2)
	token := "admin-only-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	// Should be forbidden — not Owner role
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestAdminAPI_Backup_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Create a target user to act on.
	targetUID, _ := database.CreateUser(context.Background(), "ctxtarget", "hash", 3)

	body := map[string]any{"banned": true, "ban_reason": "context test"}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// The audit log should have a non-zero actor_id showing the actor was
	// resolved (not 0, which would indicate a failed context lookup).
	entries, err := database.GetAuditLog(context.Background(), 10, 0)
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "logoutctx", "hash", 3)
	_, _ = database.CreateSession(context.Background(), targetUID, "victim-hash-ctx", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	entries, err := database.GetAuditLog(context.Background(), 10, 0)
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]string{
		"server_name":  "valid",
		"injected_key": "should block the whole request",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	// The valid key must NOT have been written because the request was rejected.
	val, err := database.GetSetting(context.Background(), "server_name")
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
		"registration_mode",
		"backup_schedule",
		"backup_retention",
	}

	// Boolean-typed settings require valid boolean values; others accept any string.
	booleanKeys := map[string]bool{"require_2fa": true}

	for _, key := range whitelistedKeys {
		t.Run(key, func(t *testing.T) {
			database := openAdminTestDB(t)
			handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
			token := createAdminUser(t, database)

			value := "testvalue"
			if booleanKeys[key] {
				value = "0"
			}
			if key == "registration_mode" {
				value = "closed"
			}
			body := map[string]string{key: value}
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]string{}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_PatchSettings_RejectsRequire2FAWhenUsersNotEnrolled(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_PatchSettings_AllowsRequire2FAWhenAllUsersEnrolledAndRegistrationClosed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = 1`, "JBSWY3DPEHPK3PXP"); err != nil {
		t.Fatalf("enroll admin user: %v", err)
	}

	body := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_PatchSettings_RejectsInvalidBooleanValue(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]string{
		"require_2fa": "banana",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_PatchSettings_UnrelatedKeyNotBlockedByRequire2FAGate verifies
// that the 2FA-enrollment precondition only applies to requests that actually
// change require_2fa. Once require_2fa is already on, a later PATCH that
// leaves it untouched (e.g. only motd) must not be rejected just because some
// user without TOTP now exists (targetBoolSetting falls back to the stored
// value, which is still "true", so validateRequire2FAUpdate must not
// re-run the enrollment count for a key nobody asked to change).
func TestAdminAPI_PatchSettings_UnrelatedKeyNotBlockedByRequire2FAGate(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Enroll the admin so the initial require_2fa enable succeeds.
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = 1`, "JBSWY3DPEHPK3PXP"); err != nil {
		t.Fatalf("enroll admin user: %v", err)
	}

	enableBody := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, enableBody)
	if w.Code != http.StatusOK {
		t.Fatalf("enabling require_2fa: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// A user without TOTP now exists (e.g. created after the gate closed, or
	// unbanned once a temporary ban lapsed) — CountUsersWithoutTOTP is now > 0.
	if _, err := database.CreateUser(context.Background(), "no-totp-user", "hash", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// An unrelated settings PATCH that never mentions require_2fa must still
	// succeed and actually write the change.
	motdBody := map[string]string{"motd": "Back online"}
	w = doRequest(t, handler, http.MethodPatch, "/settings", token, motdBody)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	val, err := database.GetSetting(context.Background(), "motd")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val != "Back online" {
		t.Errorf("motd = %q, want %q (unrelated PATCH must not be blocked by the require_2fa enrollment gate)", val, "Back online")
	}
}

// ─── Fix 2.1: Sensitive field redaction ──────────────────────────────────────

// TestAdminAPI_ListUsers_NoPasswordHash verifies that GET /users does not
// expose the PasswordHash field in any returned user object.
func TestAdminAPI_ListUsers_NoPasswordHash(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	// Create a second user so the list is non-trivial.
	_, _ = database.CreateUser(context.Background(), "plainuser", "supersecretbcrypthash", 3)

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "patchvictim", "topsecretbcrypt", 3)

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	targetUID, _ := database.CreateUser(context.Background(), "patchtotp", "hash", 3)

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
	restartCalls        []restartCall
	channelCreates      []*db.Channel
	channelUpdates      []*db.Channel
	channelDeleteIDs    []int64
	memberBanIDs        []int64
	memberUpdates       []memberUpdateCall
	visibilityRefreshes []*db.Channel
	// allVisibilityRefreshes counts RefreshAllChannelVisibility calls — the
	// role-edit equivalent of visibilityRefreshes.
	allVisibilityRefreshes int
	rolesUpdates           [][]*db.Role
	clientCount            int
	voiceCleanupIDs        []int64
	// onVoiceCleanup lets a test observe DB state at cleanup time (ordering
	// vs. the channel-delete cascade).
	onVoiceCleanup func(channelID int64)
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

func (m *mockHub) CleanupVoiceForChannel(channelID int64) {
	m.voiceCleanupIDs = append(m.voiceCleanupIDs, channelID)
	if m.onVoiceCleanup != nil {
		m.onVoiceCleanup(channelID)
	}
}

func (m *mockHub) BroadcastMemberBan(userID int64) {
	m.memberBanIDs = append(m.memberBanIDs, userID)
}

func (m *mockHub) BroadcastMemberUpdate(userID int64, roleName string) {
	m.memberUpdates = append(m.memberUpdates, memberUpdateCall{userID, roleName})
}

func (m *mockHub) RefreshChannelVisibility(ch *db.Channel) {
	m.visibilityRefreshes = append(m.visibilityRefreshes, ch)
}

func (m *mockHub) RefreshAllChannelVisibility() {
	m.allVisibilityRefreshes++
}

func (m *mockHub) BroadcastRolesUpdate(roles []*db.Role) {
	m.rolesUpdates = append(m.rolesUpdates, roles)
}

func (m *mockHub) ClientCount() int {
	return m.clientCount
}

func TestAdminAPI_CreateChannel_BroadcastsChannelCreate(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "before", "text", "", "", 0)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "patchme", "text", "", "", 0)
	body := map[string]any{"name": "patched"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestAdminAPI_DeleteChannel_BroadcastsChannelDelete(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "delete-me", "text", "", "", 0)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-no-hub", "text", "", "", 0)
	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
}

// OC-0010: handleDeleteChannel commits archived=1 as its own transaction and
// evicts voice participants BEFORE calling AdminDeleteChannel — all on
// r.Context(). If the admin's browser aborts the request in that window (tab
// close, navigation, network blip), r.Context() is canceled and the final
// AdminDeleteChannel call fails with context.Canceled: the handler 500s, but
// the archive and the voice eviction already committed. Nothing reverts the
// archive, nothing broadcasts it, and no audit row is written — the channel
// is left silently archived (writes refused, channel_focus 403s) while every
// connected client still shows it live in the sidebar.
//
// This reproduces the race deterministically by canceling the request
// context from inside CleanupVoiceForChannel — exactly the call the repro
// says the real-world cancellation lands during — instead of relying on
// timing. The fix must make the delete tolerate a caller cancellation that
// arrives after the archive has already committed.
func TestAdminAPI_DeleteChannel_SurvivesContextCancelAfterArchiveCommits(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-cancel-race", "text", "", "", 0)

	ctx, cancel := context.WithCancel(context.Background())
	// Fires synchronously inside handleDeleteChannel, after the archive
	// commit but before the final AdminDeleteChannel call — the same window
	// the repro describes a browser abort landing in.
	hub.onVoiceCleanup = func(int64) {
		cancel()
	}

	req := httptest.NewRequest(http.MethodDelete, "/channels/"+itoa(chID), nil)
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (delete must survive a caller cancellation that arrives after the archive already committed); body: %s", w.Code, w.Body.String())
	}

	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != nil {
		t.Errorf("channel %d still exists after a reported-successful delete: %+v", chID, ch)
	}

	if len(hub.channelDeleteIDs) != 1 || hub.channelDeleteIDs[0] != chID {
		t.Errorf("BroadcastChannelDelete calls = %v, want exactly [%d]", hub.channelDeleteIDs, chID)
	}
}

// ─── API tokens: /admin/api/tokens ───────────────────────────────────────────

func TestAdminAPI_CreateAPIToken_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database) // Owner role

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "ci-bot"})
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	raw, _ := resp["token"].(string)
	if raw == "" {
		t.Fatal("response missing raw token")
	}
	// The minted token must actually authenticate as the owner it was bound to.
	user, _, _, err := auth.ResolveTokenHash(context.Background(), database, auth.HashToken(raw))
	if err != nil || user == nil {
		t.Fatalf("minted token does not resolve: user=%v err=%v", user, err)
	}
	// And it must be listed, without any hash leaking.
	tokens, _ := database.ListAPITokens(context.Background())
	if len(tokens) != 1 || tokens[0].Label != "ci-bot" {
		t.Fatalf("expected 1 token labelled ci-bot, got %+v", tokens)
	}
}

func TestAdminAPI_CreateAPIToken_MissingLabel(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "  "})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_CreateAPIToken_NegativeExpiresHours pins OC-0145: a caller that
// asks for a bounded credential (negative expires_hours) must not silently
// receive a permanent one. The `> 0` check in handleCreateAPIToken sends any
// negative value down the nil-expiresAt ("never expires") branch.
func TestAdminAPI_CreateAPIToken_NegativeExpiresHours(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "neg-hours", "expires_hours": -1})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	tokens, _ := database.ListAPITokens(context.Background())
	for _, tok := range tokens {
		if tok.Label == "neg-hours" {
			t.Fatalf("negative expires_hours must not mint a token, got %+v", tok)
		}
	}
}

// TestAdminAPI_CreateAPIToken_HugeExpiresHours pins OC-0145's overflow half: a
// huge expires_hours must not silently overflow time.Duration into a past
// timestamp and hand back a token that 401s on first use.
func TestAdminAPI_CreateAPIToken_HugeExpiresHours(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "huge-hours", "expires_hours": 3000000})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	tokens, _ := database.ListAPITokens(context.Background())
	for _, tok := range tokens {
		if tok.Label == "huge-hours" {
			t.Fatalf("out-of-range expires_hours must not mint a token, got %+v", tok)
		}
	}
}

func TestAdminAPI_ListAPITokens_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	hash := auth.HashToken("raw-secret-value")
	if _, err := database.CreateAPIToken(context.Background(), 1, hash, "seeded", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/tokens", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), hash) {
		t.Error("GET /tokens leaked the token hash")
	}
	var tokens []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &tokens); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(tokens) != 1 {
		t.Fatalf("expected 1 token, got %d", len(tokens))
	}
	if _, ok := tokens[0]["created_at"]; !ok {
		t.Error("token row missing snake_case 'created_at' field")
	}
}

func TestAdminAPI_RevokeAPIToken_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	hash := auth.HashToken("revoke-me")
	id, err := database.CreateAPIToken(context.Background(), 1, hash, "doomed", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete, "/tokens/"+itoa(id), token, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	// A revoked token must no longer authenticate.
	active, _ := database.GetActiveAPIToken(context.Background(), hash)
	if active != nil {
		t.Error("token still active after revoke")
	}
}

func TestAdminAPI_RevokeAPIToken_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/tokens/99999", token, nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// TestAdminAPI_Tokens_RequiresOwner locks the Owner gate: a non-Owner admin can
// authenticate to /admin/api but must not mint API tokens (the credential that
// survives password change + bulk logout).
func TestAdminAPI_Tokens_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	adminUID, _ := database.CreateUser(context.Background(), "adminonly", "hash", 2) // Admin, not Owner
	token := "admin-only-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/tokens", token, map[string]any{"label": "nope"})
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_Tokens_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/tokens", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// itoa converts an int64 to a string for use in URL paths.
func itoa(n int64) string {
	return fmt.Sprint(n)
}

// TestAdminAPI_NilServiceBundleFailsClosed pins the distinction
// adminRequiredServices draws. A nil service the ROUTER dereferences has no
// request-time branch left to fail closed in — the handler would panic on the
// first request — so the constructor builds those from the handle it already
// holds. A nil service only a HANDLER dereferences stays nil, because the
// handler checks it and answers 500; those refusals are pinned elsewhere and
// must keep being exercised.
//
// Reported by a review bot on the user and auth families: /stats, /users and
// /tokens had moved off the raw handle without the guard moving with them, so
// the fail-closed posture this constructor documents had quietly stopped being
// true for exactly those routes.
func TestAdminAPI_NilServiceBundleFailsClosed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, nil)
	token := createAdminUser(t, database) // Owner role — reaches the token routes too

	for _, tc := range []struct {
		name, method, path string
		body               any
	}{
		{"stats", http.MethodGet, "/stats", nil},
		{"users", http.MethodGet, "/users", nil},
		{"tokens", http.MethodGet, "/tokens", nil},
		{"setup status", http.MethodGet, "/setup/status", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// A panic here fails the test outright, which is the point: the
			// route must answer something, whatever it answers.
			w := doRequest(t, handler, tc.method, tc.path, token, tc.body)
			if w.Code >= 500 {
				t.Errorf("%s %s = %d with a nil bundle; want a real answer, not a server fault: %s",
					tc.method, tc.path, w.Code, w.Body.String())
			}
		})
	}
}
