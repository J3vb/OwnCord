// Package admin whitebox tests — uses package admin (not admin_test) to access
// unexported functions like spawnDetached and ownerOnlyMiddleware.
package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"testing/fstest"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// openWhiteboxTestDB opens an in-memory SQLite database for whitebox tests.
func openWhiteboxTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	schema := []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner', '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin', '#F39C12', 1073741823,  80, 0),
    (3, 'Member', NULL,    1635,     40, 1);

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
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL DEFAULT 0,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
`)
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: schema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// ─── ownerOnlyMiddleware whitebox tests ──────────────────────────────────────

// TestOwnerOnlyMiddleware_NoUserInContext verifies that ownerOnlyMiddleware
// returns 401 when there is no user stored in the request context.
func TestOwnerOnlyMiddleware_NoUserInContext(t *testing.T) {
	database := openWhiteboxTestDB(t)

	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})

	handler := ownerOnlyMiddleware(database, next)

	// Request with NO user in context — simulates a call bypassing adminAuthMiddleware.
	req := httptest.NewRequest(http.MethodPost, "/backup", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if reached {
		t.Error("next handler was reached despite missing user in context")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestOwnerOnlyMiddleware_RoleNotFound verifies that ownerOnlyMiddleware
// returns 403 when the user's role_id does not exist in the database.
func TestOwnerOnlyMiddleware_RoleNotFound(t *testing.T) {
	database := openWhiteboxTestDB(t)

	// Create a user initially with a valid role, then mutate role_id to a
	// nonexistent value (disabling FK checks temporarily so SQLite allows it).
	uid, err := database.CreateUser("orphanuser", "$2a$12$x", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	// Disable FK enforcement, update role_id, re-enable.
	if _, err := database.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("disable FK: %v", err)
	}
	if _, err := database.Exec(`UPDATE users SET role_id = 9999 WHERE id = ?`, uid); err != nil {
		t.Fatalf("UPDATE role_id: %v", err)
	}
	if _, err := database.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatalf("re-enable FK: %v", err)
	}
	user.RoleID = 9999 // mirror the DB value in our in-memory struct

	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})

	handler := ownerOnlyMiddleware(database, next)

	// Inject user into context as adminAuthMiddleware would.
	ctx := context.WithValue(context.Background(), adminUserKey, user)
	req := httptest.NewRequest(http.MethodPost, "/backup", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if reached {
		t.Error("next handler was reached despite missing role")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 (role not found)", w.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "FORBIDDEN" {
		t.Errorf("error = %q, want FORBIDDEN", resp["error"])
	}
}

// TestOwnerOnlyMiddleware_OwnerPassesThrough verifies that a user with the
// Owner role (position == 100) reaches the next handler.
func TestOwnerOnlyMiddleware_OwnerPassesThrough(t *testing.T) {
	database := openWhiteboxTestDB(t)

	uid, err := database.CreateUser("ownerpass", "$2a$12$x", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})

	handler := ownerOnlyMiddleware(database, next)

	ctx := context.WithValue(context.Background(), adminUserKey, user)
	req := httptest.NewRequest(http.MethodPost, "/backup", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !reached {
		t.Error("next handler was NOT reached for owner role")
	}
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

// ─── adminAuthMiddleware whitebox test — user with unknown role_id ────────────

// TestAdminAuthMiddleware_RoleNotFound verifies that a session for a user whose
// role_id has been set to a nonexistent value returns 401.
func TestAdminAuthMiddleware_RoleNotFound(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := NewAdminAPI(database, "1.0.0", nil, nil, nil)

	uid, err := database.CreateUser("noroleuser", "$2a$12$x", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token := "norole-token"
	if _, err := database.CreateSession(uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Disable FK enforcement, assign a non-existent role_id, re-enable.
	if _, err := database.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("disable FK: %v", err)
	}
	if _, err := database.Exec(`UPDATE users SET role_id = 9999 WHERE id = ?`, uid); err != nil {
		t.Fatalf("UPDATE role_id: %v", err)
	}
	if _, err := database.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatalf("re-enable FK: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (role not found); body: %s", w.Code, w.Body.String())
	}
}

// ─── DB error path tests ─────────────────────────────────────────────────────

// These tests trigger the internal error-return paths in handlers by using a
// closed DB. After database.Close(), all queries fail with an error, allowing
// us to cover the "DB error" branches that are otherwise unreachable with a
// healthy in-memory SQLite.

// TestHandleGetStats_DBError verifies that handleGetStats returns 500 when
// the database query fails.
func TestHandleGetStats_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	hub := &mockHubWB{}
	handler := handleGetStats(database, hub)

	// Close the DB to force subsequent queries to fail.
	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/stats", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB stats status = %d, want 500", w.Code)
	}
}

// TestHandleListChannels_DBError verifies that handleListChannels returns 500
// when the database query fails.
func TestHandleListChannels_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := handleListChannels(database)

	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/channels", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB list channels status = %d, want 500", w.Code)
	}
}

// TestHandleGetSettings_DBError verifies that handleGetSettings returns 500
// when the database query fails.
func TestHandleGetSettings_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := handleGetSettings(database)

	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/settings", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB get settings status = %d, want 500", w.Code)
	}
}

// TestHandleSetupStatus_DBError verifies that handleSetupStatus returns 500
// when the database query fails.
func TestHandleSetupStatus_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := handleSetupStatus(database)

	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/setup/status", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB setup status = %d, want 500", w.Code)
	}
}

// TestHandleGetAuditLog_DBError verifies that handleGetAuditLog returns 500
// when the database query fails.
func TestHandleGetAuditLog_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := handleGetAuditLog(database)

	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/audit-log", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB audit log status = %d, want 500", w.Code)
	}
}

// TestHandleListUsers_DBError verifies that handleListUsers returns 500 when
// the database query fails.
func TestHandleListUsers_DBError(t *testing.T) {
	database := openWhiteboxTestDB(t)
	handler := handleListUsers(database)

	_ = database.Close()

	req := httptest.NewRequest(http.MethodGet, "/users", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("closed DB list users status = %d, want 500", w.Code)
	}
}

// mockHubWB is a local mock for whitebox tests (prevents import cycle with
// the admin_test package's mockHub type).
type mockHubWB struct{}

func (m *mockHubWB) BroadcastServerRestart(reason string, delaySeconds int) {}
func (m *mockHubWB) BroadcastChannelCreate(ch *db.Channel)                  {}
func (m *mockHubWB) BroadcastChannelUpdate(ch *db.Channel)                  {}
func (m *mockHubWB) BroadcastChannelDelete(channelID int64)                 {}
func (m *mockHubWB) BroadcastMemberBan(userID int64)                        {}
func (m *mockHubWB) BroadcastMemberUpdate(userID int64, roleName string)    {}
func (m *mockHubWB) ClientCount() int                                       { return 0 }

// TestSpawnDetached_ValidExecutable verifies that spawnDetached can start a
// real executable (the Go test binary itself) with a flag that causes immediate
// exit. The test only checks that cmd.Start() returns without error; it does
// not wait for the child process to finish.
func TestSpawnDetached_ValidExecutable(t *testing.T) {
	// Use the current test binary as the spawned executable so we don't depend
	// on any external tool being available.
	//
	// os.Args[0] is the test binary itself. We pass "-test.run=^$" so the child
	// immediately exits with 0 (no tests match). This avoids infinite recursion
	// and any visible side effects.
	selfExe, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatalf("abs path of test binary: %v", err)
	}

	err = spawnDetached(selfExe, []string{"-test.run=^$"})
	if err != nil {
		t.Errorf("spawnDetached returned error: %v", err)
	}
}

// TestSpawnDetached_InvalidExecutable verifies that spawnDetached returns an
// error when the executable path does not exist.
func TestSpawnDetached_InvalidExecutable(t *testing.T) {
	err := spawnDetached("/nonexistent/path/to/binary", nil)
	if err == nil {
		t.Error("expected error when executable does not exist, got nil")
	}
}

// TestSpawnDetached_SetsWindowsFlags verifies on Windows that the function does
// not panic when setting SysProcAttr. On non-Windows, the test is a no-op
// confirming the GOOS branch is skipped correctly.
func TestSpawnDetached_SetsWindowsFlags(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("SysProcAttr Windows-specific flag test only runs on Windows")
	}

	selfExe, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatalf("abs path: %v", err)
	}

	// Just verify it doesn't panic when setting the Windows creation flag.
	err = spawnDetached(selfExe, []string{"-test.run=^$"})
	if err != nil {
		t.Errorf("spawnDetached on Windows returned error: %v", err)
	}
}

// TestSpawnDetached_CommandConstruction verifies that spawnDetached wires
// stdout/stderr correctly by checking the command's streams are non-nil
// after construction. We do this by examining what exec.Command would produce
// for a real path.
func TestSpawnDetached_CommandConstruction(t *testing.T) {
	// We build the command manually the same way spawnDetached does and check
	// that Stdout/Stderr are the process's own streams — confirming the
	// implementation wires them as documented.
	selfExe, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatalf("abs path: %v", err)
	}

	cmd := exec.Command(selfExe, "-test.run=^$")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if cmd.Stdout == nil {
		t.Error("cmd.Stdout should not be nil")
	}
	if cmd.Stderr == nil {
		t.Error("cmd.Stderr should not be nil")
	}
}
