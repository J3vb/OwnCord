package admin_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/updater"
)

// TestAdminAPI_ApplyUpdate_RefusesSignedDowngrade proves that an older release
// carrying the complete asset set is refused with NO_UPDATE (not MISSING_ASSETS)
// and that no asset is fetched.
func TestAdminAPI_ApplyUpdate_RefusesSignedDowngrade(t *testing.T) {
	var apiHits, assetHits atomic.Int32
	var mockURL string
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/repos/") {
			assetHits.Add(1)
			http.NotFound(w, r)
			return
		}
		apiHits.Add(1)
		base := mockURL + "/download"
		names := []string{
			"chatserver.exe", "chatserver-linux-amd64.tar.gz", "checksums.sha256",
			"chatserver.exe.sig", "server-update-manifest.json", "server-update-manifest.json.sig",
		}
		assets := make([]map[string]any, 0, len(names))
		for _, n := range names {
			assets = append(assets, map[string]any{"name": n, "browser_download_url": base + "/" + n})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v0.9.0",
			"body":     "older release",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v0.9.0",
			"assets":   assets,
		})
	}))
	defer mockGH.Close()
	mockURL = mockGH.URL

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "NO_UPDATE" {
		t.Errorf("error = %q, want NO_UPDATE", resp["error"])
	}
	if apiHits.Load() == 0 {
		t.Error("release API was never queried; the test did not exercise the check")
	}
	if n := assetHits.Load(); n != 0 {
		t.Errorf("%d asset request(s) reached the mock server, want 0", n)
	}
}
