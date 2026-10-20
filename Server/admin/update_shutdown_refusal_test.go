package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/updater"
)

// applyRefusalFixture serves a complete v2.0.0 release and returns the admin
// handler wired with opts, so POST /updates/apply reaches the point where the
// download would start.
func applyRefusalFixture(t *testing.T, opts admin.SetupOptions) (http.Handler, string) {
	t.Helper()
	t.Setenv("OWNCORD_CONTAINER", "0")
	names := []string{"chatserver.exe", "chatserver-linux-amd64.tar.gz", "checksums.sha256", "chatserver.exe.sig", "server-update-manifest.json", "server-update-manifest.json.sig"}
	assets := make([]map[string]any, 0, len(names))
	for _, n := range names {
		assets = append(assets, map[string]any{"name": n, "browser_download_url": "http://127.0.0.1:1/" + n})
	}
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0", "html_url": "https://example.invalid/r", "assets": assets,
		})
	}))
	t.Cleanup(mockGH.Close)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	database := openAdminTestDB(t)
	h := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database), opts)
	return h, createAdminUser(t, database)
}

func assertShuttingDown(t *testing.T, h http.Handler, token string) {
	t.Helper()
	admin.ResetRestartState()
	t.Cleanup(admin.ResetRestartState)
	w := doRequest(t, h, http.MethodPost, "/updates/apply", token, nil)
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if w.Code != http.StatusServiceUnavailable || resp["error"] != "SHUTTING_DOWN" {
		t.Fatalf("status = %d, body = %s; want 503 SHUTTING_DOWN, refused before any download", w.Code, w.Body.String())
	}
	if got := admin.CurrentRestartState(); got != "idle" {
		t.Errorf("restart state = %q, want idle: the refused request must release the slot", got)
	}
}

// The process-wide shutdown signal reaches the handler through SetupOptions
// (the router passes Runtime.Shutdown there): a closed channel refuses the
// apply before the download, and a dropped hand-off would let it through.
func TestApplyUpdate_ShutdownSignalRefusesRequest(t *testing.T) {
	shutdown := make(chan struct{})
	close(shutdown)
	h, token := applyRefusalFixture(t, admin.SetupOptions{Shutdown: shutdown})
	assertShuttingDown(t, h, token)
}

// A stopped background group refuses it too (SetupOptions.Background).
func TestApplyUpdate_StoppedGroupRefusesRequest(t *testing.T) {
	bg := syncutil.NewGroup(context.Background())
	bg.Stop(context.Background(), time.Millisecond)
	h, token := applyRefusalFixture(t, admin.SetupOptions{Background: bg})
	assertShuttingDown(t, h, token)
}
