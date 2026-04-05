package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/updater"
)

// fakeGitHubRelease returns a test HTTP server that mimics the GitHub
// Releases API, serving a release with the given tag and NSIS assets.
// Asset download URLs point back to the test server so FetchTextAsset works.
func fakeGitHubRelease(t *testing.T, tag string) *httptest.Server {
	t.Helper()

	var srv *httptest.Server
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/test/repo/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"tag_name": tag,
			"body":     "Release notes here",
			"html_url": "https://github.com/test/repo/releases/" + tag,
			"assets": []map[string]any{
				{
					"name":                 "OwnCord_1.0.0_x64-setup.nsis.zip",
					"browser_download_url": srv.URL + "/download/OwnCord_1.0.0_x64-setup.nsis.zip",
				},
				{
					"name":                 "OwnCord_1.0.0_x64-setup.nsis.zip.sig",
					"browser_download_url": srv.URL + "/download/OwnCord_1.0.0_x64-setup.nsis.zip.sig",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})

	// Serve the signature file content.
	mux.HandleFunc("/download/OwnCord_1.0.0_x64-setup.nsis.zip.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("dW50cnVzdGVkIGNvbW1lbnQ="))
	})

	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
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

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64/1.0.0", nil)
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

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64/1.0.0", nil)
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
	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64/2.0.0", nil)
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

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64/1.0.0", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body: %s", rr.Code, rr.Body.String())
	}
}
