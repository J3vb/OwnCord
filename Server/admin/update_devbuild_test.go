package admin_test

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/updater"
)

// devBuildAPI serves the update routes for a server built from source.
func devBuildAPI(t *testing.T, hits *atomic.Int32) (http.Handler, string) {
	t.Helper()
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return nil }))
	u := updater.NewUpdater("dev", "", "J3vb", "OwnCord")
	u.SetBaseURL(releaseServer(t, hits).URL)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "dev", nil, u, nil, nil, nil, newTestServices(database))
	return handler, createAdminUser(t, database)
}

// A development build still reports the latest release, but says it cannot
// apply it, so the panel shows no "Update now".
func TestCheckUpdate_DevelopmentBuildCannotApply(t *testing.T) {
	var hits atomic.Int32
	handler, token := devBuildAPI(t, &hits)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["latest"] != "v2.0.0" {
		t.Errorf("latest = %v, want v2.0.0", body["latest"])
	}
	if body["can_apply"] != false || body["apply_blocked"] != "development_build" {
		t.Errorf("can_apply = %v, apply_blocked = %v, want false and development_build", body["can_apply"], body["apply_blocked"])
	}
}

// The server refuses the apply itself, before any release download.
func TestApplyUpdate_DevelopmentBuildRefused(t *testing.T) {
	var hits atomic.Int32
	handler, token := devBuildAPI(t, &hits)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "DEVELOPMENT_BUILD" {
		t.Errorf("error = %q, want DEVELOPMENT_BUILD", resp["error"])
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("release server was called %d times, want 0", n)
	}
}
