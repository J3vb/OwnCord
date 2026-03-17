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
				{"name": "checksums.sha256", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256"},
			},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u)
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u)
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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	w := doRequest(t, handler, http.MethodGet, "/updates", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_ApplyUpdate_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil)

	// Create admin user (not owner - role 2)
	adminUID, _ := database.CreateUser("adminonly2", "hash", 2)
	token := "admin-role-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}
