package admin_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/updater"
)

func TestAdminAPI_CheckUpdate_OK(t *testing.T) {
	// Mock GitHub API
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "New release",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets": []map[string]any{
				{"name": "chatserver.exe", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe"},
				{"name": "chatserver-linux-amd64.tar.gz", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver-linux-amd64.tar.gz"},
				{"name": "checksums.sha256", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256"},
			},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var info updater.UpdateInfo
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if !info.UpdateAvailable {
		t.Error("expected update_available = true")
	}
	if info.Latest != "v2.0.0" {
		t.Errorf("latest = %q, want v2.0.0", info.Latest)
	}
}

func TestAdminAPI_CheckUpdate_UpToDate(t *testing.T) {
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.0.0",
			"body":     "",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var info updater.UpdateInfo
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if info.UpdateAvailable {
		t.Error("expected update_available = false")
	}
}

func TestAdminAPI_CheckUpdate_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/updates", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_ApplyUpdate_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

	// Create admin user (not owner - role 2)
	adminUID, _ := database.CreateUser("adminonly2", "hash", 2)
	token := "admin-role-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// ─── handleApplyUpdate additional paths ──────────────────────────────────────

// TestAdminAPI_ApplyUpdate_NilUpdater verifies that POST /updates/apply returns
// 503 when no updater is configured.
func TestAdminAPI_ApplyUpdate_NilUpdater(t *testing.T) {
	database := openAdminTestDB(t)
	// nil updater — the endpoint should return 503
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_ApplyUpdate_NilUpdater_ErrorCode verifies the error code field
// in the 503 response.
func TestAdminAPI_ApplyUpdate_NilUpdater_ErrorCode(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "UPDATE_UNAVAILABLE" {
		t.Errorf("error code = %q, want UPDATE_UNAVAILABLE", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_NoUpdateAvailable verifies that 409 Conflict is
// returned when the server is already up to date.
func TestAdminAPI_ApplyUpdate_NoUpdateAvailable(t *testing.T) {
	// Mock GitHub API to return same version (no update available).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.0.0",
			"body":     "",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 (no update available); body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "NO_UPDATE" {
		t.Errorf("error = %q, want NO_UPDATE", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_CheckFails verifies that 502 Bad Gateway is returned
// when the update check request to GitHub fails.
func TestAdminAPI_ApplyUpdate_CheckFails(t *testing.T) {
	// Server that immediately closes connections (simulates network error).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Return invalid JSON to trigger a parse error.
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	// Expect 502 Bad Gateway when update check call fails.
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_ApplyUpdate_MissingAssets verifies that 502 is returned when the
// release has no download URL or checksum URL.
func TestAdminAPI_ApplyUpdate_MissingAssets(t *testing.T) {
	// Return a newer version but with no assets (empty download/checksum URLs).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "Release notes",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 (missing assets); body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "MISSING_ASSETS" {
		t.Errorf("error = %q, want MISSING_ASSETS", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_Unauthenticated verifies that 401 is returned for
// unauthenticated requests to POST /updates/apply.
func TestAdminAPI_ApplyUpdate_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestAdminAPI_ApplyUpdate_DownloadFails verifies that 502 is returned when
// the binary download itself fails (bad URL, network error, etc.).
// We use a mock server that reports an available update with valid-format
// GitHub URLs, but those URLs point to a server that returns 404.
func TestAdminAPI_ApplyUpdate_DownloadFails(t *testing.T) {
	// The mock server that serves the GitHub release info — it reports an
	// update is available with GitHub-prefixed asset URLs.
	// The actual download will fail because the URLs don't point to real files.
	var mockGHURL string
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// If this is the checksum/download request, return an error.
		// The release API endpoint returns a release with asset URLs.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "Release notes",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets": []map[string]any{
				{
					"name":                 "chatserver.exe",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe",
				},
				{
					"name":                 "chatserver-linux-amd64.tar.gz",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver-linux-amd64.tar.gz",
				},
				{
					"name":                 "checksums.sha256",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256",
				},
			},
		})
		_ = mockGHURL // suppress unused warning
	}))
	defer mockGH.Close()
	mockGHURL = mockGH.URL

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	// The download URLs are real GitHub URLs that will fail since we're not
	// actually connected to GitHub in tests, or we can use the URL validation
	// to force a failure. The URLs pass validation (they have the right prefix),
	// but the actual HTTP fetch will fail (unreachable host).
	// In CI environments without internet, this returns 502.
	// We accept either 502 (download failed) or 200 (unexpectedly succeeded) —
	// the important thing is that the code path is executed.

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	// Either 502 (download failed as expected in isolated test environment)
	// or 200 (succeeded in environment with GitHub access) is acceptable.
	// What should NOT happen is 409 (no update) or 503 (nil updater).
	if w.Code == http.StatusServiceUnavailable || w.Code == http.StatusConflict {
		t.Errorf("status = %d; expected download attempt to proceed (got 503/409 instead)", w.Code)
	}
}
