package admin_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/updater"
)

// ─── NewHandler ───────────────────────────────────────────────────────────────

// TestNewHandler_ReturnsNonNilHandler verifies that NewHandler returns a non-nil
// http.Handler with all dependencies wired.
func TestNewHandler_ReturnsNonNilHandler(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil)
	if h == nil {
		t.Fatal("NewHandler returned nil handler")
	}
}

// TestNewHandler_ServesStaticRoot verifies that GET / on the returned handler
// responds with 200 and HTML content (the embedded admin SPA).
func TestNewHandler_ServesStaticRoot(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GET / status = %d, want 200", w.Code)
	}

	ct := w.Header().Get("Content-Type")
	if ct == "" {
		t.Error("Content-Type header missing on / response")
	}

	body := w.Body.String()
	if !strings.Contains(body, "api('POST','/logs/ticket')") {
		t.Error("admin root should request log stream tickets before opening EventSource")
	}
	if !strings.Contains(body, "/admin/api/logs/stream?ticket=") {
		t.Error("admin root should connect to log stream with a ticket query parameter")
	}
	if strings.Contains(body, "/admin/api/logs/stream?token=") {
		t.Error("admin root should not use the deprecated token-based log stream URL")
	}
}

// TestNewHandler_SetsCSPOnRoot verifies that the root path response includes a
// Content-Security-Policy header allowing inline scripts and styles.
func TestNewHandler_SetsCSPOnRoot(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	csp := w.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Error("Content-Security-Policy header missing on / response")
	}
}

// TestNewHandler_APIRoutesMounted verifies that /api/* routes are reachable
// through the NewHandler-returned handler (setup/status endpoint is unauthenticated).
func TestNewHandler_APIRoutesMounted(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/setup/status", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	// 200 because no users exist yet — setup is needed
	if w.Code != http.StatusOK {
		t.Errorf("GET /api/setup/status status = %d, want 200", w.Code)
	}
}

// TestNewHandler_AuthProtectedRoute verifies that authenticated routes under
// /api require a valid token.
func TestNewHandler_AuthProtectedRoute(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil)

	// /api/stats requires authentication
	req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated /api/stats status = %d, want 401", w.Code)
	}
}

// TestNewHandler_WithUpdater verifies that NewHandler works correctly when an
// updater is provided.
func TestNewHandler_WithUpdater(t *testing.T) {
	database := openAdminTestDB(t)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, u, nil)
	if h == nil {
		t.Fatal("NewHandler with updater returned nil handler")
	}
}

// ─── Handler (deprecated) ────────────────────────────────────────────────────

// TestHandler_ReturnsNonNil verifies the deprecated Handler() function returns
// a non-nil http.Handler (it serves the embedded static files).
func TestHandler_ReturnsNonNil(t *testing.T) {
	h := admin.Handler()
	if h == nil {
		t.Fatal("Handler() returned nil")
	}
}

// TestHandler_ServesEmbeddedFiles verifies that the deprecated Handler() serves
// a response (the embedded static FS) without panicking.
func TestHandler_ServesEmbeddedFiles(t *testing.T) {
	h := admin.Handler()

	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	// http.FileServer returns 200 for a found file or 301/404 for others;
	// the important thing is it doesn't panic and returns a valid HTTP status.
	if w.Code == 0 {
		t.Error("Handler() response has zero status code")
	}
}

// ─── ownerOnlyMiddleware (tested via API endpoints that use it) ───────────────

// TestOwnerOnlyMiddleware_OwnerAllowed verifies that a user with Owner role
// (position == 100) can reach backup endpoints.
func TestOwnerOnlyMiddleware_OwnerAllowed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil)

	// createAdminUser creates an Owner-role user (role_id=1, position=100)
	ownerToken := createAdminUser(t, database)

	// Use a temp dir so the backup handler can create data/backups without
	// polluting the repo working directory.
	tmpDir := t.TempDir()
	origDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatalf("os.Chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(origDir) })

	w := doRequest(t, handler, http.MethodPost, "/backup", ownerToken, nil)

	// Owner should pass ownerOnlyMiddleware and reach handleBackup.
	// handleBackup itself may return 200 (success) or 500 (if BackupTo fails in
	// test environment), but it must not return 403 (forbidden).
	if w.Code == http.StatusForbidden {
		t.Errorf("Owner user got 403 Forbidden from backup endpoint — ownerOnlyMiddleware incorrectly blocked owner")
	}
}

// TestOwnerOnlyMiddleware_AdminDenied verifies that a user with Admin role
// (position < 100) cannot reach owner-only endpoints.
func TestOwnerOnlyMiddleware_AdminDenied(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil)

	// Create admin user (role_id=2, position=80)
	adminUID, _ := database.CreateUser("middlewareadmin", "hash", 2)
	token := "mw-admin-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("Admin user status = %d, want 403", w.Code)
	}
}

// TestOwnerOnlyMiddleware_MemberDenied verifies that a Member-role user cannot
// reach owner-only endpoints.
func TestOwnerOnlyMiddleware_MemberDenied(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil)

	memberToken := createMemberUser(t, database)

	// Members don't have ADMINISTRATOR bit so they get 403 from adminAuthMiddleware
	// before reaching ownerOnlyMiddleware — result is still non-200.
	w := doRequest(t, handler, http.MethodPost, "/backup", memberToken, nil)

	if w.Code == http.StatusOK {
		t.Error("Member user got 200 from owner-only backup endpoint")
	}
}

// TestOwnerOnlyMiddleware_Unauthenticated verifies that a missing token is
// rejected before reaching ownerOnlyMiddleware.
func TestOwnerOnlyMiddleware_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil)

	w := doRequest(t, handler, http.MethodPost, "/backup", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated backup request status = %d, want 401", w.Code)
	}
}
