package admin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

// ─── NewHandler ───────────────────────────────────────────────────────────────

// TestNewHandler_ReturnsNonNilHandler verifies that NewHandler returns a non-nil
// http.Handler with all dependencies wired.
func TestNewHandler_ReturnsNonNilHandler(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	if h == nil {
		t.Fatal("NewHandler returned nil handler")
	}
}

// TestNewHandler_ServesStaticRoot verifies that GET / on the returned handler
// responds with 200 and HTML content (the embedded admin SPA).
func TestNewHandler_ServesStaticRoot(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	if !strings.Contains(w.Body.String(), `<script src="/admin/js/core.js"></script>`) {
		t.Error("admin root does not load the panel's core script")
	}
}

// panelAssetRe matches the stylesheet and scripts index.html loads. They are
// absolute because the panel is served at both /admin and /admin/, and a
// relative path would resolve to /admin.css from the first.
var panelAssetRe = regexp.MustCompile(`(?:src|href)="/admin/([^"]+\.(?:css|js))"`)

// TestNewHandler_ServesPanelAssets verifies that every stylesheet and script
// index.html references is served from the embedded tree with its type, so a
// renamed or unembedded file fails here rather than as a blank panel. The
// handler is mounted at /admin exactly as api/router.go mounts it: chi's Mount
// leaves the prefix on URL.Path, which an unmounted request would not show.
func TestNewHandler_ServesPanelAssets(t *testing.T) {
	database := openAdminTestDB(t)
	h := chi.NewRouter()
	h.Mount("/admin", admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database)))

	index := httptest.NewRecorder()
	h.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/admin", nil))
	assets := panelAssetRe.FindAllStringSubmatch(index.Body.String(), -1)
	if len(assets) < 2 {
		t.Fatalf("index.html references %d stylesheets/scripts, want the stylesheet and the scripts", len(assets))
	}
	for _, m := range assets {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin/"+m[1], nil))
		if w.Code != http.StatusOK {
			t.Errorf("GET /admin/%s status = %d, want 200", m[1], w.Code)
			continue
		}
		want := "text/javascript"
		if strings.HasSuffix(m[1], ".css") {
			want = "text/css"
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, want) {
			t.Errorf("GET /admin/%s Content-Type = %q, want %s", m[1], ct, want)
		}
	}

	for _, path := range []string{"/admin/js", "/admin/js/", "/admin/nope.js", "/admin/js/../admin.go"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", path, w.Code)
		}
	}

	// The log viewer is served as a script now, not inside the document.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin/js/operations.js", nil))
	body := w.Body.String()
	if !strings.Contains(body, "api('POST','/logs/ticket')") {
		t.Error("admin panel should request log stream tickets before opening EventSource")
	}
	if !strings.Contains(body, "/admin/api/logs/stream?ticket=") {
		t.Error("admin panel should connect to log stream with a ticket query parameter")
	}
	if strings.Contains(body, "/admin/api/logs/stream?token=") {
		t.Error("admin panel should not use the deprecated token-based log stream URL")
	}
}

// TestNewHandler_SetsCSPOnRoot verifies that the admin document's
// Content-Security-Policy runs only the panel's own script files: no inline
// script, no eval. Inline styles stay allowed while the markup carries style=
// attributes.
func TestNewHandler_SetsCSPOnRoot(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	csp := w.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy header missing on / response")
	}
	directives := map[string]string{}
	for d := range strings.SplitSeq(csp, ";") {
		name, value, _ := strings.Cut(strings.TrimSpace(d), " ")
		directives[name] = value
	}
	for name, want := range map[string]string{
		"default-src": "'self'",
		"script-src":  "'self'",
		"img-src":     "'self' blob:",
		"style-src":   "'self' 'unsafe-inline'",
	} {
		if got, ok := directives[name]; !ok || got != want {
			t.Errorf("CSP %s = %q, want %q (full policy %q)", name, got, want, csp)
		}
	}
	for _, name := range []string{"script-src-elem", "script-src-attr"} {
		if v, ok := directives[name]; ok {
			t.Errorf("CSP carries %s %q, which would override script-src", name, v)
		}
	}
}

// The CSP above is only safe to ship if the panel needs nothing it forbids:
// an inline handler or inline <script> would be refused by the browser, and
// the control it wires would silently do nothing. Controls name a handler in
// data-action (static/js/core.js) instead.
var (
	inlineHandlerRe = regexp.MustCompile(`\son[a-z]+\s*=\s*["']`)
	scriptTagRe     = regexp.MustCompile(`<script\b[^>]*>`)
)

func TestAdminPanelHasNoInlineScript(t *testing.T) {
	source := adminPanelSource(t)

	if m := inlineHandlerRe.FindString(source); m != "" {
		t.Errorf("inline event handler attribute %q; use data-action and register the handler in ACTIONS", m)
	}
	for _, tag := range scriptTagRe.FindAllString(source, -1) {
		if !strings.Contains(tag, " src=") {
			t.Errorf("inline script element %q; CSP script-src 'self' refuses it", tag)
		}
	}
	if strings.Contains(source, "javascript:") {
		t.Error("javascript: URL; CSP script-src 'self' refuses it")
	}
}

// TestNewHandler_APIRoutesMounted verifies that /api/* routes are reachable
// through the NewHandler-returned handler (setup/status endpoint is unauthenticated).
func TestNewHandler_APIRoutesMounted(t *testing.T) {
	database := openAdminTestDB(t)
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	h := admin.NewHandler(database, "1.0.0", &mockHub{}, u, nil, nil, nil, newTestServices(database))
	if h == nil {
		t.Fatal("NewHandler with updater returned nil handler")
	}
}

// ─── ownerOnlyMiddleware (tested via API endpoints that use it) ───────────────

// TestOwnerOnlyMiddleware_OwnerAllowed verifies that a user with Owner role
// (position == 100) can reach backup endpoints.
func TestOwnerOnlyMiddleware_OwnerAllowed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	admin.SetBackupBaseDir(filepath.Join(tmpDir, "data", "backups"))
	t.Cleanup(func() {
		_ = os.Chdir(origDir)
		admin.SetBackupBaseDir(filepath.Join(origDir, "data", "backups"))
	})

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	// Create admin user (role_id=2, position=80)
	adminUID, _ := database.CreateUser(context.Background(), "middlewareadmin", "hash", 2)
	token := "mw-admin-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("Admin user status = %d, want 403", w.Code)
	}
}

// TestOwnerOnlyMiddleware_MemberDenied verifies that a Member-role user cannot
// reach owner-only endpoints.
func TestOwnerOnlyMiddleware_MemberDenied(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodPost, "/backup", "", nil)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated backup request status = %d, want 401", w.Code)
	}
}
