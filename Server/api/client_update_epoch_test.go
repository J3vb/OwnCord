package api_test

// client_update_epoch_test.go — the client-update endpoint never advertises a
// release whose signed manifest declares a protocol epoch newer than this
// server's (B2-2): a client that auto-updated onto it would be refused at the
// next handshake. A manifest that does not verify is treated the same way —
// fail closed, 204 — since its epoch cannot be trusted. A release with no
// manifest at all predates the epoch and is advertised as before
// (client_update_test.go covers that path throughout).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/updater"
)

// fakeGitHubReleaseWithManifest is fakeGitHubRelease plus a server-update
// manifest and signature, served with the given bytes.
func fakeGitHubReleaseWithManifest(t *testing.T, tag string, manifest, sig []byte) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	assetNames := []string{
		"OwnCord_1.0.0_x64-setup.nsis.zip",
		"OwnCord_1.0.0_x64-setup.nsis.zip.sig",
		"server-update-manifest.json",
		"server-update-manifest.json.sig",
	}
	mux.HandleFunc("/repos/test/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		assets := make([]map[string]any, 0, len(assetNames))
		for _, name := range assetNames {
			assets = append(assets, map[string]any{"name": name, "browser_download_url": srv.URL + "/download/" + name})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "body": "notes", "html_url": "x", "assets": assets})
	})
	mux.HandleFunc("/download/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "server-update-manifest.json"):
			_, _ = w.Write(manifest)
		case strings.HasSuffix(r.URL.Path, "server-update-manifest.json.sig"):
			_, _ = w.Write(sig)
		case strings.HasSuffix(r.URL.Path, ".sig"):
			_, _ = w.Write([]byte("dW50cnVzdGVkIGNvbW1lbnQ="))
		default:
			http.NotFound(w, r)
		}
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestClientUpdate_UnverifiableManifestIsNotAdvertised(t *testing.T) {
	// The manifest claims epoch 1 (compatible) but its signature is garbage:
	// the claim is untrusted, so the release is withheld.
	manifest := []byte(`{"version":"v2.0.0","asset":"chatserver.exe","sha256":"00","protocol_epoch":1}`)
	srv := fakeGitHubReleaseWithManifest(t, "v2.0.0", manifest, []byte("not a signature"))
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srv.URL)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/client-update/windows-x86_64-nsis/1.0.0", nil)
	rr := httptest.NewRecorder()
	buildClientUpdateRouter(u).ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (unverifiable manifest must not be advertised); body: %s", rr.Code, rr.Body.String())
	}
}
