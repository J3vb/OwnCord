package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

// fakeGitHubRelease returns a test HTTP server that mimics the GitHub
// Releases API, serving a release with the given tag and the client update
// assets for every platform the release workflow publishes.
// Asset download URLs point back to the test server so FetchTextAsset works.
func fakeGitHubRelease(t *testing.T, tag string) *httptest.Server {
	t.Helper()

	var srv *httptest.Server
	mux := http.NewServeMux()

	assetNames := []string{
		"OwnCord_1.0.0_x64-setup.nsis.zip",
		"OwnCord_1.0.0_x64-setup.nsis.zip.sig",
		"OwnCord_1.0.0_amd64.AppImage.tar.gz",
		"OwnCord_1.0.0_amd64.AppImage.tar.gz.sig",
		"OwnCord_1.0.0_aarch64.AppImage.tar.gz",
		"OwnCord_1.0.0_aarch64.AppImage.tar.gz.sig",
	}

	mux.HandleFunc("/repos/test/repo/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		assets := make([]map[string]any, 0, len(assetNames))
		for _, name := range assetNames {
			assets = append(assets, map[string]any{
				"name":                 name,
				"browser_download_url": srv.URL + "/download/" + name,
			})
		}
		resp := map[string]any{
			"tag_name": tag,
			"body":     "Release notes here",
			"html_url": "https://github.com/test/repo/releases/" + tag,
			"assets":   assets,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})

	// Serve signature file content for any .sig asset.
	mux.HandleFunc("/download/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sig") {
			_, _ = w.Write([]byte("dW50cnVzdGVkIGNvbW1lbnQ="))
			return
		}
		http.NotFound(w, r)
	})

	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// platformEntry decodes the response body and returns the platforms entry for
// the given target, failing the test if it is missing.
func platformEntry(t *testing.T, rr *httptest.ResponseRecorder, target string) map[string]any {
	t.Helper()
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	platforms, ok := resp["platforms"].(map[string]any)
	if !ok {
		t.Fatalf("response missing platforms map: %v", resp)
	}
	entry, ok := platforms[target].(map[string]any)
	if !ok {
		t.Fatalf("platforms missing key %q: %v", target, platforms)
	}
	return entry
}

func buildClientUpdateRouter(u *updater.Updater) http.Handler {
	r := chi.NewRouter()
	api.MountClientUpdateRoute(r, u)
	return r
}

func TestClientUpdate_NewVersionAvailable(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if resp["version"] == nil {
		t.Error("response missing 'version' field")
	}
	if resp["platforms"] == nil {
		t.Error("response missing 'platforms' field")
	}
}

func TestClientUpdate_AlreadyLatest(t *testing.T) {
	srv := fakeGitHubRelease(t, "v1.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_FutureVersion(t *testing.T) {
	srv := fakeGitHubRelease(t, "v1.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	// Client has a newer version than the release.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/2.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_WindowsTargetGetsNSISInstaller(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	entry := platformEntry(t, rr, "windows-x86_64-nsis")
	url, _ := entry["url"].(string)
	if !strings.HasSuffix(url, "_x64-setup.nsis.zip") {
		t.Errorf("windows url = %q, want NSIS installer", url)
	}
}

func TestClientUpdate_LinuxTargetGetsAppImage(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/linux-x86_64-appimage/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	entry := platformEntry(t, rr, "linux-x86_64-appimage")
	url, _ := entry["url"].(string)
	if !strings.HasSuffix(url, "_amd64.AppImage.tar.gz") {
		t.Errorf("linux url = %q, want x86_64 AppImage updater archive", url)
	}
	if sig, _ := entry["signature"].(string); sig == "" {
		t.Error("linux platform entry missing signature")
	}
}

func TestClientUpdate_LinuxArm64TargetGetsAarch64AppImage(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/linux-aarch64-appimage/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	entry := platformEntry(t, rr, "linux-aarch64-appimage")
	url, _ := entry["url"].(string)
	if !strings.HasSuffix(url, "_aarch64.AppImage.tar.gz") {
		t.Errorf("linux arm64 url = %q, want aarch64 AppImage updater archive", url)
	}
}

func TestClientUpdate_UnsupportedTargetNoContent(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	// No darwin client is published; the updater must not be offered a
	// Windows installer for it.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/darwin-aarch64-app/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_DebTargetNoContent(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	// The release ships .deb packages but no signed deb UPDATER artifact.
	// A deb client falling back to the AppImage archive would fail install
	// forever (the plugin's install_deb rejects gzip bytes), so it must get
	// 204 rather than an artifact for a different installer.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/linux-x86_64-deb/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_GitHubError(t *testing.T) {
	// Server that always returns 500.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body: %s", rr.Code, rr.Body.String())
	}
}

// TestClientUpdate_Epoch1ResponseShape pins the exact JSON shape of the
// client-update 200 and 204 responses as of protocol epoch 1. B2-3 adds a
// protocol-epoch field to this response; when it does, this test WILL fail
// until it is extended on purpose to include the new field in the expected
// shape below.
//
// fakeGitHubRelease always publishes non-empty release notes and has no
// parameter for an empty body, so this covers the non-empty-notes case
// (top-level keys exactly {version, notes, platforms}) plus an explicit
// assertion that "pub_date" — omitempty, and never set by the handler —
// stays absent.
func TestClientUpdate_Epoch1ResponseShape(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	router := buildClientUpdateRouter(u)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json; charset=utf-8")
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	want := map[string]any{
		"version": "2.0.0",
		"notes":   "Release notes here",
		"platforms": map[string]any{
			"windows-x86_64-nsis": map[string]any{
				"signature": "dW50cnVzdGVkIGNvbW1lbnQ=",
				"url":       srv.URL + "/download/OwnCord_1.0.0_x64-setup.nsis.zip",
			},
		},
	}
	if !reflect.DeepEqual(resp, want) {
		t.Errorf("200 response = %#v, want %#v — a new field (e.g. protocol epoch) must be added here deliberately", resp, want)
	}
	if _, ok := resp["pub_date"]; ok {
		t.Errorf("response has a \"pub_date\" key = %v, want absent", resp["pub_date"])
	}

	// 204 (already latest) has an empty body, not "{}" or any other JSON.
	srv204 := fakeGitHubRelease(t, "v1.0.0")
	u204 := updater.NewUpdater("1.0.0", "", "test", "repo")
	u204.SetBaseURL(srv204.URL)
	router204 := buildClientUpdateRouter(u204)

	req204 := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr204 := httptest.NewRecorder()
	router204.ServeHTTP(rr204, req204)

	if rr204.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", rr204.Code, rr204.Body.String())
	}
	if rr204.Body.Len() != 0 {
		t.Errorf("204 body length = %d, want 0 (body: %q)", rr204.Body.Len(), rr204.Body.String())
	}
}
