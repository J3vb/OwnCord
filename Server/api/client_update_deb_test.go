package api_test

// client_update_deb_test.go — the .deb targets of the client-update endpoint
// (WP LP-14a). A .deb client is offered the signed package only when it sends
// ?deb_install=pkexec; every other client keeps getting 204. An opted-in
// client that is already current is answered 200 with the latest version so it
// can tell "current" from "this server cannot serve me".

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/updater"
)

// fakeReleaseWithAssets serves a release whose assets are exactly assetNames.
// When manifest is non-nil the release also carries a server-update manifest
// with the given (possibly invalid) signature.
func fakeReleaseWithAssets(t *testing.T, tag string, assetNames []string, manifest, manifestSig []byte) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	names := append([]string(nil), assetNames...)
	if manifest != nil {
		names = append(names, "server-update-manifest.json", "server-update-manifest.json.sig")
	}
	mux.HandleFunc("/repos/test/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		assets := make([]map[string]any, 0, len(names))
		for _, name := range names {
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
			_, _ = w.Write(manifestSig)
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

func getClientUpdate(t *testing.T, srvURL, path string) *httptest.ResponseRecorder {
	t.Helper()
	u := updater.NewUpdater("1.0.0", "", "test", "repo")
	u.SetBaseURL(srvURL)
	rr := httptest.NewRecorder()
	buildClientUpdateRouter(u).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	return rr
}

var preLP14aAssets = []string{
	"OwnCord_1.0.0_amd64.AppImage.tar.gz",
	"OwnCord_1.0.0_amd64.AppImage.tar.gz.sig",
	"OwnCord_1.0.0_x64-setup.nsis.zip",
	"OwnCord_1.0.0_x64-setup.nsis.zip.sig",
}

func TestClientUpdate_DebTargetWithoutOptInNoContentEvenWhenDebPublished(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	for _, path := range []string{
		"/api/v1/client-update/linux-aarch64-deb/1.0.0",
		"/api/v1/client-update/linux-aarch64-deb/1.0.0?deb_install=",
		"/api/v1/client-update/linux-aarch64-deb/1.0.0?deb_install=sudo",
	} {
		rr := getClientUpdate(t, srv.URL, path)
		if rr.Code != http.StatusNoContent {
			t.Errorf("%s: status = %d, want 204; body: %s", path, rr.Code, rr.Body.String())
		}
	}
}

func TestClientUpdate_DebOptInGetsDeb(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/1.0.0?deb_install=pkexec")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	entry := platformEntry(t, rr, "linux-x86_64-deb")
	if got, _ := entry["url"].(string); !strings.HasSuffix(got, "_amd64.deb") {
		t.Errorf("url = %q, want the amd64 .deb", got)
	}
	if got, _ := entry["signature"].(string); got != "dW50cnVzdGVkIGNvbW1lbnQ=" {
		t.Errorf("signature = %q, want the .deb.sig text", got)
	}
}

func TestClientUpdate_DebOptInArm64GetsArm64Deb(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-aarch64-deb/1.0.0?deb_install=pkexec")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	entry := platformEntry(t, rr, "linux-aarch64-deb")
	if got, _ := entry["url"].(string); !strings.HasSuffix(got, "_arm64.deb") {
		t.Errorf("url = %q, want the arm64 .deb", got)
	}
}

func TestClientUpdate_DebOptInCurrentGets200WithLatest(t *testing.T) {
	srv := fakeGitHubRelease(t, "v1.0.0")
	rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/1.0.0?deb_install=pkexec")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["version"] != "1.0.0" {
		t.Errorf("version = %v, want 1.0.0", resp["version"])
	}
	platforms, _ := resp["platforms"].(map[string]any)
	if _, ok := platforms["linux-x86_64-deb"]; !ok {
		t.Errorf("platforms missing linux-x86_64-deb: %v", platforms)
	}
}

func TestClientUpdate_DebOptInNewerThanLatestGets200(t *testing.T) {
	srv := fakeGitHubRelease(t, "v1.0.0")
	rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/3.0.0?deb_install=pkexec")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_DebOptInUnverifiableManifestNoContent(t *testing.T) {
	// A manifest whose signature does not verify is withheld; the withhold
	// still wins over the opted-in 200-when-current rule, current or not.
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"00","protocol_epoch":99}`)
	names := append([]string{"OwnCord_1.0.0_amd64.deb", "OwnCord_1.0.0_amd64.deb.sig"}, preLP14aAssets...)
	srv := fakeReleaseWithAssets(t, "v1.0.0", names, manifest, []byte("not a signature"))
	for _, ver := range []string{"1.0.0", "0.9.0"} {
		rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/"+ver+"?deb_install=pkexec")
		if rr.Code != http.StatusNoContent {
			t.Errorf("version %s: status = %d, want 204; body: %s", ver, rr.Code, rr.Body.String())
		}
	}
}

func TestClientUpdate_DebOptInNoDebAssetNoContent(t *testing.T) {
	// A release published before the .deb was signed has no deb assets.
	srv := fakeReleaseWithAssets(t, "v1.0.0", preLP14aAssets, nil, nil)
	for _, ver := range []string{"1.0.0", "0.9.0"} {
		rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/"+ver+"?deb_install=pkexec")
		if rr.Code != http.StatusNoContent {
			t.Errorf("version %s: status = %d, want 204; body: %s", ver, rr.Code, rr.Body.String())
		}
	}
}

func TestClientUpdate_DebOptInSignatureMissingNoContent(t *testing.T) {
	names := append([]string{"OwnCord_1.0.0_amd64.deb"}, preLP14aAssets...)
	srv := fakeReleaseWithAssets(t, "v1.0.0", names, nil, nil)
	rr := getClientUpdate(t, srv.URL, "/api/v1/client-update/linux-x86_64-deb/1.0.0?deb_install=pkexec")
	if rr.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", rr.Code, rr.Body.String())
	}
}

func TestClientUpdate_OptInIgnoredForNonDebTargets(t *testing.T) {
	srv := fakeGitHubRelease(t, "v1.0.0")
	for _, target := range []string{"linux-x86_64-appimage", "windows-x86_64-nsis", "linux-x86_64-rpm"} {
		plain := getClientUpdate(t, srv.URL, "/api/v1/client-update/"+target+"/1.0.0")
		opted := getClientUpdate(t, srv.URL, "/api/v1/client-update/"+target+"/1.0.0?deb_install=pkexec")
		if plain.Code != http.StatusNoContent || opted.Code != http.StatusNoContent {
			t.Errorf("%s current: plain=%d opted=%d, want both 204", target, plain.Code, opted.Code)
		}
	}
	// Outdated: both behave the same and the opt-in adds nothing.
	srv2 := fakeGitHubRelease(t, "v2.0.0")
	plain := getClientUpdate(t, srv2.URL, "/api/v1/client-update/linux-x86_64-appimage/1.0.0")
	opted := getClientUpdate(t, srv2.URL, "/api/v1/client-update/linux-x86_64-appimage/1.0.0?deb_install=pkexec")
	if plain.Code != http.StatusOK || opted.Code != http.StatusOK || plain.Body.String() != opted.Body.String() {
		t.Errorf("appimage outdated: plain=%d opted=%d bodies equal=%v", plain.Code, opted.Code, plain.Body.String() == opted.Body.String())
	}
}

// TestDebOptIn pins the opt-in predicate. It is exercised through the router
// (debOptIn is unexported); each row is a deb target request that must or must
// not be offered the package for a client one version behind.
func TestDebOptIn(t *testing.T) {
	srv := fakeGitHubRelease(t, "v2.0.0")
	cases := []struct {
		name   string
		target string
		query  url.Values
		want   int
	}{
		{"exact value", "linux-x86_64-deb", url.Values{"deb_install": {"pkexec"}}, http.StatusOK},
		{"wrong value", "linux-x86_64-deb", url.Values{"deb_install": {"sudo"}}, http.StatusNoContent},
		{"empty value", "linux-x86_64-deb", url.Values{"deb_install": {""}}, http.StatusNoContent},
		{"uppercase value", "linux-x86_64-deb", url.Values{"deb_install": {"PKEXEC"}}, http.StatusNoContent},
		{"no query", "linux-x86_64-deb", nil, http.StatusNoContent},
		{"rpm target", "linux-x86_64-rpm", url.Values{"deb_install": {"pkexec"}}, http.StatusNoContent},
		{"uppercase target", "linux-x86_64-DEB", url.Values{"deb_install": {"pkexec"}}, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := "/api/v1/client-update/" + tc.target + "/1.0.0"
			if len(tc.query) > 0 {
				path += "?" + tc.query.Encode()
			}
			rr := getClientUpdate(t, srv.URL, path)
			if rr.Code != tc.want {
				t.Errorf("status = %d, want %d; body: %s", rr.Code, tc.want, rr.Body.String())
			}
		})
	}
}
